/** Capture the currently decoded video frame at preview size for a pause overlay. */
export function capturePreviewFrameDataUrl(video: HTMLVideoElement): string | null {
  const { videoWidth: width, videoHeight: height } = video;
  if (video.readyState < 2 || !width || !height) return null;
  const scale = Math.min(1, 960 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) return null;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.94);
  } catch {
    return null;
  }
}

export async function capturePreviewFramePng(video: HTMLVideoElement | null): Promise<Uint8Array> {
  if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error("The preview frame is not ready yet.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The app could not create a snapshot canvas.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The app could not encode the snapshot.");
  return new Uint8Array(await blob.arrayBuffer());
}
