// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePreviewFramePng } from "../previewFrame";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function preview() {
  const video = document.createElement("video");
  video.src = "https://asset.localhost/sample.mp4";
  const state = { readyState: 1, seeking: true, videoWidth: 320, videoHeight: 180 };
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(video, key, { get: () => state[key] });
  }
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
  });
  return { video, state, draw };
}

describe("HTML preview snapshots", () => {
  it("waits for a paused seek to decode before capturing the new frame", async () => {
    const { video, state, draw } = preview();
    const capture = capturePreviewFramePng(video);
    state.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));
    await Promise.resolve();
    expect(draw).not.toHaveBeenCalled();
    state.seeking = false;
    video.dispatchEvent(new Event("seeked"));
    expect(await capture).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(draw).toHaveBeenCalledWith(video, 0, 0, 320, 180, 0, 0, 320, 180);
  });

  it("keeps the snapshot canvas at source resolution", async () => {
    const { video, state, draw } = preview();
    state.readyState = 2;
    state.seeking = false;
    state.videoWidth = 3840;
    state.videoHeight = 2160;
    expect(await capturePreviewFramePng(video)).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(draw).toHaveBeenCalledWith(video, 0, 0, 3840, 2160, 0, 0, 3840, 2160);
  });

  it("reports encode failures with the descriptive snapshot error", async () => {
    const { video, state } = preview();
    state.readyState = 2;
    state.seeking = false;
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {
      throw new Error("tainted canvas");
    });
    await expect(capturePreviewFramePng(video)).rejects.toThrow(
      "The app could not encode the snapshot."
    );
  });

  it("rejects a superseded source instead of saving the next video's frame", async () => {
    const { video, draw } = preview();
    const capture = capturePreviewFramePng(video);
    const rejected = expect(capture).rejects.toThrow("not ready");
    video.src = "https://asset.localhost/other.mp4";
    video.dispatchEvent(new Event("emptied"));
    await rejected;
    expect(draw).not.toHaveBeenCalled();
  });

  it("bounds the wait when the player never decodes", async () => {
    vi.useFakeTimers();
    const { video, draw } = preview();
    const capture = capturePreviewFramePng(video);
    const rejected = expect(capture).rejects.toThrow("not ready");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(draw).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
