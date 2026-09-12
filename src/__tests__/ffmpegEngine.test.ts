import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ffmpeg/core?url", () => ({ default: "/assets/core.js" }));
vi.mock("@ffmpeg/core/wasm?url", () => ({ default: "/assets/core.wasm" }));
vi.mock("@ffmpeg/ffmpeg", () => ({
  FFFSType: { WORKERFS: "WORKERFS" },
  FFmpeg: class {
    loaded = false;
    callbacks = new Map<string, (event: unknown) => void>();
    on = vi.fn((event: string, callback: (event: unknown) => void) =>
      this.callbacks.set(event, callback)
    );
    off = vi.fn((event: string) => this.callbacks.delete(event));
    load = vi.fn(async () => {
      this.loaded = true;
    });
    terminate = vi.fn(() => {
      this.loaded = false;
    });
    createDir = vi.fn(async () => true);
    mount = vi.fn(async () => true);
    unmount = vi.fn(async () => true);
    deleteDir = vi.fn(async () => true);
    deleteFile = vi.fn(async () => true);
    readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
    exec = vi.fn(async () => 0);
  },
}));

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { BrowserFfmpegEngine } from "../web/ffmpegEngine";

const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
let engine: BrowserFfmpegEngine;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 }))
  );
  engine = new BrowserFfmpegEngine();
});

afterEach(() => {
  engine.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function currentFfmpeg() {
  return (engine as unknown as { ffmpeg: FFmpeg }).ffmpeg;
}

describe("browser encoder lifecycle", () => {
  it("aborts an in-flight encoder download and can retry", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal?.reason), { once: true });
        })
    );
    const loading = engine.load();
    const cancelled = expect(loading).rejects.toThrow("cancelled");
    engine.cancel();
    await cancelled;
    expect(signal?.aborted).toBe(true);
    await engine.load();
    expect(engine.isLoaded).toBe(true);
  });

  it("bounds stalled encoder downloads", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const result = expect(engine.load()).rejects.toThrow("too long to load");
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(engine.isLoaded).toBe(false);
  });

  it("mounts the original File without reading it into a full input buffer", async () => {
    const read = vi.spyOn(file, "arrayBuffer");
    const session = await engine.createSession(file);
    const ffmpeg = currentFfmpeg();
    expect(ffmpeg.mount).toHaveBeenCalledWith(
      "WORKERFS",
      {
        blobs: [{ name: "input-1.mp4", data: file }],
      },
      "/input-1"
    );
    expect(read).not.toHaveBeenCalled();
    await session.run((input) => ["-i", input, "-f", "null", "-"], undefined, undefined, 60_000);
    expect(ffmpeg.exec).toHaveBeenCalledWith(
      ["-i", "/input-1/input-1.mp4", "-f", "null", "-"],
      60_000
    );
    await session.dispose();
    await session.dispose();
    expect(ffmpeg.unmount).toHaveBeenCalledExactlyOnceWith("/input-1");
    expect(ffmpeg.deleteDir).toHaveBeenCalledExactlyOnceWith("/input-1");
  });

  it("rejects overlapping sessions and releases ownership after disposal", async () => {
    const session = await engine.createSession(file);
    await expect(engine.createSession(file)).rejects.toThrow("busy");
    await session.dispose();
    const next = await engine.createSession(file);
    await next.dispose();
  });

  it("removes prepared palettes even if their encoder pass fails", async () => {
    const session = await engine.createSession(file);
    const ffmpeg = currentFfmpeg();
    vi.mocked(ffmpeg.exec).mockResolvedValueOnce(1);
    await expect(session.prepareFile(() => ["palette.png"], "palette.png")).rejects.toThrow(
      "exit code 1"
    );
    await session.dispose();
    expect(ffmpeg.deleteFile).toHaveBeenCalledWith("palette.png");
    expect(ffmpeg.unmount).toHaveBeenCalledWith("/input-1");
  });

  it("does not let disposal from a cancelled generation unlock a newer session", async () => {
    const oldSession = await engine.createSession(file);
    engine.cancel();
    const nextSession = await engine.createSession(file);
    await oldSession.dispose();
    await expect(engine.createSession(file)).rejects.toThrow("busy");
    await nextSession.dispose();
  });

  it("cleans up the mount and unlocks the engine when file preparation fails", async () => {
    await engine.load();
    const ffmpeg = currentFfmpeg();
    vi.mocked(ffmpeg.mount).mockRejectedValueOnce(new Error("mount failed"));
    await expect(engine.createSession(file)).rejects.toThrow("mount failed");
    expect(ffmpeg.deleteDir).toHaveBeenCalledWith("/input-1");
    await (await engine.createSession(file)).dispose();
  });

  it("retains the actual encoder failure before generic final log lines", async () => {
    const session = await engine.createSession(file);
    const ffmpeg = currentFfmpeg();
    vi.mocked(ffmpeg.exec).mockImplementationOnce(async () => {
      const { callbacks } = ffmpeg as unknown as {
        callbacks: Map<string, (event: unknown) => void>;
      };
      callbacks.get("log")?.({ message: "[aac] Unsupported channel layout" });
      callbacks.get("log")?.({ message: "Conversion failed!" });
      callbacks.get("log")?.({ message: "Aborted()" });
      return 1;
    });
    await expect(session.transcode(() => ["output.mp4"], "output.mp4")).rejects.toThrow(
      "Unsupported channel layout"
    );
    expect(ffmpeg.deleteFile).toHaveBeenCalledWith("output.mp4");
    await session.dispose();
  });

  it("rejects empty output instead of reporting a successful download", async () => {
    const session = await engine.createSession(file);
    const ffmpeg = currentFfmpeg();
    vi.mocked(ffmpeg.readFile).mockResolvedValueOnce(new Uint8Array());
    await expect(session.transcode(() => ["output.mp4"], "output.mp4")).rejects.toThrow(
      "empty output"
    );
    await session.dispose();
  });
});
