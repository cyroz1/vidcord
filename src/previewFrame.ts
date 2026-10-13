const MAX_PAUSED_PREVIEW_DIMENSION = 960;

/** Capture the currently decoded video frame at preview size for a pause overlay. */
export function capturePreviewFrameDataUrl(video: HTMLVideoElement): string | null {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    1,
    MAX_PAUSED_PREVIEW_DIMENSION / Math.max(video.videoWidth, video.videoHeight)
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.94);
  } catch {
    // Tauri's asset protocol or a browser media restriction may prevent canvas
    // reads. In that case the paused video element remains the fallback.
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
