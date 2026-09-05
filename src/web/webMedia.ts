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
  displayWidth?: number;
  displayHeight?: number;
};

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
        "duration" | "width" | "height" | "frameRate" | "hasAudio" | "audioTrackCount"
      >
    >((resolve, reject) => {
      const video = document.createElement("video");
      const extendedVideo = video as HTMLVideoElement & {
        audioTracks?: { length: number };
        frameRate?: number;
        mozHasAudio?: boolean;
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
        const audioTrackCount =
          extendedVideo.audioTracks &&
          Number.isInteger(extendedVideo.audioTracks.length) &&
          extendedVideo.audioTracks.length >= 0
            ? extendedVideo.audioTracks.length
            : undefined;
        const hasAudio =
          typeof extendedVideo.mozHasAudio === "boolean"
            ? extendedVideo.mozHasAudio
            : audioTrackCount === undefined
              ? true
              : audioTrackCount > 0;
        const frameRate =
          typeof extendedVideo.frameRate === "number" &&
          Number.isFinite(extendedVideo.frameRate) &&
          extendedVideo.frameRate > 0
            ? extendedVideo.frameRate
            : null;
        cleanup();
        resolve({ duration, width, height, frameRate, hasAudio, audioTrackCount });
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

export async function blobFromCanvas(video: HTMLVideoElement): Promise<Blob> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0) {
    throw new Error("The preview frame is not ready yet.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not create a snapshot canvas.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The browser could not encode the snapshot.");
  return blob;
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
