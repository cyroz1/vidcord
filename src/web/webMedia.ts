import { getCenteredCropRect } from "../videoMetadata";

export type BrowserVideoMetadata = {
  name: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number | null;
  bitrateKbps: number;
  sourceBitrateKbps?: number;
  codec: string;
  hasAudio: boolean;
  audioTrackCount?: number;
  audioTracks?: BrowserAudioTrackMetadata[];
  displayWidth?: number;
  displayHeight?: number;
};

export type BrowserAudioTrackMetadata = {
  index: number;
  label: string;
  language: string;
};

export function normalizeBrowserAudioTrackIndices(
  selection: readonly number[] | null,
  metadata: Pick<BrowserVideoMetadata, "hasAudio" | "audioTrackCount" | "audioTracks">,
  removeAudio = false
): number[] {
  if (removeAudio || !metadata.hasAudio) return [];
  const available =
    metadata.audioTracks && metadata.audioTracks.length > 0
      ? metadata.audioTracks.map((track) => track.index)
      : Array.from({ length: Math.max(1, metadata.audioTrackCount ?? 1) }, (_, index) => index);
  const requested = new Set(selection ?? [available[0] ?? 0]);
  return available.filter((index) => requested.has(index));
}

const VIDEO_EXTENSION = /\.(mp4|avi|mov|mkv|flv|wmv|webm|m4v|mpeg|mpg|ogv)$/i;
export const VIDEO_FILE_ACCEPT = "video/*,.mp4,.avi,.mov,.mkv,.flv,.wmv,.webm,.m4v,.mpeg,.mpg,.ogv";
export const MAX_BROWSER_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_BROWSER_INPUT_LABEL = "512 MB";

const CONTAINER_LABELS: Record<string, string> = {
  avi: "AVI container",
  flv: "FLV container",
  m4v: "M4V container",
  mkv: "Matroska container",
  mov: "QuickTime container",
  mp4: "MP4 container",
  mpeg: "MPEG container",
  mpg: "MPEG container",
  ogv: "Ogg container",
  webm: "WebM container",
  wmv: "WMV container",
};

const MIME_CONTAINER_LABELS: Record<string, string> = {
  "video/avi": "AVI container",
  "video/mp4": "MP4 container",
  "video/mpeg": "MPEG container",
  "video/ogg": "Ogg container",
  "video/quicktime": "QuickTime container",
  "video/webm": "WebM container",
  "video/x-flv": "FLV container",
  "video/x-matroska": "Matroska container",
  "video/x-ms-wmv": "WMV container",
};

const MAX_CLIPBOARD_BLOB_BYTES = 8 * 1024 * 1024;
const CLIPBOARD_WRITE_TIMEOUT_MS = 2_000;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSION.test(file.name);
}

export function isBrowserFileSizeSupported(file: Pick<File, "size">): boolean {
  return Number.isFinite(file.size) && file.size > 0 && file.size <= MAX_BROWSER_INPUT_BYTES;
}

export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  if (/android|iphone|ipad|ipod|mobile/i.test(userAgent)) return true;
  // iPadOS 13+ reports a desktop "Macintosh" user agent; a touchscreen tells
  // it apart from a real Mac.
  return /macintosh/i.test(userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(0)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib >= 100 ? 0 : 1)} MB`;
  return `${(mib / 1024).toFixed(2)} GB`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function fileStem(name: string): string {
  const withoutExtension = name.replace(/\.[^/.]+$/, "");
  const normalized = withoutExtension.replace(/[^a-zA-Z0-9._ -]+/g, "-").trim();
  return normalized || "video";
}

export function fileExtension(name: string): string {
  const match = name.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? "mp4";
}

export function browserContainerLabel(file: Pick<File, "name" | "type">): string {
  const mime = file.type.trim().toLowerCase();
  if (MIME_CONTAINER_LABELS[mime]) return MIME_CONTAINER_LABELS[mime];

  const extension = fileExtension(file.name);
  return (
    CONTAINER_LABELS[extension] ??
    (mime.startsWith("video/") ? `${mime.slice(6)} media` : "Video media")
  );
}

export function estimateAverageBitrateKbps(sizeBytes: number, duration: number): number {
  if (
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return 0;
  }
  return (sizeBytes * 8) / duration / 1000;
}

export function estimateVideoBitrateKbps(
  sizeBytes: number,
  duration: number,
  audioTrackCount = 1
): number {
  const averageBitrateKbps = estimateAverageBitrateKbps(sizeBytes, duration);
  if (averageBitrateKbps <= 0) return 0;
  const audioAllowance = Math.max(0, Math.floor(audioTrackCount)) * 128;
  return Math.max(100, Math.floor(averageBitrateKbps - audioAllowance));
}

export function getPreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

type BrowserAudioTrackInfo = {
  audioTracks?: {
    length: number;
    [index: number]: { label?: string; language?: string };
  };
  mozHasAudio?: boolean;
};

function readBrowserAudioTracks(media: BrowserAudioTrackInfo): BrowserAudioTrackMetadata[] {
  const list = media.audioTracks;
  if (!list || !Number.isInteger(list.length) || list.length < 0) return [];
  return Array.from({ length: list.length }, (_, index) => {
    const track = list[index];
    const language = typeof track?.language === "string" ? track.language.trim() : "";
    const label = typeof track?.label === "string" ? track.label.trim() : "";
    return {
      index,
      label: label || (language ? `Track ${index + 1} · ${language}` : `Track ${index + 1}`),
      language,
    };
  });
}

export function inferBrowserAudioMetadata(
  media: BrowserAudioTrackInfo
): Pick<BrowserVideoMetadata, "hasAudio" | "audioTrackCount"> {
  const reportedTrackCount = media.audioTracks?.length;
  const hasReportedTrackCount =
    typeof reportedTrackCount === "number" &&
    Number.isInteger(reportedTrackCount) &&
    reportedTrackCount >= 0;

  // Firefox exposes an explicit audio-presence flag. Other browsers expose
  // audioTracks inconsistently: mobile WebKit can return an empty list for a
  // playable audio stream. Treat that empty list as unknown so audio remains
  // enabled and FFmpeg can preserve its optional first audio stream.
  if (typeof media.mozHasAudio === "boolean") {
    return {
      hasAudio: media.mozHasAudio,
      audioTrackCount: hasReportedTrackCount ? reportedTrackCount : media.mozHasAudio ? 1 : 0,
    };
  }

  if (hasReportedTrackCount && reportedTrackCount > 0) {
    return { hasAudio: true, audioTrackCount: reportedTrackCount };
  }

  return { hasAudio: true, audioTrackCount: undefined };
}

export async function readVideoMetadata(
  file: File,
  signal?: AbortSignal
): Promise<BrowserVideoMetadata> {
  signal?.throwIfAborted();
  const url = getPreviewUrl(file);

  try {
    const metadata = await new Promise<
      Pick<
        BrowserVideoMetadata,
        | "duration"
        | "width"
        | "height"
        | "frameRate"
        | "hasAudio"
        | "audioTrackCount"
        | "audioTracks"
      >
    >((resolve, reject) => {
      const video = document.createElement("video");
      const extendedVideo = video as HTMLVideoElement &
        BrowserAudioTrackInfo & {
          frameRate?: number;
        };
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      let timeoutId: number | null = null;

      const cleanup = () => {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
        video.removeAttribute("src");
        video.load();
      };

      const onLoadedMetadata = () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (duration <= 0 || width <= 0 || height <= 0) {
          cleanup();
          reject(new Error("The browser could not read this video's dimensions or duration."));
          return;
        }
        const { hasAudio, audioTrackCount } = inferBrowserAudioMetadata(extendedVideo);
        const audioTracks = readBrowserAudioTracks(extendedVideo);
        const frameRate =
          typeof extendedVideo.frameRate === "number" &&
          Number.isFinite(extendedVideo.frameRate) &&
          extendedVideo.frameRate > 0
            ? extendedVideo.frameRate
            : null;
        cleanup();
        resolve({ duration, width, height, frameRate, hasAudio, audioTrackCount, audioTracks });
      };
      const onError = () => {
        cleanup();
        reject(new Error("This browser cannot preview the selected video format."));
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Video metadata loading cancelled."));
      };
      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      video.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("The browser took too long to read this video's metadata."));
      }, 10_000);
      video.src = url;
      video.load();
    });

    return {
      name: file.name,
      sizeBytes: file.size,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      frameRate: metadata.frameRate,
      bitrateKbps: estimateAverageBitrateKbps(file.size, metadata.duration),
      sourceBitrateKbps: estimateVideoBitrateKbps(
        file.size,
        metadata.duration,
        metadata.audioTrackCount ?? (metadata.hasAudio ? 1 : 0)
      ),
      codec: browserContainerLabel(file),
      hasAudio: metadata.hasAudio,
      audioTrackCount: metadata.audioTrackCount,
      audioTracks: metadata.audioTracks,
      // videoWidth/videoHeight are the browser's intrinsic display dimensions;
      // keep them separate so crop UI can use display geometry when a browser
      // exposes encoded dimensions through another metadata path in the future.
      displayWidth: metadata.width,
      displayHeight: metadata.height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function blobFromCanvas(
  video: HTMLVideoElement,
  cropAspectRatio = "off"
): Promise<Blob> {
  await waitForVideoFrame(video);
  const crop = getCenteredCropRect(video.videoWidth, video.videoHeight, cropAspectRatio);

  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not create a snapshot canvas.");
  context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The browser could not encode the snapshot.");
  return blob;
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  const source = video.currentSrc || video.src;
  const ready = () =>
    !video.seeking &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0;
  if (video.error || !source) return Promise.reject(new Error("The preview frame is unavailable."));
  if (ready()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const events = ["loadeddata", "canplay", "seeked", "error", "emptied"];
    const cleanup = () => {
      window.clearTimeout(timeout);
      events.forEach((event) => video.removeEventListener(event, check));
    };
    const fail = () => {
      cleanup();
      reject(new Error("The preview frame is not ready yet."));
    };
    const check = () => {
      if (video.error || (video.currentSrc || video.src) !== source) {
        fail();
      } else if (ready()) {
        cleanup();
        resolve();
      }
    };
    const timeout = window.setTimeout(fail, 5000);
    events.forEach((event) => video.addEventListener(event, check));
    check();
  });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function tryCopyBlobToClipboard(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
  // Clipboard implementations are not a reliable transport for large video
  // blobs. A large write can stay pending after the browser download already
  // succeeded, which would leave the export UI stuck in its finishing state.
  if (blob.size > MAX_CLIPBOARD_BLOB_BYTES) return false;
  try {
    const write = navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "application/octet-stream"]: blob }),
    ]);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(success);
      };
      const timeout = window.setTimeout(() => finish(false), CLIPBOARD_WRITE_TIMEOUT_MS);
      write.then(
        () => finish(true),
        () => finish(false)
      );
    });
  } catch {
    return false;
  }
}
