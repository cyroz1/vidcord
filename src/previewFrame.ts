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

// Snapshots cap the longest side at 1920 px: a native-resolution canvas for a
// 4K/8K source costs tens of MB of backing store plus full-res PNG encode time
// on the click path, for no visible gain in a saved preview still.
const MAX_SNAPSHOT_SIDE_PX = 1920;

export async function capturePreviewFramePng(video: HTMLVideoElement | null): Promise<Uint8Array> {
  if (!video) {
    throw new Error("The preview frame is not ready yet.");
  }
  await waitForPreviewFrame(video);

  const scale = Math.min(1, MAX_SNAPSHOT_SIDE_PX / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The app could not create a snapshot canvas.");

  let blob: Blob | null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    throw new Error("The app could not encode the snapshot.");
  }
  if (!blob) throw new Error("The app could not encode the snapshot.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** WebKit can temporarily discard its decoded frame while a paused seek completes. */
function waitForPreviewFrame(video: HTMLVideoElement): Promise<void> {
  const source = video.currentSrc || video.src;
  const ready = () =>
    !video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  if (video.error || !source) return Promise.reject(new Error("The preview frame is unavailable."));
  if (ready()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const events = ["loadeddata", "canplay", "seeked", "error", "emptied"];
    const cleanup = () => {
      clearTimeout(timeout);
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
    const timeout = setTimeout(fail, 5000);
    events.forEach((event) => video.addEventListener(event, check));
    check();
  });
}
