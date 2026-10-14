// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ipc", () => ({
  preparePreviewSource: mocks.prepare,
  releasePreviewSource: mocks.release,
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));
import PreviewPane from "../components/PreviewPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("releases stale preparation results without replacing the newly selected preview", async () => {
  let resolveA!: (url: string) => void;
  let resolveB!: (url: string) => void;
  mocks.prepare
    .mockReturnValueOnce(new Promise<string>((resolve) => (resolveA = resolve)))
    .mockReturnValueOnce(new Promise<string>((resolve) => (resolveB = resolve)));
  const container = document.createElement("div");
  const root = createRoot(container);
  const probe = {
    duration: 6,
    width: 320,
    height: 180,
    bitrate: 1000,
    codec: "h264",
    audio_tracks: [],
  };
  const render = (path: string) =>
    root.render(
      <PreviewPane
        filePath={path}
        probeData={probe}
        cropAspectRatio=""
        loadingVideo={false}
        startTime={0}
        endTime={6}
        previewTime={null}
        isScrubbing={false}
        removeAudio={true}
        loopPlayback={false}
      />
    );
  try {
    await act(async () => render("/a.mp4"));
    expect(container.querySelector("video")?.getAttribute("src")).toBeNull();
    await act(async () => render("/b.mp4"));
    await act(async () => resolveB("http://127.0.0.1:9000/private-b"));
    expect(container.querySelector("video")?.src).toBe("http://127.0.0.1:9000/private-b");
    await act(async () => resolveA("http://127.0.0.1:9000/private-a"));
    expect(mocks.release).toHaveBeenCalledWith("http://127.0.0.1:9000/private-a");
    expect(container.querySelector("video")?.src).toBe("http://127.0.0.1:9000/private-b");
  } finally {
    await act(async () => root.unmount());
  }
  expect(mocks.release).toHaveBeenCalledWith("http://127.0.0.1:9000/private-b");
});
