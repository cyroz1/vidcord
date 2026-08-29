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
};

const VIDEO_EXTENSION = /\.(mp4|avi|mov|mkv|flv|wmv|webm|m4v|mpeg|mpg|ogv)$/i;

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

export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSION.test(file.name);
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

export function estimateVideoBitrateKbps(sizeBytes: number, duration: number): number {
  const averageBitrateKbps = estimateAverageBitrateKbps(sizeBytes, duration);
  if (averageBitrateKbps <= 0) return 0;
  // The browser cannot enumerate source tracks reliably. Reserve the same
  // 128 kbps AAC allowance used by the desktop app while deriving a safe
  // source-video bitrate for target-size planning.
  return Math.max(100, Math.floor(averageBitrateKbps - 128));
}

export function getPreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

export async function readVideoMetadata(file: File): Promise<BrowserVideoMetadata> {
  const url = getPreviewUrl(file);

  try {
    const metadata = await new Promise<Pick<BrowserVideoMetadata, "duration" | "width" | "height">>(
      (resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;

        const cleanup = () => {
          video.removeAttribute("src");
          video.load();
        };

        video.addEventListener(
          "loadedmetadata",
          () => {
            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (duration <= 0 || width <= 0 || height <= 0) {
              cleanup();
              reject(new Error("The browser could not read this video's dimensions or duration."));
              return;
            }
            cleanup();
            resolve({ duration, width, height });
          },
          { once: true }
        );
        video.addEventListener(
          "error",
          () => {
            cleanup();
            reject(new Error("This browser cannot preview the selected video format."));
          },
          { once: true }
        );
        video.src = url;
        video.load();
      }
    );

    return {
      name: file.name,
      sizeBytes: file.size,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      frameRate: null,
      bitrateKbps: estimateAverageBitrateKbps(file.size, metadata.duration),
      sourceBitrateKbps: estimateVideoBitrateKbps(file.size, metadata.duration),
      codec: browserContainerLabel(file),
      // Browsers do not expose a reliable source-track list. FFmpeg still keeps
      // the first audio stream unless the user explicitly removes audio.
      hasAudio: true,
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
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "application/octet-stream"]: blob }),
    ]);
    return true;
  } catch {
    return false;
  }
}
