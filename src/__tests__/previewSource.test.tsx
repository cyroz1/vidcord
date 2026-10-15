// @vitest-environment happy-dom
import { act, createRef } from "react";
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
import PreviewPane, { type PreviewHandle } from "../components/PreviewPane";

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

it("keeps the paused HTML player on its current frame when playback stops", async () => {
  mocks.prepare.mockReset().mockResolvedValue("http://127.0.0.1:9000/private-a");
  const container = document.createElement("div");
  const root = createRoot(container);
  const handle = createRef<PreviewHandle>();
  const probe = {
    duration: 6,
    width: 320,
    height: 180,
    bitrate: 1000,
    codec: "h264",
    audio_tracks: [],
  };
  try {
    await act(async () =>
      root.render(
        <PreviewPane
          ref={handle}
          filePath="/a.mp4"
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
      )
    );
    const video = container.querySelector("video");
    expect(video?.src).toBe("http://127.0.0.1:9000/private-a");
    await act(async () => {
      video?.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video?.style.display).toBe("block");
    await act(async () => {
      handle.current?.startPlayback();
    });
    await act(async () => {
      handle.current?.stopPlayback();
    });
    // Stopping only pauses the element: the source is not torn down or
    // reloaded and the video stays visible on the frame it stopped on.
    expect(video?.src).toBe("http://127.0.0.1:9000/private-a");
    expect(video?.style.display).toBe("block");
    expect(video?.paused).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows the failure state when the current preview candidate errors", async () => {
  mocks.prepare.mockReset().mockResolvedValue("http://127.0.0.1:9000/private-a");
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
  try {
    await act(async () =>
      root.render(
        <PreviewPane
          filePath="/a.mp4"
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
      )
    );
    const video = container.querySelector("video")!;
    expect(video.src).toBe("http://127.0.0.1:9000/private-a");
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(container.textContent).toContain("HTML video preview unavailable");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not wedge when the first playback candidate fails and the fallback succeeds", async () => {
  // A Windows-style path yields two asset-protocol candidates (the raw path
  // and its forward-slash normalization); prepare returns null off Linux, so
  // playback walks the candidate list itself.
  mocks.prepare.mockReset().mockResolvedValue(null);
  const container = document.createElement("div");
  const root = createRoot(container);
  const handle = createRef<PreviewHandle>();
  const probe = {
    duration: 6,
    width: 320,
    height: 180,
    bitrate: 1000,
    codec: "h264",
    audio_tracks: [],
  };
  const filePath = "C:\\clips\\a.mp4";
  const firstCandidate = `asset://localhost${filePath}`;
  const fallbackCandidate = "asset://localhostC:/clips/a.mp4";
  try {
    await act(async () =>
      root.render(
        <PreviewPane
          ref={handle}
          filePath={filePath}
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
      )
    );
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(firstCandidate);
    // Keep playback deterministic: happy-dom does not decode media.
    Object.assign(video, { play: () => Promise.resolve() });
    await act(async () => {
      handle.current?.startPlayback();
    });
    // The first candidate errors: the imperative fallback advances the
    // element to the next candidate, and the React error handler receives
    // the same event with the element already reporting that candidate.
    // Neither may wedge the pane on the failure placeholder.
    await act(async () => {
      video.dispatchEvent(new Event("error"));
    });
    expect(video.getAttribute("src")).toBe(fallbackCandidate);
    expect(container.textContent).not.toContain("HTML video preview unavailable");
    // The fallback then loads and the pane becomes ready on it.
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.style.display).toBe("block");
    expect(container.textContent).not.toContain("HTML video preview unavailable");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the playback-time overlay in sync through the isolated readout", async () => {
  mocks.prepare.mockReset().mockResolvedValue("http://127.0.0.1:9000/private-a");
  const container = document.createElement("div");
  const root = createRoot(container);
  const handle = createRef<PreviewHandle>();
  const probe = {
    duration: 6,
    width: 320,
    height: 180,
    bitrate: 1000,
    codec: "h264",
    audio_tracks: [],
  };
  try {
    await act(async () =>
      root.render(
        <PreviewPane
          ref={handle}
          filePath="/a.mp4"
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
      )
    );
    const overlay = () =>
      Array.from(container.querySelectorAll("div")).find((node) =>
        /^\d+\.\ds \/ \d+\.\ds$/.test(node.textContent ?? "")
      );
    expect(overlay()?.textContent).toBe("0.0s / 6.0s");
    await act(async () => {
      handle.current?.seekTo(2);
    });
    expect(overlay()?.textContent).toBe("2.0s / 6.0s");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not seek back to the scrub point when playback stops mid-clip", async () => {
  mocks.prepare.mockReset().mockResolvedValue("http://127.0.0.1:9000/private-a");
  const container = document.createElement("div");
  const root = createRoot(container);
  const handle = createRef<PreviewHandle>();
  const probe = {
    duration: 6,
    width: 320,
    height: 180,
    bitrate: 1000,
    codec: "h264",
    audio_tracks: [],
  };
  try {
    await act(async () =>
      root.render(
        <PreviewPane
          ref={handle}
          filePath="/a.mp4"
          probeData={probe}
          cropAspectRatio=""
          loadingVideo={false}
          startTime={0}
          endTime={6}
          previewTime={2}
          isScrubbing={false}
          removeAudio={true}
          loopPlayback={false}
        />
      )
    );
    const video = container.querySelector("video")!;
    expect(video.src).toBe("http://127.0.0.1:9000/private-a");
    // happy-dom does not decode media; drive the element's clock directly so
    // seeks and playback positions behave deterministically.
    let mediaTime = 0;
    Object.defineProperty(video, "currentTime", {
      get: () => mediaTime,
      set: (value: number) => {
        mediaTime = value;
      },
      configurable: true,
    });
    Object.defineProperty(video, "readyState", { get: () => 4, configurable: true });
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    // App seeks scrub focus through the handle as well as the prop; that
    // direct seek is what lands the element at 2s.
    await act(async () => {
      handle.current?.seekTo(2);
    });
    expect(mediaTime).toBe(2);
    await act(async () => {
      handle.current?.startPlayback();
    });
    // Playback advances past the scrub point, then the user stops.
    mediaTime = 4.5;
    await act(async () => {
      handle.current?.stopPlayback();
    });
    // The paused element must stay on the frame it stopped on, not jump
    // back to the 2s point playback started from.
    expect(mediaTime).toBe(4.5);
    expect(handle.current?.getCurrentTime()).toBe(4.5);
  } finally {
    await act(async () => root.unmount());
  }
});
