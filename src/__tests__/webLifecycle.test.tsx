// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  readMetadata: vi.fn(),
  download: vi.fn(),
  exportFile: vi.fn(),
  marketingRender: vi.fn(),
}));

vi.mock("../web/DesktopUpgrade", () => ({
  default: ({ children }: { children?: unknown }) => {
    mocks.marketingRender();
    return children;
  },
}));
vi.mock("../web/browserExport", () => ({
  BrowserFfmpegEngine: class {
    load = mocks.load;
    cancel = mocks.cancel;
    dispose = mocks.dispose;
  },
  exportBrowserFile: mocks.exportFile,
}));
vi.mock("../web/webMedia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web/webMedia")>()),
  readVideoMetadata: mocks.readMetadata,
  getPreviewUrl: () => "blob:preview",
  downloadBlob: mocks.download,
  tryCopyBlobToClipboard: async () => false,
}));

import WebApp from "../web/WebApp";

let root: Root;
let container: HTMLDivElement;
const fallbackStorageValues = new Map<string, string>();
const metadata = {
  duration: 20,
  width: 640,
  height: 360,
  bitrateKbps: 1000,
  hasAudio: true,
  codec: "MP4",
  frameRate: 30,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ensureLocalStorage(): void {
  if (window.localStorage) return;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => fallbackStorageValues.get(key) ?? null,
      setItem: (key: string, value: string) => fallbackStorageValues.set(key, value),
      removeItem: (key: string) => fallbackStorageValues.delete(key),
      clear: () => fallbackStorageValues.clear(),
    },
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  ensureLocalStorage();
  window.localStorage.clear();
  mocks.load.mockResolvedValue(undefined);
  mocks.readMetadata.mockImplementation(async (file: File) => ({
    ...metadata,
    name: file.name,
    sizeBytes: file.size,
  }));
  mocks.exportFile.mockResolvedValue({
    blob: new Blob(["result"], { type: "video/mp4" }),
    fileName: "clip-vidcord.mp4",
    bytes: 6,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<WebApp />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function file(name = "clip.mp4", content = "video") {
  return new File([content], name, { type: "video/mp4", lastModified: 123 });
}

async function selectFiles(files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function exportVideo() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".web-export-button")!.click();
  });
}

describe("browser export lifecycle", () => {
  it("keeps marketing outside editor updates while accepting drops elsewhere on the page", async () => {
    const initialMarketingRenders = mocks.marketingRender.mock.calls.length;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file()] } });
    await act(async () => container.querySelector(".web-header")!.dispatchEvent(drop));
    const video = container.querySelector<HTMLVideoElement>("video")!;
    for (let time = 1; time <= 5; time += 1) {
      await act(async () => {
        video.currentTime = time;
        video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
      });
    }
    await exportVideo();
    expect(mocks.readMetadata).toHaveBeenCalledOnce();
    expect(mocks.exportFile).toHaveBeenCalledOnce();
    expect(mocks.marketingRender).toHaveBeenCalledTimes(initialMarketingRenders);
  });

  it("continues a batch after an unreadable file and shows each outcome", async () => {
    await selectFiles([file("first.mp4"), file("broken.mp4"), file("last.mp4")]);
    mocks.readMetadata.mockRejectedValueOnce(new Error("Unreadable video"));
    await exportVideo();
    expect(mocks.exportFile).toHaveBeenCalledTimes(2);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(
      Array.from(container.querySelectorAll(".web-queue-size"), (node) => node.textContent?.trim())
    ).toEqual(["Downloaded", "Failed", "Downloaded"]);
    expect(container.textContent).toContain("2 downloaded · 1 failed");
  });

  it("keeps shared batch crop and audio controls independent of the selected file", async () => {
    mocks.readMetadata.mockResolvedValueOnce({
      ...metadata,
      name: "square.mp4",
      width: 360,
      hasAudio: false,
    });
    await selectFiles([file("square.mp4"), file("wide.mp4")]);
    const crop = container.querySelector<HTMLSelectElement>(
      ".web-standard-grid label:nth-child(2) select"
    )!;
    expect(Array.from(crop.options).some((option) => option.value === "1:1")).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Mute audio"]')?.disabled
    ).toBe(false);
  });

  it("reports audio changes even when a batch also has oversized outputs and failures", async () => {
    await selectFiles([file("first.mp4"), file("broken.mp4")]);
    mocks.exportFile.mockResolvedValueOnce({
      blob: new Blob(["result"], { type: "video/mp4" }),
      fileName: "first-vidcord.mp4",
      bytes: 6,
      wasOversized: true,
      audioRemovedForCompatibility: true,
      normalizationSkipped: true,
    });
    mocks.readMetadata.mockRejectedValueOnce(new Error("Unreadable video"));
    await exportVideo();
    expect(container.textContent).toContain("1 downloaded · 1 failed");
    expect(container.textContent).toContain("above the selected size target");
    expect(container.textContent).toContain("Audio was removed");
    expect(container.textContent).toContain("Audio normalization was skipped");
  });

  it("keeps cancellation available during the encoder download", async () => {
    await selectFiles([file()]);
    let rejectLoad: (reason: Error) => void = () => undefined;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        })
    );
    mocks.cancel.mockImplementationOnce(() => rejectLoad(new Error("Export cancelled.")));
    await exportVideo();
    const cancel = container.querySelector<HTMLButtonElement>(".web-export-button")!;
    expect(cancel.textContent).toBe("Cancel export");
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.exportFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No files were downloaded");
  });

  it("never starts another encode after cancellation during batch metadata loading", async () => {
    const first = file("first.mp4");
    const second = file("second.mp4");
    await selectFiles([first, second]);
    let resolveMetadata: (value: unknown) => void = () => undefined;
    mocks.readMetadata.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        })
    );
    await exportVideo();
    expect(mocks.exportFile).toHaveBeenCalledTimes(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".web-export-button")!.click()
    );
    await act(async () =>
      resolveMetadata({ ...metadata, name: second.name, sizeBytes: second.size })
    );
    expect(mocks.exportFile).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("1 file was downloaded before cancellation");
  });

  it("does not reuse stale metadata for different Files with identical file attributes", async () => {
    await selectFiles([file("same.mp4", "first")]);
    mocks.readMetadata.mockResolvedValueOnce({
      ...metadata,
      name: "same.mp4",
      sizeBytes: 5,
      duration: 7,
    });
    await selectFiles([file("same.mp4", "other")]);
    expect(mocks.readMetadata).toHaveBeenCalledTimes(2);
    await exportVideo();
    expect(mocks.exportFile.mock.calls[0][0].metadata.duration).toBe(7);
  });

  it("clears old export results when the trim changes", async () => {
    await selectFiles([file()]);
    await exportVideo();
    expect(container.querySelector(".web-last-export")).not.toBeNull();
    const timeline = container.querySelector<HTMLElement>(".web-timeline")!;
    const video = container.querySelector<HTMLVideoElement>("video")!;
    await act(async () => {
      video.currentTime = 5;
      video.dispatchEvent(new Event("timeupdate", { bubbles: true }));
    });
    await act(async () =>
      timeline.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }))
    );
    expect(container.querySelector(".web-last-export")).toBeNull();
    expect(container.querySelector(".web-progress-panel")).toBeNull();
  });

  it("processes a drop inside the import area only once", async () => {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file()] } });
    await act(async () => container.querySelector(".web-import-bar")!.dispatchEvent(drop));
    expect(mocks.readMetadata).toHaveBeenCalledOnce();
  });
});
