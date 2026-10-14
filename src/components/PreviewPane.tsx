import PreviewCrop from "./PreviewCrop";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ProbeData } from "../ipc";
import {
  canPreserveDirectVideoSource,
  getCompletedPlaybackTime,
  getStoppedPlaybackTime,
} from "../previewScrub";
import { capturePreviewFramePng } from "../previewFrame";

const FIXED_PREVIEW_CSS_WIDTH = 432;
const PREVIEW_ASPECT_WIDTH = 16;
const PREVIEW_ASPECT_HEIGHT = 9;
const MEDIA_SEEK_EPSILON_SECONDS = 1 / 240;

// Module-scope static style objects. Hoisted so React doesn't allocate a
// fresh object literal per render — PreviewPane re-renders on every
// trim-slider move during scrubbing, so this is a measurable win.
const containerStyle: React.CSSProperties = {
  background: "var(--surface)",
  boxSizing: "border-box",
  borderRadius: "var(--radius)",
  overflow: "hidden",
  contain: "paint",
  position: "relative",
  // The pane itself is the exact 16:9 frame. Keeping the media edge flush
  // removes the light border/gutter that otherwise shows beside 16:9 frames.
  width: "100%",
  maxWidth: `${FIXED_PREVIEW_CSS_WIDTH}px`,
  height: "auto",
  aspectRatio: `${PREVIEW_ASPECT_WIDTH} / ${PREVIEW_ASPECT_HEIGHT}`,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "var(--shadow-card), var(--card-top)",
};

const videoBaseStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
};
const videoVisibleStyle: React.CSSProperties = { ...videoBaseStyle, display: "block" };
const videoHiddenStyle: React.CSSProperties = { ...videoBaseStyle, display: "none" };
const overlayGroupStyle: React.CSSProperties = {
  position: "absolute",
  display: "flex",
  gap: "12px",
  alignItems: "center",
  justifyContent: "center",
};

const glassOverlayStyle: React.CSSProperties = {
  background: "rgba(0, 0, 0, 0.38)",
  backdropFilter: "blur(8px) saturate(160%)",
  WebkitBackdropFilter: "blur(8px) saturate(160%)",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  boxShadow: "0 2px 6px rgba(0,0,0,0.24)",
  color: "rgba(255,255,255,0.92)",
};

const overlayBtnStyle: React.CSSProperties = {
  ...glassOverlayStyle,
  willChange: "backdrop-filter",
  borderRadius: "50%",
  width: "44px",
  height: "44px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const currentTimeOverlayStyle: React.CSSProperties = {
  ...glassOverlayStyle,
  position: "absolute",
  bottom: "6px",
  right: "8px",
  fontSize: "11px",
  borderRadius: "var(--radius-xs)",
  padding: "2px 6px",
  pointerEvents: "none",
};

const snapshotBtnStyle: React.CSSProperties = {
  ...glassOverlayStyle,
  position: "absolute",
  top: "8px",
  right: "8px",
  borderRadius: "50%",
  padding: 0,
  width: "28px",
  height: "28px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  cursor: "pointer",
  zIndex: 10,
};

type Props = {
  cropAspectRatio: string;
  filePath: string | null;
  loadingVideo: boolean;
  startTime: number;
  endTime: number;
  previewTime: number | null;
  isScrubbing: boolean;
  removeAudio: boolean;
  loopPlayback: boolean;
  probeData: ProbeData | null;
  // Fired whenever the playback position changes (timeupdate / seek / stop).
  // Replaces the App-level 80 ms polling loop — the media element already
  // emits timeupdate at ~4 Hz, so we just forward that instead of waking the
  // main thread on a wall-clock interval even while the video is paused.
  onTimeUpdate?: (timeSec: number | null) => void;
  onSnapshot?: (pngBytes: Uint8Array) => void | Promise<void>;
  onSnapshotError?: (message: string) => void;
  // Called when HTML video playback fails so the app can surface the error.
  onPlaybackError?: (message: string) => void;
};

export type PreviewHandle = {
  startPlayback: () => void;
  stopPlayback: () => void;
  isPlaying: () => boolean;
  getCurrentTime: () => number;
  seekTo: (timeSec: number) => void;
  stepBy: (deltaSec: number) => void;
  captureCurrentFrame: () => Promise<Uint8Array>;
};

const PreviewPane = forwardRef<PreviewHandle, Props>(function PreviewPane(
  {
    cropAspectRatio,
    filePath,
    loadingVideo,
    startTime,
    endTime,
    previewTime,
    isScrubbing,
    removeAudio,
    loopPlayback,
    probeData,
    onTimeUpdate,
    onSnapshot,
    onSnapshotError,
    onPlaybackError,
  },
  ref
) {
  // Stash the latest onTimeUpdate in a ref so the playback callbacks don't
  // need it in their dep arrays — otherwise every parent render recreating
  // the handler would invalidate startPlayback and re-bind listeners.
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
  }, [onTimeUpdate]);
  // Same pattern for the playback-error callback used inside startPlayback.
  const onPlaybackErrorRef = useRef(onPlaybackError);
  useEffect(() => {
    onPlaybackErrorRef.current = onPlaybackError;
  }, [onPlaybackError]);
  const [videoLoadFailed, setVideoLoadFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  useEffect(() => {
    setVideoLoadFailed(false);
    setVideoReady(false);
    currentPlaybackTimeRef.current = 0;
    setCurrentPlaybackTime(0);
    onTimeUpdateRef.current?.(filePath ? 0 : null);
  }, [filePath]);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = removeAudio;
    }
  }, [removeAudio]);
  const [playing, setPlaying] = useState(false);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const playingRef = useRef(false);

  const currentPlaybackTimeRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubVideoSrcRef = useRef<string | null>(null);
  const pendingScrubVideoSeekRef = useRef<number | null>(null);
  const sourceIndexRef = useRef(0);
  // Listener reference so we can unbind on stop. Replaces the previous 100 ms
  // setInterval polling of `currentTime`, which kept the main thread warm
  // during every playback.
  const timeUpdateHandlerRef = useRef<(() => void) | null>(null);
  const endBoundaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePlaybackBoundaryRef = useRef<(() => void) | null>(null);
  const playbackSessionRef = useRef(0);
  const urlCacheRef = useRef<Map<string, string[]>>(new Map());

  const getPlaybackTime = useCallback(() => {
    const video = videoRef.current;
    const raw = video && video.readyState >= 1 ? video.currentTime : currentPlaybackTimeRef.current;
    const min = Math.min(startTime, endTime);
    const max = Math.max(startTime, endTime);
    if (raw < min) return min;
    if (raw > max) return max;
    return raw;
  }, [startTime, endTime]);

  const seekVideoElement = useCallback((mediaTime: number) => {
    if (!Number.isFinite(mediaTime)) return;
    const vid = videoRef.current;
    if (!vid) return;
    const targetTime = Math.max(0, mediaTime);

    const applySeek = () => {
      if (Math.abs(vid.currentTime - targetTime) < MEDIA_SEEK_EPSILON_SECONDS) return;
      try {
        vid.currentTime = targetTime;
      } catch {
        // Some WebViews reject currentTime before metadata is ready. Keep the
        // newest target and replay it from loadedmetadata/canplay.
        pendingScrubVideoSeekRef.current = targetTime;
      }
    };

    if (vid.readyState >= 1) {
      applySeek();
      return;
    }

    pendingScrubVideoSeekRef.current = targetTime;
  }, []);

  const seekTo = useCallback(
    (timeSec: number) => {
      const dur = probeData?.duration ?? 0;
      // Clamp to the full clip, not the trim range — the trim handles define the
      // export region only. Scrubbing outside the trim region is intentional
      // (Premiere Pro model): the playhead roams freely; playback enforces bounds.
      const clamped = dur > 0 ? Math.max(0, Math.min(timeSec, dur)) : Math.max(0, timeSec);
      const vid = videoRef.current;

      currentPlaybackTimeRef.current = clamped;
      setCurrentPlaybackTime(clamped);
      onTimeUpdateRef.current?.(clamped);
      if (!vid) return;
      seekVideoElement(clamped);
    },
    [probeData, seekVideoElement]
  );

  const stepBy = useCallback(
    (deltaSec: number) => {
      seekTo(getPlaybackTime() + deltaSec);
    },
    [seekTo, getPlaybackTime]
  );

  const buildPlaybackUrls = useCallback((path: string): string[] => {
    // Check cache first
    if (urlCacheRef.current.has(path)) {
      return urlCacheRef.current.get(path)!;
    }

    const normalizedPath = path.replace(/\\/g, "/");
    const urls: Set<string> = new Set([convertFileSrc(path)]);

    if (normalizedPath !== path) {
      urls.add(convertFileSrc(normalizedPath));
    }

    try {
      if (/^[a-zA-Z]:\//.test(normalizedPath)) {
        urls.add(new URL(`file:///${normalizedPath}`).toString());
      } else if (normalizedPath.startsWith("/")) {
        urls.add(new URL(`file://${normalizedPath}`).toString());
      }
    } catch {
      // ignore malformed fallback URLs and continue with asset protocol URLs
    }

    const result = Array.from(urls);
    urlCacheRef.current.set(path, result);

    // Keep cache size reasonable (max 10 paths)
    if (urlCacheRef.current.size > 10) {
      const firstKey = urlCacheRef.current.keys().next().value;
      if (firstKey !== undefined) {
        urlCacheRef.current.delete(firstKey);
      }
    }

    return result;
  }, []);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (!filePath || !probeData) {
      setVideoReady(false);
      if (!playingRef.current) {
        scrubVideoSrcRef.current = null;
        pendingScrubVideoSeekRef.current = null;
        vid.pause();
        vid.removeAttribute("src");
        vid.load();
      }
      return;
    }
    if (videoLoadFailed) return;

    if (playingRef.current) return;
    const sources = buildPlaybackUrls(filePath);
    const activeSource = vid.currentSrc || vid.src;
    const activeIndex = sources.indexOf(activeSource);
    if (activeIndex >= 0) {
      sourceIndexRef.current = activeIndex;
      scrubVideoSrcRef.current = activeSource;
      return;
    }
    const src = sources[0];
    if (!src) return;

    sourceIndexRef.current = 0;
    scrubVideoSrcRef.current = src;
    pendingScrubVideoSeekRef.current = null;
    setVideoReady(false);
    setVideoLoadFailed(false);
    vid.preload = "auto";
    vid.src = src;
    vid.load();
  }, [buildPlaybackUrls, filePath, probeData, playing, videoLoadFailed]);

  const handleVideoReady = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (
        scrubVideoSrcRef.current !== null &&
        event.currentTarget.src !== scrubVideoSrcRef.current
      ) {
        return;
      }
      setVideoReady(true);
      setVideoLoadFailed(false);
      const pending = pendingScrubVideoSeekRef.current;
      if (pending === null) return;
      pendingScrubVideoSeekRef.current = null;
      seekVideoElement(pending);
    },
    [seekVideoElement]
  );

  useEffect(() => {
    if (previewTime === null || playing) return;
    const dur = probeData?.duration ?? 0;
    const clamped = dur > 0 ? Math.max(0, Math.min(previewTime, dur)) : Math.max(0, previewTime);
    seekVideoElement(clamped);
  }, [isScrubbing, playing, previewTime, probeData, seekVideoElement]);

  // ---------------------------------------------------------------------------
  // Video playback
  // ---------------------------------------------------------------------------
  const clearEndBoundaryTimer = useCallback(() => {
    if (endBoundaryTimerRef.current !== null) {
      clearTimeout(endBoundaryTimerRef.current);
      endBoundaryTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    const vid = videoRef.current;
    const directSourceMatches =
      !!vid && scrubVideoSrcRef.current !== null && vid.src === scrubVideoSrcRef.current;
    const preserveDirectSource = canPreserveDirectVideoSource(
      (vid?.readyState ?? 0) >= 1,
      directSourceMatches
    );
    // Always invalidate the session. A play() request can still be pending
    // before playingRef/handlers are populated.
    playbackSessionRef.current += 1;
    clearEndBoundaryTimer();
    schedulePlaybackBoundaryRef.current = null;
    if (vid && timeUpdateHandlerRef.current) {
      vid.removeEventListener("timeupdate", timeUpdateHandlerRef.current);
    }
    timeUpdateHandlerRef.current = null;
    if (vid) {
      vid.onloadedmetadata = null;
      vid.onseeked = null;
      vid.onerror = null;
      vid.pause();
    }
    // Read the media element after pausing so a quick stop preserves the
    // position shown by the HTML player.
    const stoppedTime =
      vid && vid.readyState >= 1 ? getPlaybackTime() : currentPlaybackTimeRef.current;
    const preservedTime = getStoppedPlaybackTime(stoppedTime, startTime, endTime);
    if (!preserveDirectSource) {
      scrubVideoSrcRef.current = null;
      setVideoReady(false);
    }
    currentPlaybackTimeRef.current = preservedTime;
    setCurrentPlaybackTime(preservedTime);
    playingRef.current = false;
    setPlaying(false);
    onTimeUpdateRef.current?.(preservedTime);
  }, [clearEndBoundaryTimer, endTime, getPlaybackTime, startTime]);

  const handlePlaybackBoundary = useCallback(() => {
    if (!playingRef.current) return;
    if (loopPlayback && endTime > startTime) {
      seekTo(startTime);
      schedulePlaybackBoundaryRef.current?.();
      const vid = videoRef.current;
      if (vid) {
        void vid.play().catch(() => stopPlayback());
      }
      return;
    }
    const completedTime = getCompletedPlaybackTime(currentPlaybackTimeRef.current, endTime, true);
    currentPlaybackTimeRef.current = completedTime;
    setCurrentPlaybackTime(completedTime);
    onTimeUpdateRef.current?.(completedTime);
    stopPlayback();
  }, [endTime, loopPlayback, seekTo, startTime, stopPlayback]);

  const startPlayback = useCallback(() => {
    if (!filePath || !probeData) return;
    const vid = videoRef.current;
    if (!vid) return;
    setVideoLoadFailed(false);
    const session = playbackSessionRef.current + 1;
    playbackSessionRef.current = session;
    vid.muted = removeAudio;
    pendingScrubVideoSeekRef.current = null;
    // Resume from the last scrubbed/paused position if it falls within the
    // trim range; otherwise start at trim-in.
    const scrubbed = currentPlaybackTimeRef.current;
    const resumeTime = scrubbed >= startTime && scrubbed < endTime ? scrubbed : startTime;
    currentPlaybackTimeRef.current = resumeTime;
    setCurrentPlaybackTime(resumeTime);
    onTimeUpdateRef.current?.(resumeTime);
    const sources = buildPlaybackUrls(filePath);
    if (sources.length === 0) return;
    const loadedSource = vid.currentSrc || vid.src;
    const loadedSourceIndex = sources.indexOf(loadedSource);
    let sourceIndex = loadedSourceIndex >= 0 ? loadedSourceIndex : sourceIndexRef.current;

    // `timeupdate` drives UI position updates; a one-shot timer enforces the
    // trim out point more tightly than the media pipeline's low-frequency event.
    const ensureStopTimer = () => {
      if (timeUpdateHandlerRef.current) {
        vid.removeEventListener("timeupdate", timeUpdateHandlerRef.current);
      }
      clearEndBoundaryTimer();

      const scheduleBoundaryTimer = () => {
        clearEndBoundaryTimer();
        if (playbackSessionRef.current !== session || !playingRef.current) return;
        const remainingMs = Math.max(0, (endTime - currentPlaybackTimeRef.current) * 1000);
        endBoundaryTimerRef.current = setTimeout(() => {
          endBoundaryTimerRef.current = null;
          if (playbackSessionRef.current === session) {
            handlePlaybackBoundary();
          }
        }, remainingMs);
      };

      schedulePlaybackBoundaryRef.current = scheduleBoundaryTimer;

      const handler = () => {
        const playbackTime = getPlaybackTime();
        currentPlaybackTimeRef.current = playbackTime;
        setCurrentPlaybackTime(playbackTime);
        onTimeUpdateRef.current?.(playbackTime);
        if (playbackTime >= endTime || vid.ended) {
          handlePlaybackBoundary();
          return;
        }
        scheduleBoundaryTimer();
      };
      timeUpdateHandlerRef.current = handler;
      vid.addEventListener("timeupdate", handler);
      scheduleBoundaryTimer();
    };

    vid.oncanplay = null;
    vid.onerror = null;
    vid.onloadedmetadata = null;
    vid.onseeked = null;

    const beginPlayback = (index: number) => {
      if (playbackSessionRef.current !== session) return;
      if (index >= sources.length) {
        setVideoLoadFailed(true);
        onPlaybackErrorRef.current?.("Couldn't play this video in the HTML preview.");
        stopPlayback();
        return;
      }
      sourceIndex = index;
      sourceIndexRef.current = index;
      const source = sources[index];
      scrubVideoSrcRef.current = source;
      const reuseDirectSource = canPreserveDirectVideoSource(
        vid.readyState >= 1,
        vid.src === source
      );
      if (reuseDirectSource) {
        seekVideoElement(resumeTime);
      } else {
        vid.src = source;
        vid.load();
      }
      vid
        .play()
        .then(() => {
          if (playbackSessionRef.current !== session) return;
          playingRef.current = true;
          setPlaying(true);
          ensureStopTimer();
        })
        .catch(() => {
          if (playbackSessionRef.current !== session) return;
          if (index + 1 < sources.length) {
            beginPlayback(index + 1);
            return;
          }
          setVideoLoadFailed(true);
          onPlaybackErrorRef.current?.("Couldn't play this video in the HTML preview.");
          stopPlayback();
        });
    };

    vid.onerror = () => {
      if (playbackSessionRef.current !== session) return;
      if (vid.src !== sources[sourceIndex]) return;
      if (sourceIndex + 1 < sources.length) {
        beginPlayback(sourceIndex + 1);
        return;
      }
      setVideoLoadFailed(true);
      onPlaybackErrorRef.current?.("Couldn't play this video in the HTML preview.");
      stopPlayback();
    };

    // Seek to the current playhead once the browser knows the media duration.
    // --autoplay-policy=no-user-gesture-required (tauri.conf.json) means the
    // async play() call is not blocked by WebView2's autoplay policy.
    vid.onloadedmetadata = () => {
      vid.onloadedmetadata = null;
      vid.currentTime = resumeTime;
    };

    // play() must be called synchronously inside the user-gesture handler.
    // Calling it inside oncanplay (async) breaks WebView2/Chrome's autoplay
    // policy — the promise is rejected and stopPlayback() fires immediately.
    beginPlayback(loadedSourceIndex >= 0 ? loadedSourceIndex : 0);
  }, [
    filePath,
    probeData,
    startTime,
    endTime,
    removeAudio,
    stopPlayback,
    buildPlaybackUrls,
    getPlaybackTime,
    seekVideoElement,
    clearEndBoundaryTimer,
    handlePlaybackBoundary,
  ]);

  const handleVideoEnded = useCallback(() => {
    handlePlaybackBoundary();
  }, [handlePlaybackBoundary]);

  const captureCurrentFrame = useCallback(() => capturePreviewFramePng(videoRef.current), []);

  const captureAndSaveSnapshot = useCallback(async () => {
    if (!onSnapshot) return;
    try {
      const pngBytes = await captureCurrentFrame();
      await onSnapshot(pngBytes);
    } catch (error: unknown) {
      onSnapshotError?.(String(error));
    }
  }, [captureCurrentFrame, onSnapshot, onSnapshotError]);

  // Expose handle so App.tsx can drive playback from keyboard shortcuts
  useImperativeHandle(
    ref,
    () => ({
      startPlayback,
      stopPlayback,
      isPlaying: () => playingRef.current,
      getCurrentTime: () => getPlaybackTime(),
      seekTo,
      stepBy,
      captureCurrentFrame,
    }),
    [startPlayback, stopPlayback, getPlaybackTime, seekTo, stepBy, captureCurrentFrame]
  );

  // Cleanup on unmount
  useEffect(
    () => () => {
      stopPlayback();
    },
    [stopPlayback]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const canPlay = !!filePath && !!probeData && endTime > startTime;
  const showPreviewVideo = !!filePath && !!probeData && videoReady;
  return (
    <div
      className={`preview-pane${filePath ? " has-media" : " is-empty"}`}
      style={containerStyle}
      aria-busy={loadingVideo || (!!filePath && !videoReady && !videoLoadFailed)}
    >
      <PreviewCrop crop={cropAspectRatio}>
        {!playing && !showPreviewVideo && (
          <span className="preview-placeholder" role="status" aria-live="polite">
            {!filePath && (
              <svg
                className="preview-placeholder-icon"
                width="28"
                height="28"
                viewBox="0 0 28 28"
                fill="none"
                aria-hidden="true"
              >
                <rect x="4.5" y="5.5" width="19" height="17" rx="2.5" stroke="currentColor" />
                <path
                  d="M8 5.5v17M20 5.5v17M4.5 10h3.5M4.5 18h3.5M20 10h3.5M20 18h3.5"
                  stroke="currentColor"
                  strokeLinecap="round"
                />
                <path d="m11.5 10.5 6 3.5-6 3.5v-7Z" stroke="currentColor" strokeLinejoin="round" />
              </svg>
            )}
            <span>
              {loadingVideo
                ? "Reading video…"
                : videoLoadFailed
                  ? "HTML video preview unavailable"
                  : filePath
                    ? "Loading preview…"
                    : "No file selected"}
            </span>
          </span>
        )}
        <video
          ref={videoRef}
          crossOrigin="anonymous"
          muted={removeAudio}
          playsInline
          preload="metadata"
          style={playing || showPreviewVideo ? videoVisibleStyle : videoHiddenStyle}
          onLoadedMetadata={handleVideoReady}
          onCanPlay={handleVideoReady}
          onError={() => {
            setVideoReady(false);
            setVideoLoadFailed(true);
          }}
          onEnded={handleVideoEnded}
        />
      </PreviewCrop>

      {/* Play/Stop overlay controls the HTML video element from the Tauri UI. */}
      {canPlay && (
        <div
          className={`preview-controls${playing ? " is-playing" : ""}`}
          style={overlayGroupStyle}
        >
          {!playing ? (
            <button
              type="button"
              className="preview-control-button"
              onClick={startPlayback}
              title="Play trim segment"
              aria-label="Play trim segment"
              style={overlayBtnStyle}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <polygon points="5,3 17,10 5,17" fill="white" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="preview-control-button"
              onClick={stopPlayback}
              title="Stop playback"
              aria-label="Stop playback"
              style={overlayBtnStyle}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect x="4" y="4" width="12" height="12" rx="2" fill="white" />
              </svg>
            </button>
          )}
        </div>
      )}

      {filePath && onSnapshot && (
        <button
          type="button"
          className="preview-control-button snapshot-button"
          onClick={() => void captureAndSaveSnapshot()}
          title="Save the current preview frame (Cmd+Shift+S / Ctrl+Shift+S)"
          aria-label="Save preview frame snapshot"
          style={snapshotBtnStyle}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
        </button>
      )}

      {probeData && (
        <div style={currentTimeOverlayStyle}>
          {currentPlaybackTime.toFixed(1)}s / {probeData.duration.toFixed(1)}s
        </div>
      )}
    </div>
  );
});

export default memo(PreviewPane);
