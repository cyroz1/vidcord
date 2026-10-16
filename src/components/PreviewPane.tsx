import PreviewCrop from "./PreviewCrop";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ProbeData } from "../ipc";
import { preparePreviewSource, releasePreviewSource } from "../ipc";
import {
  canPreserveDirectVideoSource,
  getCompletedPlaybackTime,
  getStoppedPlaybackTime,
} from "../previewScrub";
import { capturePreviewFramePng } from "../previewFrame";
import { applyPreviewAudioTrackSelection } from "../audioTracks";

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

// The playback-time readout lives in its own tiny component: syncPlaybackTime
// writes the live text straight to this node's textContent (outside React)
// at timeupdate rate, so the invariant that a React render of the node
// re-derives its text from the latest playback time is structural — only
// this component ever renders the node, and its text prop is always built
// from currentPlaybackTimeRef at render time. Keeping the node inside the
// full pane tree made that easy to break silently by memoizing the pane.
const PlaybackTimeOverlay = memo(
  forwardRef<HTMLDivElement, { text: string }>(function PlaybackTimeOverlay({ text }, ref) {
    return (
      <div ref={ref} style={currentTimeOverlayStyle}>
        {text}
      </div>
    );
  })
);

type AssignedCandidate = {
  /** The raw candidate string handed to the element. */
  source: string;
  /**
   * The same candidate in the form the element reports it back (read from
   * `vid.src` immediately after assignment): browsers resolve/percent-encode
   * the raw string, so error/ready events must be compared against this
   * form, never against the raw prepared string.
   */
  resolvedSource: string;
};

function captureAssignedCandidate(vid: HTMLVideoElement, source: string): AssignedCandidate {
  return { source, resolvedSource: vid.src || vid.currentSrc || source };
}

function matchesAssignedCandidate(reported: string, assigned: AssignedCandidate | null): boolean {
  if (!assigned) return true;
  return reported === assigned.resolvedSource || reported === assigned.source;
}

type Props = {
  cropAspectRatio: string;
  filePath: string | null;
  loadingVideo: boolean;
  startTime: number;
  endTime: number;
  previewTime: number | null;
  isScrubbing: boolean;
  removeAudio: boolean;
  previewAudioTrackIndices?: readonly number[];
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
    previewAudioTrackIndices = [],
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
  const previewAudioTrackIndicesRef = useRef<readonly number[]>(previewAudioTrackIndices);
  previewAudioTrackIndicesRef.current = previewAudioTrackIndices;
  // Latest previewTime prop, mirrored so stopPlayback can mark the current
  // focus value as consumed without depending on the prop in its dep array.
  const previewTimeRef = useRef(previewTime);
  useEffect(() => {
    previewTimeRef.current = previewTime;
  }, [previewTime]);
  // The previewTime value the prop effect below has already seeked to. A
  // focus value is a one-shot seek request, not a position the paused
  // preview must return to: once applied it stays consumed, so effects that
  // re-fire for other reasons (playback toggling, scrub state settling)
  // cannot drag the element back to a stale scrub point after a stop.
  const appliedPreviewTimeRef = useRef<number | null>(null);
  const [videoLoadFailed, setVideoLoadFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const currentPlaybackTimeRef = useRef(0);
  // The time readout updates at timeupdate rate (~4 Hz). Keep it out of React
  // state and write the overlay text through a ref (the same pattern as the
  // trim playhead transform) so playback ticks never re-render the pane.
  const playbackTimeOverlayRef = useRef<HTMLDivElement>(null);
  const playbackDurationRef = useRef(0);
  useEffect(() => {
    playbackDurationRef.current = probeData?.duration ?? 0;
  }, [probeData]);
  const syncPlaybackTime = useCallback((time: number) => {
    currentPlaybackTimeRef.current = time;
    const overlay = playbackTimeOverlayRef.current;
    if (overlay) {
      overlay.textContent = `${time.toFixed(1)}s / ${playbackDurationRef.current.toFixed(1)}s`;
    }
  }, []);
  useEffect(() => {
    setVideoLoadFailed(false);
    setVideoReady(false);
    appliedPreviewTimeRef.current = null;
    assignedCandidateRef.current = null;
    consumedErrorEventsRef.current = 0;
    syncPlaybackTime(0);
    onTimeUpdateRef.current?.(filePath ? 0 : null);
  }, [filePath, syncPlaybackTime]);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = removeAudio;
      applyPreviewAudioTrackSelection(videoRef.current, previewAudioTrackIndices);
    }
  }, [previewAudioTrackIndices, removeAudio]);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackConfigRef = useRef({ startTime, endTime, loopPlayback });
  playbackConfigRef.current = { startTime, endTime, loopPlayback };
  const scrubVideoSrcRef = useRef<string | null>(null);
  // Which candidate the current load attempt was assigned, captured at
  // assignment time (see AssignedCandidate). The React onError handler
  // compares against this — not against whatever source happens to be
  // current when the handler runs — so a stale error from a superseded
  // candidate is ignored and a genuine error from the current candidate,
  // whose reported URL form differs from the raw string, still surfaces.
  const assignedCandidateRef = useRef<AssignedCandidate | null>(null);
  // Error events the imperative playback fallback has already consumed by
  // advancing to the next candidate. The same event also reaches the React
  // onError handler (by then the element already reports the *next*
  // candidate, so no source comparison can tell it apart from a genuine
  // error for that candidate); the fallback bumps this count when it
  // advances and the React handler ignores exactly that many deliveries.
  const consumedErrorEventsRef = useRef(0);
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

  useEffect(() => {
    if (playingRef.current) schedulePlaybackBoundaryRef.current?.();
  }, [startTime, endTime, loopPlayback]);
  const [preparedSource, setPreparedSource] = useState<{ path: string } | null>(null);

  useEffect(() => {
    setPreparedSource(null);
    if (!filePath || !probeData) return;
    const cache = urlCacheRef.current;
    let disposed = false;
    let ownedUrl: string | null = null;
    void preparePreviewSource(filePath)
      .then((url) => {
        if (disposed) {
          if (url) void releasePreviewSource(url).catch(() => {});
          return;
        }
        ownedUrl = url;
        if (url) cache.set(filePath, [url]);
        setVideoLoadFailed(false);
        setPreparedSource({ path: filePath });
      })
      .catch(() => {
        if (!disposed) setVideoLoadFailed(true);
      });
    return () => {
      disposed = true;
      if (ownedUrl) {
        if (cache.get(filePath)?.[0] === ownedUrl) cache.delete(filePath);
        void releasePreviewSource(ownedUrl).catch(() => {});
      }
    };
  }, [filePath, probeData]);

  const getPlaybackTime = useCallback(() => {
    const video = videoRef.current;
    const raw = video && video.readyState >= 1 ? video.currentTime : currentPlaybackTimeRef.current;
    return Number.isFinite(raw) ? raw : currentPlaybackTimeRef.current;
  }, []);

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

      syncPlaybackTime(clamped);
      onTimeUpdateRef.current?.(clamped);
      if (!vid) return;
      seekVideoElement(clamped);
    },
    [probeData, seekVideoElement, syncPlaybackTime]
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
    // Preview sources are only the Tauri asset protocol (Windows/macOS) and
    // the prepared loopback URL (Linux, already in the cache above). There
    // is deliberately no file:// candidate: the CSP cannot allow file: media
    // while keeping the preview surface locked to scoped sources, and a
    // file:// URL handed to the element directly was never a scoped route.
    const urls: Set<string> = new Set([convertFileSrc(path)]);

    if (normalizedPath !== path) {
      urls.add(convertFileSrc(normalizedPath));
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
        assignedCandidateRef.current = null;
        pendingScrubVideoSeekRef.current = null;
        vid.pause();
        vid.removeAttribute("src");
        vid.load();
      }
      return;
    }
    if (videoLoadFailed) return;
    if (preparedSource?.path !== filePath) return;

    if (playingRef.current) return;
    const sources = buildPlaybackUrls(filePath);
    const activeSource = vid.currentSrc || vid.src;
    const activeIndex = sources.indexOf(activeSource);
    if (activeIndex >= 0) {
      sourceIndexRef.current = activeIndex;
      scrubVideoSrcRef.current = activeSource;
      assignedCandidateRef.current = captureAssignedCandidate(vid, activeSource);
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
    assignedCandidateRef.current = captureAssignedCandidate(vid, src);
    vid.load();
  }, [buildPlaybackUrls, filePath, probeData, playing, videoLoadFailed, preparedSource]);

  const handleVideoReady = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      const assigned = assignedCandidateRef.current;
      if (assigned !== null) {
        if (!matchesAssignedCandidate(event.currentTarget.src, assigned)) {
          return;
        }
      } else if (
        scrubVideoSrcRef.current !== null &&
        event.currentTarget.src !== scrubVideoSrcRef.current
      ) {
        return;
      }
      setVideoReady(true);
      setVideoLoadFailed(false);
      applyPreviewAudioTrackSelection(event.currentTarget, previewAudioTrackIndices);
      const pending = pendingScrubVideoSeekRef.current;
      if (pending === null) return;
      pendingScrubVideoSeekRef.current = null;
      seekVideoElement(pending);
    },
    [previewAudioTrackIndices, seekVideoElement]
  );

  const handleVideoError = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    // An error the imperative playback fallback already consumed by
    // advancing to the next candidate also reaches this handler, with the
    // element already reporting the next candidate. It is not a failure of
    // that candidate — ignore exactly that delivery.
    if (consumedErrorEventsRef.current > 0) {
      consumedErrorEventsRef.current -= 1;
      return;
    }
    // Ignore errors from a superseded candidate: compare the reported
    // source against the candidate captured when the current load attempt
    // was assigned (in the element's own reported form), so a stale error
    // cannot wedge the pane and a genuine error from the current candidate
    // is never mistaken for a stale one over a URL-form difference.
    const assigned = assignedCandidateRef.current;
    if (assigned !== null) {
      const reported = event.currentTarget.src;
      if (reported && !matchesAssignedCandidate(reported, assigned)) {
        return;
      }
    } else if (
      scrubVideoSrcRef.current !== null &&
      event.currentTarget.src !== scrubVideoSrcRef.current
    ) {
      return;
    }
    setVideoReady(false);
    setVideoLoadFailed(true);
  }, []);

  useEffect(() => {
    if (previewTime === null || playing) return;
    if (appliedPreviewTimeRef.current === previewTime) return;
    appliedPreviewTimeRef.current = previewTime;
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
      // Just pause the HTML player. A paused media element keeps displaying
      // the frame it stopped on, so never tear down or reload its source
      // here: swapping in a generated still or re-seeking after a reload
      // loses the exact frame the user paused on. Adopt the element's actual
      // source as the scrub source so the source-loading effect also leaves
      // the element untouched.
      vid.pause();
      const activeSource = vid.currentSrc || vid.src;
      if (activeSource) {
        scrubVideoSrcRef.current = activeSource;
        assignedCandidateRef.current = captureAssignedCandidate(vid, activeSource);
      }
    }
    // Read the media element after pausing so a quick stop preserves the
    // position shown by the HTML player.
    const stoppedTime =
      vid && vid.readyState >= 1 ? getPlaybackTime() : currentPlaybackTimeRef.current;
    const { startTime, endTime } = playbackConfigRef.current;
    const preservedTime = getStoppedPlaybackTime(stoppedTime, startTime, endTime);
    // The stopped position is now the preview's position. Consume the
    // current focus value so the previewTime effect cannot re-seek the
    // paused element back to the point playback started from.
    appliedPreviewTimeRef.current = previewTimeRef.current;
    syncPlaybackTime(preservedTime);
    playingRef.current = false;
    setPlaying(false);
    onTimeUpdateRef.current?.(preservedTime);
  }, [clearEndBoundaryTimer, getPlaybackTime, syncPlaybackTime]);

  const handlePlaybackBoundary = useCallback(() => {
    if (!playingRef.current) return;
    const { startTime, endTime, loopPlayback } = playbackConfigRef.current;
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
    syncPlaybackTime(completedTime);
    onTimeUpdateRef.current?.(completedTime);
    stopPlayback();
  }, [seekTo, stopPlayback, syncPlaybackTime]);

  const startPlayback = useCallback(() => {
    if (!filePath || !probeData) return;
    const vid = videoRef.current;
    if (!vid) return;
    setVideoLoadFailed(false);
    const session = playbackSessionRef.current + 1;
    playbackSessionRef.current = session;
    vid.muted = removeAudio;
    applyPreviewAudioTrackSelection(vid, previewAudioTrackIndicesRef.current);
    pendingScrubVideoSeekRef.current = null;
    const { startTime, endTime } = playbackConfigRef.current;
    // Resume from the last scrubbed/paused position if it falls within the
    // trim range; otherwise start at trim-in.
    const scrubbed = currentPlaybackTimeRef.current;
    const resumeTime = scrubbed >= startTime && scrubbed < endTime ? scrubbed : startTime;
    syncPlaybackTime(resumeTime);
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
        const currentEndTime = playbackConfigRef.current.endTime;
        const remainingMs = Math.max(0, (currentEndTime - getPlaybackTime()) * 1000);
        endBoundaryTimerRef.current = setTimeout(
          () => {
            endBoundaryTimerRef.current = null;
            if (playbackSessionRef.current !== session || !playingRef.current) return;
            const latestEndTime = playbackConfigRef.current.endTime;
            const actualTime = getPlaybackTime();
            if (!vid.seeking && (vid.ended || actualTime >= latestEndTime)) {
              handlePlaybackBoundary();
            } else {
              // Buffering can make wall-clock time pass without advancing the
              // media clock. Recheck shortly instead of stopping at the trim
              // boundary based on elapsed time alone.
              scheduleBoundaryTimer();
            }
          },
          Math.max(50, Math.min(remainingMs, 250))
        );
      };

      schedulePlaybackBoundaryRef.current = scheduleBoundaryTimer;

      const handler = () => {
        const playbackTime = getPlaybackTime();
        syncPlaybackTime(playbackTime);
        onTimeUpdateRef.current?.(playbackTime);
        if (!vid.seeking && (playbackTime >= playbackConfigRef.current.endTime || vid.ended)) {
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
      // Advancing (initially or as a fallback) is a fresh load attempt: a
      // React error handler that raced ahead of the fallback must not leave
      // the pane wedged on the previous candidate's failure.
      setVideoLoadFailed(false);
      sourceIndex = index;
      sourceIndexRef.current = index;
      const source = sources[index];
      scrubVideoSrcRef.current = source;
      const reuseDirectSource = canPreserveDirectVideoSource(
        vid.readyState >= 1,
        vid.src === source
      );
      if (reuseDirectSource) {
        assignedCandidateRef.current = captureAssignedCandidate(vid, source);
        seekVideoElement(resumeTime);
      } else {
        vid.src = source;
        assignedCandidateRef.current = captureAssignedCandidate(vid, source);
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
      // Only the candidate assigned for this attempt can fail playback;
      // compare in the element's reported form (see AssignedCandidate).
      if (
        assignedCandidateRef.current !== null
          ? !matchesAssignedCandidate(vid.src, assignedCandidateRef.current)
          : vid.src !== sources[sourceIndex]
      ) {
        return;
      }
      if (sourceIndex + 1 < sources.length) {
        // This same error event is also delivered to the React onError
        // handler after the fallback has advanced the element to the next
        // candidate; mark it consumed so that delivery is ignored there.
        consumedErrorEventsRef.current += 1;
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
    removeAudio,
    stopPlayback,
    buildPlaybackUrls,
    getPlaybackTime,
    seekVideoElement,
    clearEndBoundaryTimer,
    handlePlaybackBoundary,
    syncPlaybackTime,
  ]);

  const handleVideoEnded = useCallback(() => {
    handlePlaybackBoundary();
  }, [handlePlaybackBoundary]);

  const captureCurrentFrame = useCallback(
    () => capturePreviewFramePng(videoRef.current, cropAspectRatio),
    [cropAspectRatio]
  );

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

  // Cleanup on unmount only. stopPlayback changes identity whenever the trim
  // range changes (via getPlaybackTime), so depending on it here ran the
  // cleanup on every trim change and stopped playback mid-drag. Run the
  // latest copy through a ref with an empty dep array instead.
  const stopPlaybackRef = useRef(stopPlayback);
  useEffect(() => {
    stopPlaybackRef.current = stopPlayback;
  }, [stopPlayback]);
  useEffect(
    () => () => {
      stopPlaybackRef.current();
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const canPlay =
    !!filePath && !!probeData && preparedSource?.path === filePath && endTime > startTime;
  const showPreviewVideo = !!filePath && !!probeData && videoReady;
  // PreviewCrop is memoized, so its children must be referentially stable
  // for the memo to ever bail: building the placeholder + video inline here
  // recreated them on every pane render (every trim-scrub tick) and defeated
  // it. Memoize the children on exactly the values they read.
  const previewChildren = useMemo(
    () => (
      <>
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
          onError={handleVideoError}
          onEnded={handleVideoEnded}
        />
      </>
    ),
    [
      playing,
      showPreviewVideo,
      filePath,
      loadingVideo,
      videoLoadFailed,
      removeAudio,
      handleVideoReady,
      handleVideoError,
      handleVideoEnded,
    ]
  );
  return (
    <div
      className={`preview-pane${filePath ? " has-media" : " is-empty"}`}
      style={containerStyle}
      aria-busy={loadingVideo || (!!filePath && !videoReady && !videoLoadFailed)}
    >
      <PreviewCrop crop={cropAspectRatio}>{previewChildren}</PreviewCrop>

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
        <PlaybackTimeOverlay
          ref={playbackTimeOverlayRef}
          text={`${currentPlaybackTimeRef.current.toFixed(1)}s / ${probeData.duration.toFixed(1)}s`}
        />
      )}
    </div>
  );
});

export default memo(PreviewPane);
