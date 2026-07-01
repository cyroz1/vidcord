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
import { getFilmstrip, getOs, getPreviewClip, getPreviewFrame } from "../ipc";

// Module-scope static style objects. Hoisted so React doesn't allocate a
// fresh object literal per render — PreviewPane re-renders on every
// trim-slider move during scrubbing, so this is a measurable win.
const containerStyle: React.CSSProperties = {
  background: "var(--surface)",
  backdropFilter: "var(--blur)",
  WebkitBackdropFilter: "var(--blur)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
  position: "relative",
  width: "100%",
  aspectRatio: `${16 / 9}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "var(--shadow-card), var(--card-top)",
};

const imgStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

const placeholderStyle: React.CSSProperties = {
  color: "var(--text-disabled)",
  fontSize: "13px",
};

const videoBaseStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
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

const overlayBtnStyle: React.CSSProperties = {
  background: "rgba(0, 0, 0, 0.38)",
  backdropFilter: "blur(12px) saturate(160%)",
  WebkitBackdropFilter: "blur(12px) saturate(160%)",
  border: "1px solid rgba(255, 255, 255, 0.22)",
  borderRadius: "50%",
  width: "44px",
  height: "44px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  boxShadow: "0 4px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18)",
};

const infoOverlayStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "6px",
  right: "8px",
  fontSize: "11px",
  color: "rgba(255,255,255,0.90)",
  background: "rgba(0,0,0,0.48)",
  backdropFilter: "blur(8px) saturate(160%)",
  WebkitBackdropFilter: "blur(8px) saturate(160%)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "var(--radius-xs)",
  padding: "2px 6px",
  pointerEvents: "none",
};

const currentTimeOverlayStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "6px",
  left: "8px",
  fontSize: "11px",
  color: "rgba(255,255,255,0.90)",
  background: "rgba(0,0,0,0.48)",
  backdropFilter: "blur(8px) saturate(160%)",
  WebkitBackdropFilter: "blur(8px) saturate(160%)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "var(--radius-xs)",
  padding: "2px 6px",
  pointerEvents: "none",
};

type Props = {
  filePath: string | null;
  startTime: number;
  endTime: number;
  previewTime: number | null;
  isScrubbing: boolean;
  removeAudio: boolean;
  loopPlayback: boolean;
  probeData: {
    duration: number;
    width: number;
    height: number;
    display_width?: number;
    display_height?: number;
  } | null;
  // Fired whenever the playback position changes (timeupdate / seek / stop).
  // Replaces the App-level 80 ms polling loop — the media element already
  // emits timeupdate at ~4 Hz, so we just forward that instead of waking the
  // main thread on a wall-clock interval even while the video is paused.
  onTimeUpdate?: (timeSec: number | null) => void;
};

export type PreviewHandle = {
  startPlayback: () => void;
  stopPlayback: () => void;
  isPlaying: () => boolean;
  getCurrentTime: () => number;
  seekTo: (timeSec: number) => void;
  stepBy: (deltaSec: number) => void;
};

type FrameRequest = {
  path: string;
  time: number;
  requestId: number;
};

// Split a concatenated JPEG byte stream into individual frame buffers.
// FFmpeg's image2pipe/mjpeg output places JPEG frames back-to-back;
// each frame begins with SOI (FF D8) and ends with EOI (FF D9).
function splitJpegStream(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  let i = 0;
  while (i + 1 < data.length) {
    if (data[i] === 0xff && data[i + 1] === 0xd8) {
      const start = i;
      i += 2;
      while (i + 1 < data.length) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) {
          frames.push(data.slice(start, i + 2) as Uint8Array<ArrayBuffer>);
          i += 2;
          break;
        }
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return frames;
}

const PreviewPane = forwardRef<PreviewHandle, Props>(function PreviewPane(
  {
    filePath,
    startTime,
    endTime,
    previewTime,
    isScrubbing,
    removeAudio,
    loopPlayback,
    probeData,
    onTimeUpdate,
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
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  // WebKitGTK on Linux initialises a GStreamer audio pipeline even for muted
  // video elements. When autoaudiosink is missing the pipeline returns a NULL
  // element, a GLib-GObject-CRITICAL fires inside WebKitWebProcess, and the
  // entire renderer crashes — turning the window white. Disable live playback
  // on Linux and rely on the static frame preview (generated by ffmpeg) instead.
  // navigator.userAgent is unreliable (WebView2 can include "Linux"), so we ask
  // the backend for the actual OS.
  const [isLinux, setIsLinux] = useState(false);
  const [supportsLiveScrubPreview, setSupportsLiveScrubPreview] = useState(false);
  useEffect(() => {
    getOs().then((os) => {
      const linux = os === "linux";
      setIsLinux(linux);
      setSupportsLiveScrubPreview(!linux);
    });
  }, []);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = removeAudio;
    }
  }, [removeAudio]);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [scrubVideoReady, setScrubVideoReady] = useState(false);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const playingRef = useRef(false);

  // --- Filmstrip state ---
  // Blob URLs for each pre-extracted filmstrip frame. Managed manually
  // (not in React state) to avoid re-renders on every URL creation/revocation.
  const filmstripUrlsRef = useRef<string[]>([]);
  // Index into filmstripUrlsRef to display during scrubbing (null = use frameUrl)
  const [filmstripIdx, setFilmstripIdx] = useState<number | null>(null);
  const filmstripRequestIdRef = useRef(0);

  const currentPlaybackTimeRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRequestIdRef = useRef(0);
  const frameInFlightRef = useRef(false);
  const queuedFrameRequestRef = useRef<FrameRequest | null>(null);
  const startFrameFetchRef = useRef<(request: FrameRequest) => void>(() => {});
  const prevStartTimeRef = useRef(startTime);
  const prevEndTimeRef = useRef(endTime);
  const prevFilePathRef = useRef<string | null>(filePath);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubVideoSrcRef = useRef<string | null>(null);
  const pendingScrubVideoSeekRef = useRef<number | null>(null);
  // Listener reference so we can unbind on stop. Replaces the previous 100 ms
  // setInterval polling of `currentTime`, which kept the main thread warm
  // during every playback.
  const timeUpdateHandlerRef = useRef<(() => void) | null>(null);
  const clipUrlRef = useRef<string | null>(null);
  const playbackSessionRef = useRef(0);
  const playbackOffsetRef = useRef(0);
  const usingGeneratedClipRef = useRef(false);
  const urlCacheRef = useRef<Map<string, string[]>>(new Map());

  const getPlaybackTime = useCallback(() => {
    const raw = (videoRef.current?.currentTime ?? 0) + playbackOffsetRef.current;
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

    const applySeek = () => {
      try {
        vid.currentTime = Math.max(0, mediaTime);
      } catch {
        // Some WebViews reject currentTime before metadata is ready. Keep the
        // newest target and replay it from loadedmetadata/canplay.
        pendingScrubVideoSeekRef.current = Math.max(0, mediaTime);
      }
    };

    if (vid.readyState >= 1) {
      applySeek();
      return;
    }

    pendingScrubVideoSeekRef.current = Math.max(0, mediaTime);
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

      const mediaTime = usingGeneratedClipRef.current
        ? Math.max(0, clamped - playbackOffsetRef.current)
        : clamped;

      if (!Number.isFinite(mediaTime)) return;
      seekVideoElement(mediaTime);
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
    if (!supportsLiveScrubPreview || !filePath || !probeData || playing) {
      setScrubVideoReady(false);
      if (!filePath || !probeData) {
        scrubVideoSrcRef.current = null;
        const vid = videoRef.current;
        if (vid && !playingRef.current) {
          vid.src = "";
          vid.load();
        }
      }
      return;
    }

    const vid = videoRef.current;
    if (!vid || usingGeneratedClipRef.current || clipUrlRef.current) return;

    const [src] = buildPlaybackUrls(filePath);
    if (!src) return;
    if (scrubVideoSrcRef.current === src && vid.src === src) return;

    scrubVideoSrcRef.current = src;
    setScrubVideoReady(false);
    vid.preload = "auto";
    vid.src = src;
    vid.load();
  }, [buildPlaybackUrls, filePath, playing, probeData, supportsLiveScrubPreview]);

  const handleVideoReady = useCallback(() => {
    setScrubVideoReady(true);
    const pending = pendingScrubVideoSeekRef.current;
    if (pending === null) return;
    pendingScrubVideoSeekRef.current = null;
    seekVideoElement(pending);
  }, [seekVideoElement]);

  useEffect(() => {
    if (
      !supportsLiveScrubPreview ||
      !isScrubbing ||
      previewTime === null ||
      playing ||
      usingGeneratedClipRef.current
    ) {
      return;
    }
    const dur = probeData?.duration ?? 0;
    const clamped = dur > 0 ? Math.max(0, Math.min(previewTime, dur)) : Math.max(0, previewTime);
    seekVideoElement(clamped);
  }, [isScrubbing, playing, previewTime, probeData, seekVideoElement, supportsLiveScrubPreview]);

  // ---------------------------------------------------------------------------
  // Filmstrip loading — fires once per file load, runs in the background
  // ---------------------------------------------------------------------------
  const clearFilmstrip = useCallback(() => {
    filmstripUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    filmstripUrlsRef.current = [];
    setFilmstripIdx(null);
  }, []);

  useEffect(() => {
    if (!filePath || !probeData || probeData.duration <= 0) {
      filmstripRequestIdRef.current += 1;
      clearFilmstrip();
      return;
    }
    const requestId = filmstripRequestIdRef.current + 1;
    filmstripRequestIdRef.current = requestId;
    const duration = probeData.duration;
    const maxFrames = duration > 300 ? 36 : duration > 120 ? 48 : 60;
    const delayMs = duration > 120 ? 500 : 120;
    const timer = window.setTimeout(() => {
      getFilmstrip(filePath, duration, maxFrames)
        .then((rawBytes) => {
          if (filmstripRequestIdRef.current !== requestId) return;
          const frames = splitJpegStream(new Uint8Array(rawBytes.buffer as ArrayBuffer));
          if (frames.length === 0) return;
          // Revoke previous strip's URLs before replacing
          filmstripUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
          filmstripUrlsRef.current = frames.map((frame) => {
            const blob = new Blob([frame], { type: "image/jpeg" });
            return URL.createObjectURL(blob);
          });
        })
        .catch(() => {
          // Filmstrip is optional — scrubbing falls back to on-demand frames
        });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      if (filmstripRequestIdRef.current === requestId) {
        filmstripRequestIdRef.current += 1;
      }
    };
  }, [filePath, probeData, clearFilmstrip]);

  // ---------------------------------------------------------------------------
  // Frame preview (static JPEG)
  // ---------------------------------------------------------------------------
  const startFrameFetch = useCallback((request: FrameRequest) => {
    if (frameRequestIdRef.current !== request.requestId) return;
    frameInFlightRef.current = true;
    setLoading(true);
    void (async () => {
      try {
        const buffer = await getPreviewFrame(request.path, request.time);
        if (frameRequestIdRef.current !== request.requestId) return;
        const blob = new Blob([buffer as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        setFilmstripIdx(null); // exact frame is ready — stop showing filmstrip
        setFrameUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      } catch {
        if (frameRequestIdRef.current !== request.requestId) return;
        setFilmstripIdx(null);
        setFrameUrl(null);
      } finally {
        frameInFlightRef.current = false;
        const queued = queuedFrameRequestRef.current;
        queuedFrameRequestRef.current = null;
        if (queued && frameRequestIdRef.current === queued.requestId) {
          startFrameFetchRef.current(queued);
          return;
        }
        setLoading(false);
      }
    })();
  }, []);
  startFrameFetchRef.current = startFrameFetch;

  const fetchFrame = useCallback(
    (path: string, time: number, requestId: number) => {
      if (frameRequestIdRef.current !== requestId) return;
      const request = { path, time, requestId };
      if (frameInFlightRef.current) {
        queuedFrameRequestRef.current = request;
        return;
      }
      startFrameFetch(request);
    },
    [startFrameFetch]
  );

  useEffect(() => {
    if (!filePath || !probeData) {
      frameRequestIdRef.current += 1;
      queuedFrameRequestRef.current = null;
      setLoading(false);
      setFrameUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      stopPlayback();
      return;
    }
    const requestId = frameRequestIdRef.current + 1;
    frameRequestIdRef.current = requestId;
    const isNewFile = filePath !== prevFilePathRef.current;
    const isInitialRange =
      prevStartTimeRef.current === 0 &&
      prevEndTimeRef.current === 0 &&
      startTime === 0 &&
      endTime > 0;
    const startChanged = Math.abs(startTime - prevStartTimeRef.current) > 0.001;
    const endChanged = Math.abs(endTime - prevEndTimeRef.current) > 0.001;
    const explicitPreviewTime =
      previewTime !== null && Number.isFinite(previewTime)
        ? Math.max(0, Math.min(previewTime, probeData.duration))
        : null;
    const frameTime =
      explicitPreviewTime ??
      (isNewFile || isInitialRange ? startTime : endChanged && !startChanged ? endTime : startTime);
    prevFilePathRef.current = filePath;
    prevStartTimeRef.current = startTime;
    prevEndTimeRef.current = endTime;

    // --- Show filmstrip frame immediately while debounce waits ---
    const strip = filmstripUrlsRef.current;
    if (strip.length > 0 && probeData.duration > 0) {
      const rawIdx = (frameTime / probeData.duration) * (strip.length - 1);
      const idx = Math.max(0, Math.min(Math.round(rawIdx), strip.length - 1));
      setFilmstripIdx(idx);
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (isScrubbing) {
      queuedFrameRequestRef.current = null;
      setLoading(false);
      return () => {
        if (frameRequestIdRef.current === requestId) {
          frameRequestIdRef.current += 1;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    debounceRef.current = setTimeout(
      () => {
        void fetchFrame(filePath, frameTime, requestId);
      },
      explicitPreviewTime !== null ? 160 : 100
    );
    return () => {
      if (frameRequestIdRef.current === requestId) {
        frameRequestIdRef.current += 1;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, startTime, endTime, previewTime, isScrubbing, fetchFrame, probeData]);

  // ---------------------------------------------------------------------------
  // Video playback
  // ---------------------------------------------------------------------------
  const stopPlayback = useCallback(() => {
    const vid = videoRef.current;
    const hadActivePlayback =
      playingRef.current ||
      timeUpdateHandlerRef.current !== null ||
      clipUrlRef.current !== null ||
      usingGeneratedClipRef.current;
    if (!hadActivePlayback) return;
    playbackSessionRef.current += 1;
    if (vid && timeUpdateHandlerRef.current) {
      vid.removeEventListener("timeupdate", timeUpdateHandlerRef.current);
    }
    timeUpdateHandlerRef.current = null;
    if (vid) {
      vid.onloadedmetadata = null;
      vid.onseeked = null;
      vid.onerror = null;
      vid.pause();
      vid.src = "";
      vid.load(); // abort any in-flight load
    }
    scrubVideoSrcRef.current = null;
    setScrubVideoReady(false);
    playbackOffsetRef.current = 0;
    usingGeneratedClipRef.current = false;
    currentPlaybackTimeRef.current = 0;
    setCurrentPlaybackTime(0);
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
    playingRef.current = false;
    setPlaying(false);
    onTimeUpdateRef.current?.(null);
  }, []);

  const startPlayback = useCallback(() => {
    if (!filePath || !probeData) return;
    const vid = videoRef.current;
    if (!vid) return;
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
    let sourceIndex = 0;
    let tryingGeneratedClip = false;

    // Event-driven end-of-trim detection. `timeupdate` fires from the media
    // pipeline (~4 Hz per the HTML spec), so we don't need a wall-clock timer
    // waking the main thread every 100 ms. The video element's `onEnded`
    // handler (JSX prop) covers natural end-of-stream.
    const ensureStopTimer = () => {
      if (timeUpdateHandlerRef.current) {
        vid.removeEventListener("timeupdate", timeUpdateHandlerRef.current);
      }
      const handler = () => {
        const playbackTime = getPlaybackTime();
        currentPlaybackTimeRef.current = playbackTime;
        setCurrentPlaybackTime(playbackTime);
        onTimeUpdateRef.current?.(playbackTime);
        if (playbackTime >= endTime || vid.ended) {
          if (loopPlayback && endTime > startTime && !vid.ended) {
            seekTo(startTime);
            return;
          }
          stopPlayback();
        }
      };
      timeUpdateHandlerRef.current = handler;
      vid.addEventListener("timeupdate", handler);
    };

    const playGeneratedClip = async () => {
      if (tryingGeneratedClip) return;
      tryingGeneratedClip = true;
      try {
        const buffer = await getPreviewClip(filePath, startTime, endTime);
        if (playbackSessionRef.current !== session) return;
        const blob = new Blob([new Uint8Array(buffer)], { type: "video/mp4" });
        const clipUrl = URL.createObjectURL(blob);
        if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
        clipUrlRef.current = clipUrl;
        usingGeneratedClipRef.current = true;
        playbackOffsetRef.current = startTime;
        vid.src = clipUrl;
        await vid.play();
        if (playbackSessionRef.current !== session) return;
        playingRef.current = true;
        setPlaying(true);
        ensureStopTimer();
      } catch {
        if (playbackSessionRef.current === session) {
          stopPlayback();
        }
      }
    };

    vid.oncanplay = null;
    vid.onerror = null;
    vid.onloadedmetadata = null;
    vid.onseeked = null;

    const beginPlayback = (index: number) => {
      if (playbackSessionRef.current !== session) return;
      if (index >= sources.length) {
        stopPlayback();
        return;
      }
      sourceIndex = index;
      usingGeneratedClipRef.current = false;
      playbackOffsetRef.current = 0;
      vid.src = sources[index];
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
          void playGeneratedClip();
        });
    };

    vid.onerror = () => {
      if (playbackSessionRef.current !== session) return;
      if (sourceIndex + 1 < sources.length) {
        beginPlayback(sourceIndex + 1);
        return;
      }
      void playGeneratedClip();
    };

    // Seek to startTime once the browser knows the media duration, then play.
    // play() is called after the seek completes so that WebView2/Chromium does
    // not abort the pending play() when currentTime is changed mid-flight
    // (WebKit handles this gracefully; Chromium rejects the promise).
    // --autoplay-policy=no-user-gesture-required (tauri.conf.json) means the
    // async play() call is not blocked by WebView2's autoplay policy.
    vid.onloadedmetadata = () => {
      vid.onloadedmetadata = null;
      vid.currentTime = usingGeneratedClipRef.current ? 0 : startTime;
    };

    // play() must be called synchronously inside the user-gesture handler.
    // Calling it inside oncanplay (async) breaks WebView2/Chrome's autoplay
    // policy — the promise is rejected and stopPlayback() fires immediately.
    beginPlayback(0);
  }, [
    filePath,
    probeData,
    startTime,
    endTime,
    removeAudio,
    stopPlayback,
    buildPlaybackUrls,
    getPlaybackTime,
    loopPlayback,
    seekTo,
  ]);

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
    }),
    [startPlayback, stopPlayback, getPlaybackTime, seekTo, stepBy]
  );

  // Cleanup on unmount
  useEffect(
    () => () => {
      stopPlayback();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setFrameUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      filmstripUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      filmstripUrlsRef.current = [];
    },
    [stopPlayback]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const canPlay = !!filePath && !!probeData && endTime > startTime;
  const showLiveScrubPreview =
    supportsLiveScrubPreview && isScrubbing && previewTime !== null && scrubVideoReady && !playing;

  // Filmstrip frame takes priority while the user is scrubbing; exact on-demand
  // frame replaces it once scrubbing settles and the idle fetch completes.
  const displayUrl =
    filmstripIdx !== null && filmstripUrlsRef.current[filmstripIdx]
      ? filmstripUrlsRef.current[filmstripIdx]
      : frameUrl;

  return (
    <div
      style={containerStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Static frame preview */}
      {displayUrl && !playing && !showLiveScrubPreview ? (
        <img src={displayUrl} alt="preview" style={imgStyle} />
      ) : !playing && !showLiveScrubPreview ? (
        <span style={placeholderStyle}>
          {loading && filmstripUrlsRef.current.length === 0
            ? "Loading preview…"
            : filePath
              ? "Preview"
              : "No file selected"}
        </span>
      ) : null}

      {/* Video element for playback */}
      <video
        ref={videoRef}
        muted={removeAudio}
        style={playing || showLiveScrubPreview ? videoVisibleStyle : videoHiddenStyle}
        onLoadedMetadata={handleVideoReady}
        onCanPlay={handleVideoReady}
        onError={() => setScrubVideoReady(false)}
        onEnded={stopPlayback}
      />

      {/* Play/Stop overlay — shown on hover; disabled on Linux (GStreamer crash) */}
      {canPlay && hovered && !isLinux && (
        <div style={overlayGroupStyle}>
          {!playing ? (
            <button onClick={startPlayback} title="Play trim segment" style={overlayBtnStyle}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <polygon points="5,3 17,10 5,17" fill="white" />
              </svg>
            </button>
          ) : (
            <button onClick={stopPlayback} title="Stop playback" style={overlayBtnStyle}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect x="4" y="4" width="12" height="12" rx="2" fill="white" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Info overlay */}
      {probeData && (
        <div style={infoOverlayStyle}>
          {probeData.width}×{probeData.height} · {probeData.duration.toFixed(1)}s
        </div>
      )}

      {playing && <div style={currentTimeOverlayStyle}>{currentPlaybackTime.toFixed(1)}s</div>}
    </div>
  );
});

export default memo(PreviewPane);
