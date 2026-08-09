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
import {
  cancelPreviewGeneration,
  cancelPreviewFrameGeneration,
  getFilmstrip,
  getOs,
  getPreviewClip,
  getPreviewFrame,
  type ProbeData,
} from "../ipc";
import {
  canPreserveDirectVideoSource,
  getCompletedPlaybackTime,
  getFilmstripFrameBudget,
  getStoppedPlaybackTime,
  isFilmstripUseful,
  shouldGenerateFilmstrip,
  shouldFetchReleasedScrubFrame,
  shouldFetchScrubFrame,
  shouldShowDirectPreviewVideo,
} from "../previewScrub";

const FIXED_PREVIEW_CSS_WIDTH = 432;
const PREVIEW_ASPECT_WIDTH = 16;
const PREVIEW_ASPECT_HEIGHT = 9;
const PREVIEW_PIXEL_WIDTH_STEP = 32;
const PREVIEW_MIN_PIXEL_WIDTH = 448;
const PREVIEW_MAX_PIXEL_WIDTH = 960;
const FILMSTRIP_PREVIEW_WIDTH = PREVIEW_MIN_PIXEL_WIDTH;
const FILMSTRIP_PREVIEW_HEIGHT =
  (FILMSTRIP_PREVIEW_WIDTH * PREVIEW_ASPECT_HEIGHT) / PREVIEW_ASPECT_WIDTH;
const MAX_GENERATED_PREVIEW_CLIP_SECONDS = 12;
const MEDIA_SEEK_EPSILON_SECONDS = 1 / 240;

// Module-scope static style objects. Hoisted so React doesn't allocate a
// fresh object literal per render — PreviewPane re-renders on every
// trim-slider move during scrubbing, so this is a measurable win.
const containerStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
  contain: "paint",
  position: "relative",
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

const imgStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
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

const currentTimeOverlayStyle: React.CSSProperties = {
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

const snapshotBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: "8px",
  right: "8px",
  color: "rgba(255,255,255,0.92)",
  background: "rgba(0,0,0,0.38)",
  backdropFilter: "blur(8px) saturate(160%)",
  WebkitBackdropFilter: "blur(8px) saturate(160%)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: "50%",
  padding: 0,
  width: "28px",
  height: "28px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  cursor: "pointer",
  boxShadow: "0 2px 6px rgba(0,0,0,0.24)",
  zIndex: 10,
};

type Props = {
  filePath: string | null;
  sourceGeneration: number;
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
  onSnapshot?: (timeSec: number) => void;
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
  previewWidth: number;
  previewHeight: number;
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
    sourceGeneration,
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
  const [directPreviewFailed, setDirectPreviewFailed] = useState(false);
  const [initialPreviewSettled, setInitialPreviewSettled] = useState(false);
  const supportsLiveScrubPreviewRef = useRef(false);
  useEffect(() => {
    getOs()
      .then((os) => {
        const linux = os === "linux";
        setIsLinux(linux);
        setSupportsLiveScrubPreview(!linux);
        supportsLiveScrubPreviewRef.current = !linux;
      })
      .catch(() => {
        // Safe fallback: avoid a potentially unstable native video pipeline
        // and retain FFmpeg-backed previews if OS detection ever fails.
        setIsLinux(true);
      });
  }, []);
  useEffect(() => {
    setDirectPreviewFailed(false);
    setInitialPreviewSettled(false);
    currentPlaybackTimeRef.current = 0;
    setCurrentPlaybackTime(0);
    onTimeUpdateRef.current?.(filePath ? 0 : null);
  }, [filePath]);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = removeAudio;
    }
  }, [removeAudio]);
  const [loading, setLoading] = useState(false);
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
  const frameCancellationRef = useRef<Promise<void> | null>(null);
  const startFrameFetchRef = useRef<(request: FrameRequest) => void>(() => {});
  const prevStartTimeRef = useRef(startTime);
  const prevEndTimeRef = useRef(endTime);
  const prevIsScrubbingRef = useRef(isScrubbing);
  const prevFilePathRef = useRef<string | null>(filePath);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubVideoSrcRef = useRef<string | null>(null);
  const pendingScrubVideoSeekRef = useRef<number | null>(null);
  // Listener reference so we can unbind on stop. Replaces the previous 100 ms
  // setInterval polling of `currentTime`, which kept the main thread warm
  // during every playback.
  const timeUpdateHandlerRef = useRef<(() => void) | null>(null);
  const endBoundaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePlaybackBoundaryRef = useRef<(() => void) | null>(null);
  const clipUrlRef = useRef<string | null>(null);
  const generatedClipCacheRef = useRef<{
    key: string;
    sourceGeneration: number;
    url: string;
  } | null>(null);
  const generatedClipEndTimeRef = useRef<number | null>(null);
  const playbackSessionRef = useRef(0);
  const playbackOffsetRef = useRef(0);
  const usingGeneratedClipRef = useRef(false);
  const urlCacheRef = useRef<Map<string, string[]>>(new Map());

  const getPreviewPixelSize = useCallback(() => {
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    // 432x243 is an exact 16:9 CSS frame, but FFmpeg requires even output
    // dimensions and would round the height to 244. Use the next even 16:9
    // pair instead so contain never creates side gaps around a source frame.
    const width = Math.min(
      PREVIEW_MAX_PIXEL_WIDTH,
      Math.max(
        PREVIEW_MIN_PIXEL_WIDTH,
        Math.round((FIXED_PREVIEW_CSS_WIDTH * scale) / PREVIEW_PIXEL_WIDTH_STEP) *
          PREVIEW_PIXEL_WIDTH_STEP
      )
    );
    return {
      width,
      height: (width * PREVIEW_ASPECT_HEIGHT) / PREVIEW_ASPECT_WIDTH,
    };
  }, []);

  useEffect(() => {
    return () => {
      cancelPreviewGeneration().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const cached = generatedClipCacheRef.current;
    if (cached && cached.sourceGeneration !== sourceGeneration) {
      URL.revokeObjectURL(cached.url);
      generatedClipCacheRef.current = null;
    }
  }, [sourceGeneration]);

  useEffect(() => {
    const cacheRef = generatedClipCacheRef;
    return () => {
      if (cacheRef.current) {
        URL.revokeObjectURL(cacheRef.current.url);
        cacheRef.current = null;
      }
    };
  }, []);

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
    if (!supportsLiveScrubPreview || !filePath) {
      setScrubVideoReady(false);
      if (!filePath) {
        scrubVideoSrcRef.current = null;
        const vid = videoRef.current;
        if (vid && !playingRef.current) {
          vid.src = "";
          vid.load();
        }
      }
      return;
    }

    // Direct playback reuses this same media element and source. Keep its
    // ready state while playing so Stop can reveal the paused frame without
    // swapping through the static preview first.
    if (playing) return;

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
  }, [buildPlaybackUrls, filePath, isScrubbing, playing, probeData, supportsLiveScrubPreview]);

  const handleVideoReady = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      setScrubVideoReady(true);
      if (
        scrubVideoSrcRef.current !== null &&
        event.currentTarget.src === scrubVideoSrcRef.current &&
        !usingGeneratedClipRef.current
      ) {
        setDirectPreviewFailed(false);
      }
      const pending = pendingScrubVideoSeekRef.current;
      if (pending === null) return;
      pendingScrubVideoSeekRef.current = null;
      seekVideoElement(pending);
    },
    [seekVideoElement]
  );

  useEffect(() => {
    if (
      !supportsLiveScrubPreview ||
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
    if (!shouldGenerateFilmstrip(isLinux, directPreviewFailed, initialPreviewSettled)) {
      filmstripRequestIdRef.current += 1;
      clearFilmstrip();
      return;
    }
    const requestId = filmstripRequestIdRef.current + 1;
    filmstripRequestIdRef.current = requestId;
    const duration = probeData.duration;
    const maxFrames = getFilmstripFrameBudget(duration);
    const timer = window.setTimeout(() => {
      getFilmstrip(filePath, duration, maxFrames, FILMSTRIP_PREVIEW_WIDTH, FILMSTRIP_PREVIEW_HEIGHT)
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
    }, 100);

    return () => {
      window.clearTimeout(timer);
      if (filmstripRequestIdRef.current === requestId) {
        filmstripRequestIdRef.current += 1;
      }
    };
  }, [clearFilmstrip, directPreviewFailed, filePath, initialPreviewSettled, isLinux, probeData]);

  // ---------------------------------------------------------------------------
  // Frame preview (static JPEG)
  // ---------------------------------------------------------------------------
  const startFrameFetch = useCallback((request: FrameRequest) => {
    if (frameRequestIdRef.current !== request.requestId) return;
    frameInFlightRef.current = true;
    setLoading(true);
    void (async () => {
      try {
        const buffer = await getPreviewFrame(
          request.path,
          request.time,
          request.previewWidth,
          request.previewHeight
        );
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
        if (frameRequestIdRef.current === request.requestId) {
          setInitialPreviewSettled(true);
        }
        frameInFlightRef.current = false;
        // A superseding request actively terminates the old FFmpeg process.
        // Wait for that cancellation command to advance the backend generation
        // before starting the queued request, otherwise the new process can be
        // mistaken for stale work and terminated too.
        if (frameCancellationRef.current) return;
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
      const { width, height } = getPreviewPixelSize();
      const request = { path, time, requestId, previewWidth: width, previewHeight: height };
      if (frameInFlightRef.current) {
        queuedFrameRequestRef.current = request;
        if (!frameCancellationRef.current) {
          const cancellation = cancelPreviewFrameGeneration().catch(() => {});
          frameCancellationRef.current = cancellation;
          void cancellation.finally(() => {
            if (frameCancellationRef.current !== cancellation) return;
            frameCancellationRef.current = null;
            if (frameInFlightRef.current) return;
            const queued = queuedFrameRequestRef.current;
            queuedFrameRequestRef.current = null;
            if (queued && frameRequestIdRef.current === queued.requestId) {
              startFrameFetchRef.current(queued);
            } else {
              setLoading(false);
            }
          });
        }
        return;
      }
      startFrameFetch(request);
    },
    [getPreviewPixelSize, startFrameFetch]
  );

  useEffect(() => {
    const wasScrubbing = prevIsScrubbingRef.current;
    prevIsScrubbingRef.current = isScrubbing;
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
    if (supportsLiveScrubPreview && scrubVideoReady && !directPreviewFailed) {
      frameRequestIdRef.current += 1;
      queuedFrameRequestRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setLoading(false);
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
    const fetchReleasedScrubFrame = shouldFetchReleasedScrubFrame(
      wasScrubbing,
      isScrubbing,
      explicitPreviewTime !== null
    );
    const frameTime =
      explicitPreviewTime ??
      (isNewFile || isInitialRange ? startTime : endChanged && !startChanged ? endTime : startTime);
    prevFilePathRef.current = filePath;
    prevStartTimeRef.current = startTime;
    prevEndTimeRef.current = endTime;

    // --- Show filmstrip frame immediately while debounce waits ---
    const strip = filmstripUrlsRef.current;
    const hasUsefulFilmstrip = isFilmstripUseful(strip.length, probeData.duration);
    if (strip.length > 0 && probeData.duration > 0) {
      const rawIdx = (frameTime / probeData.duration) * (strip.length - 1);
      const idx = Math.max(0, Math.min(Math.round(rawIdx), strip.length - 1));
      setFilmstripIdx(idx);
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const fetchScrubFrame = shouldFetchScrubFrame(
      isScrubbing,
      hasUsefulFilmstrip,
      supportsLiveScrubPreview,
      scrubVideoReady
    );
    if (isScrubbing && !fetchScrubFrame) {
      queuedFrameRequestRef.current = null;
      setLoading(false);
      return () => {
        if (frameRequestIdRef.current === requestId) {
          frameRequestIdRef.current += 1;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    // Direct media seeking is not available for every codec/WebView, and the
    // optional filmstrip may still be loading or may have failed. Keep one
    // FFmpeg frame request in flight and retain only the newest queued target
    // so dragging either trim handle still updates the preview.
    if (fetchScrubFrame || fetchReleasedScrubFrame) {
      void fetchFrame(filePath, frameTime, requestId);
      return () => {
        if (frameRequestIdRef.current === requestId) {
          frameRequestIdRef.current += 1;
        }
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
  }, [
    filePath,
    startTime,
    endTime,
    previewTime,
    isScrubbing,
    fetchFrame,
    probeData,
    directPreviewFailed,
    scrubVideoReady,
    supportsLiveScrubPreview,
  ]);

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
    const preservedTime = getStoppedPlaybackTime(
      currentPlaybackTimeRef.current,
      startTime,
      endTime
    );
    const directSourceMatches =
      !!vid && scrubVideoSrcRef.current !== null && vid.src === scrubVideoSrcRef.current;
    const preserveDirectSource = canPreserveDirectVideoSource(
      supportsLiveScrubPreviewRef.current,
      (vid?.readyState ?? 0) >= 1,
      usingGeneratedClipRef.current,
      directSourceMatches
    );
    // Always invalidate the session. A direct play() or generated-clip IPC
    // request can still be pending before playingRef/handlers are populated;
    // returning early in that window allowed stale media to start later.
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
      if (!preserveDirectSource) {
        vid.src = "";
        vid.load(); // abort any in-flight load
      }
    }
    if (!preserveDirectSource) {
      scrubVideoSrcRef.current = null;
      setScrubVideoReady(false);
    }
    generatedClipEndTimeRef.current = null;
    playbackOffsetRef.current = 0;
    usingGeneratedClipRef.current = false;
    currentPlaybackTimeRef.current = preservedTime;
    setCurrentPlaybackTime(preservedTime);
    if (clipUrlRef.current) {
      clipUrlRef.current = null;
    }
    playingRef.current = false;
    setPlaying(false);
    onTimeUpdateRef.current?.(preservedTime);
  }, [clearEndBoundaryTimer, endTime, startTime]);

  const handlePlaybackBoundary = useCallback(() => {
    if (!playingRef.current) return;
    const generatedClipCoversTrimEnd =
      !usingGeneratedClipRef.current ||
      (generatedClipEndTimeRef.current !== null &&
        generatedClipEndTimeRef.current >= endTime - 0.05);
    if (loopPlayback && endTime > startTime && generatedClipCoversTrimEnd) {
      seekTo(startTime);
      schedulePlaybackBoundaryRef.current?.();
      const vid = videoRef.current;
      if (vid) {
        void vid.play().catch(() => stopPlayback());
      }
      return;
    }
    const completedTime = getCompletedPlaybackTime(
      currentPlaybackTimeRef.current,
      endTime,
      generatedClipCoversTrimEnd
    );
    currentPlaybackTimeRef.current = completedTime;
    setCurrentPlaybackTime(completedTime);
    onTimeUpdateRef.current?.(completedTime);
    stopPlayback();
  }, [endTime, loopPlayback, seekTo, startTime, stopPlayback]);

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
    const resumeClipOffset = Math.max(0, resumeTime - startTime);
    currentPlaybackTimeRef.current = resumeTime;
    setCurrentPlaybackTime(resumeTime);
    onTimeUpdateRef.current?.(resumeTime);
    const sources = buildPlaybackUrls(filePath);
    if (sources.length === 0) return;
    let sourceIndex = 0;
    let tryingGeneratedClip = false;

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

    const playGeneratedClip = async () => {
      if (tryingGeneratedClip) return;
      tryingGeneratedClip = true;
      try {
        const fallbackStartTime = Math.max(startTime, Math.min(resumeTime, endTime));
        const fallbackEndTime = Math.min(
          endTime,
          fallbackStartTime + MAX_GENERATED_PREVIEW_CLIP_SECONDS
        );
        const { width: previewWidth, height: previewHeight } = getPreviewPixelSize();
        const clipKey = `${sourceGeneration}\0${filePath}\0${Math.round(
          fallbackStartTime * 1000
        )}\0${Math.round(fallbackEndTime * 1000)}\0${previewWidth}x${previewHeight}`;
        let clipUrl =
          generatedClipCacheRef.current?.key === clipKey ? generatedClipCacheRef.current.url : null;
        if (!clipUrl) {
          const buffer = await getPreviewClip(
            filePath,
            fallbackStartTime,
            fallbackEndTime,
            previewWidth,
            previewHeight
          );
          if (playbackSessionRef.current !== session) return;
          const blob = new Blob([buffer as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
          clipUrl = URL.createObjectURL(blob);
          if (generatedClipCacheRef.current) {
            URL.revokeObjectURL(generatedClipCacheRef.current.url);
          }
          generatedClipCacheRef.current = { key: clipKey, sourceGeneration, url: clipUrl };
        }
        if (playbackSessionRef.current !== session) return;
        clipUrlRef.current = clipUrl;
        usingGeneratedClipRef.current = true;
        generatedClipEndTimeRef.current = fallbackEndTime;
        playbackOffsetRef.current = fallbackStartTime;
        vid.onloadedmetadata = () => {
          vid.onloadedmetadata = null;
          vid.currentTime = 0;
        };
        vid.src = clipUrl;
        // The generated source arrives after the original click handler has
        // returned. Keep this fallback muted: WebKit pauses media when audio is
        // enabled without a fresh user gesture. Direct source playback still
        // uses the requested audio state.
        vid.muted = true;
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
      generatedClipEndTimeRef.current = null;
      playbackOffsetRef.current = 0;
      const source = sources[index];
      const reuseDirectSource = canPreserveDirectVideoSource(
        supportsLiveScrubPreviewRef.current,
        vid.readyState >= 1,
        false,
        index === 0 && scrubVideoSrcRef.current === source && vid.src === source
      );
      if (reuseDirectSource) {
        seekVideoElement(resumeTime);
      } else {
        vid.src = source;
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

    // Seek to the current playhead once the browser knows the media duration.
    // --autoplay-policy=no-user-gesture-required (tauri.conf.json) means the
    // async play() call is not blocked by WebView2's autoplay policy.
    vid.onloadedmetadata = () => {
      vid.onloadedmetadata = null;
      vid.currentTime = usingGeneratedClipRef.current ? resumeClipOffset : resumeTime;
    };

    if (directPreviewFailed) {
      void playGeneratedClip();
      return;
    }

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
    sourceGeneration,
    stopPlayback,
    buildPlaybackUrls,
    getPlaybackTime,
    seekVideoElement,
    clearEndBoundaryTimer,
    handlePlaybackBoundary,
    directPreviewFailed,
    getPreviewPixelSize,
  ]);

  const handleVideoEnded = useCallback(() => {
    handlePlaybackBoundary();
  }, [handlePlaybackBoundary]);

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
  const showDirectPreviewVideo = shouldShowDirectPreviewVideo(
    supportsLiveScrubPreview,
    probeData !== null,
    scrubVideoReady,
    playing
  );

  // Static previews remain the fallback for Linux and unsupported codecs. When
  // direct seeking works, the ready media element stays visible without
  // launching redundant FFmpeg frame work.
  const displayUrl =
    filmstripIdx !== null && filmstripUrlsRef.current[filmstripIdx]
      ? filmstripUrlsRef.current[filmstripIdx]
      : frameUrl;

  return (
    <div
      className={`preview-pane${filePath ? " has-media" : " is-empty"}`}
      ref={previewContainerRef}
      style={containerStyle}
      aria-busy={loadingVideo || loading}
    >
      {/* Static frame preview */}
      {!loadingVideo && displayUrl && !playing && !showDirectPreviewVideo ? (
        <img src={displayUrl} alt="Video frame preview" style={imgStyle} />
      ) : !playing && !showDirectPreviewVideo ? (
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
              : loading && filmstripUrlsRef.current.length === 0
                ? "Loading preview…"
                : filePath
                  ? "Preview"
                  : "No file selected"}
          </span>
        </span>
      ) : null}

      {/* Video element for playback */}
      <video
        ref={videoRef}
        muted={removeAudio}
        playsInline
        preload="auto"
        style={playing || showDirectPreviewVideo ? videoVisibleStyle : videoHiddenStyle}
        onLoadedMetadata={handleVideoReady}
        onCanPlay={handleVideoReady}
        onError={(event) => {
          setScrubVideoReady(false);
          if (
            filePath &&
            supportsLiveScrubPreview &&
            scrubVideoSrcRef.current !== null &&
            event.currentTarget.src === scrubVideoSrcRef.current &&
            !usingGeneratedClipRef.current
          ) {
            setDirectPreviewFailed(true);
          }
        }}
        onEnded={handleVideoEnded}
      />

      {/* Play/Stop overlay — shown on hover; disabled on Linux (GStreamer crash) */}
      {canPlay && !isLinux && (
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
          onClick={() => onSnapshot(currentPlaybackTime)}
          title="Capture frame snapshot to clipboard (Cmd+Shift+S / Ctrl+Shift+S)"
          aria-label="Capture frame snapshot to clipboard"
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
