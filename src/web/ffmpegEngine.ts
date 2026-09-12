import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { isBrowserFileSizeSupported, MAX_BROWSER_INPUT_LABEL } from "./webMedia";

export type FfmpegProgressEvent = {
  progress: number;
  time: number;
};

export type FfmpegProgressHandler = (event: FfmpegProgressEvent) => void;

export type BrowserFfmpegSession = {
  prepareFile: (
    argsForInput: (inputName: string) => string[],
    outputName: string,
    onProgress?: FfmpegProgressHandler
  ) => Promise<void>;
  transcode: (
    argsForInput: (inputName: string) => string[],
    outputName: string,
    onProgress?: FfmpegProgressHandler
  ) => Promise<Uint8Array<ArrayBuffer>>;
  run: (
    argsForInput: (inputName: string) => string[],
    onProgress?: FfmpegProgressHandler,
    onLog?: (message: string) => void,
    timeoutMs?: number
  ) => Promise<string>;
  dispose: () => Promise<void>;
};

type WasmSource = {
  url: string;
  cleanup: () => void;
};

function directWasmSource(): WasmSource {
  return { url: wasmURL, cleanup: () => undefined };
}

function isWasmBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  );
}

async function resolveWasmSource(signal: AbortSignal): Promise<WasmSource> {
  let response: Response;

  try {
    response = await fetch(`${wasmURL}.gz`, { cache: "force-cache", signal });
  } catch {
    signal.throwIfAborted();
    // Desktop builds keep the uncompressed asset, so a missing compressed
    // sibling is expected outside the hosted browser bundle.
    return directWasmSource();
  }

  if (!response.ok) return directWasmSource();

  const compressedBytes = new Uint8Array(await response.arrayBuffer());
  const isGzip = compressedBytes[0] === 0x1f && compressedBytes[1] === 0x8b;
  if (!isGzip && !isWasmBytes(compressedBytes)) return directWasmSource();
  const wasmBytes = isGzip
    ? await (async () => {
        if (typeof DecompressionStream === "undefined") {
          throw new Error("This browser cannot decompress the WebAssembly encoder bundle.");
        }

        const decompressedStream = new Blob([compressedBytes])
          .stream()
          .pipeThrough(new DecompressionStream("gzip"));
        return new Response(decompressedStream).arrayBuffer();
      })()
    : compressedBytes;
  signal.throwIfAborted();
  const blobURL = URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }));

  return {
    url: blobURL,
    cleanup: () => URL.revokeObjectURL(blobURL),
  };
}

function readBytes(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // FFmpeg normally transfers an ArrayBuffer from its worker. Keep a safe
  // fallback for runtimes backed by SharedArrayBuffer-like memory.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

function inputFileName(file: File, sequence: number): string {
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "mp4";
  return `input-${sequence}.${extension}`;
}

export class BrowserFfmpegEngine {
  private ffmpeg: FFmpeg | null = null;

  private loading: Promise<void> | null = null;

  private loadGeneration = 0;

  private loadController: AbortController | null = null;

  private sessionOwner: symbol | null = null;

  private sequence = 0;

  private operationProgressHandler: FfmpegProgressHandler | null = null;

  private logBuffer = "";

  private runLogHandler: ((message: string) => void) | null = null;

  private readonly handleProgress = ({ progress, time }: FfmpegProgressEvent) => {
    const event = {
      progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0,
      time: Number.isFinite(time) ? Math.max(0, time) : Number.NaN,
    };
    this.operationProgressHandler?.(event);
  };

  private readonly handleLog = ({ message }: { message: string }) => {
    this.runLogHandler?.(message);
    this.logBuffer = `${this.logBuffer}\n${message}`.slice(-32_000);
  };

  get isLoaded(): boolean {
    return this.ffmpeg?.loaded === true;
  }

  async load(): Promise<void> {
    if (this.ffmpeg?.loaded) return;
    if (this.loading) return this.loading;

    const ffmpeg = new FFmpeg();
    ffmpeg.on("progress", this.handleProgress);
    ffmpeg.on("log", this.handleLog);
    this.ffmpeg = ffmpeg;
    const loadGeneration = this.loadGeneration;
    const controller = new AbortController();
    this.loadController = controller;
    const timeout = setTimeout(() => {
      controller.abort(new Error("The browser encoder took too long to load. Please retry."));
      ffmpeg.terminate();
    }, 120_000);
    this.loading = (async () => {
      let wasmSource: WasmSource | null = null;

      try {
        wasmSource = await resolveWasmSource(controller.signal);
        if (this.loadGeneration !== loadGeneration || this.ffmpeg !== ffmpeg) {
          ffmpeg.terminate();
          throw new Error("The browser encoder load was cancelled.");
        }
        await ffmpeg.load({ coreURL, wasmURL: wasmSource.url }, { signal: controller.signal });
        controller.signal.throwIfAborted();
      } catch (error: unknown) {
        if (this.ffmpeg === ffmpeg) this.ffmpeg = null;
        ffmpeg.terminate();
        throw new Error(
          `The browser encoder could not start: ${String(controller.signal.reason ?? error)}`
        );
      } finally {
        clearTimeout(timeout);
        wasmSource?.cleanup();
        if (this.loadGeneration === loadGeneration) {
          this.loading = null;
          this.loadController = null;
        }
      }
    })();
    return this.loading;
  }

  async createSession(file: File): Promise<BrowserFfmpegSession> {
    if (!isBrowserFileSizeSupported(file)) {
      throw new Error(`Browser exports support video files up to ${MAX_BROWSER_INPUT_LABEL}.`);
    }
    if (this.sessionOwner) throw new Error("The browser encoder is busy.");
    const owner = Symbol("browser export session");
    this.sessionOwner = owner;
    const operationGeneration = this.loadGeneration;
    try {
      await this.load();
    } catch (error: unknown) {
      if (this.sessionOwner === owner) this.sessionOwner = null;
      throw error;
    }
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg || this.loadGeneration !== operationGeneration) {
      if (this.sessionOwner === owner) this.sessionOwner = null;
      throw new Error("Export cancelled.");
    }

    const sequence = ++this.sequence;
    const mountPoint = `/input-${sequence}`;
    const name = inputFileName(file, sequence);
    const inputName = `${mountPoint}/${name}`;
    let mounted = false;
    const cleanupInput = async () => {
      if (mounted) await ffmpeg.unmount(mountPoint).catch(() => false);
      await ffmpeg.deleteDir(mountPoint).catch(() => false);
      if (this.sessionOwner === owner) this.sessionOwner = null;
    };
    try {
      this.assertActive(ffmpeg, operationGeneration);
      await ffmpeg.createDir(mountPoint);
      mounted = await ffmpeg.mount(
        FFFSType.WORKERFS,
        { blobs: [{ name, data: file }] },
        mountPoint
      );
      if (!mounted) throw new Error("The browser encoder could not open this video.");
      this.assertActive(ffmpeg, operationGeneration);
    } catch (error: unknown) {
      await cleanupInput();
      throw error;
    }

    let disposed = false;
    const preparedFiles = new Set<string>();
    const ensureActive = () => {
      if (disposed) throw new Error("Export session closed.");
      this.assertActive(ffmpeg, operationGeneration);
    };

    const transcode = async (
      argsForInput: (inputName: string) => string[],
      outputName: string,
      onProgress?: FfmpegProgressHandler
    ): Promise<Uint8Array<ArrayBuffer>> => {
      ensureActive();
      this.logBuffer = "";
      this.runLogHandler = null;
      try {
        this.operationProgressHandler = onProgress ?? null;
        const exitCode = await ffmpeg.exec(argsForInput(inputName));
        ensureActive();
        if (exitCode !== 0) {
          throw new Error(
            `FFmpeg stopped with exit code ${exitCode}.\n${this.logBuffer.slice(-4000)}`
          );
        }
        const bytes = readBytes(await ffmpeg.readFile(outputName));
        ensureActive();
        if (bytes.byteLength === 0) throw new Error("FFmpeg produced an empty output file.");
        return bytes;
      } catch (error: unknown) {
        ensureActive();
        throw error;
      } finally {
        if (this.ffmpeg === ffmpeg) {
          this.operationProgressHandler = null;
          this.runLogHandler = null;
        }
        await ffmpeg.deleteFile(outputName).catch(() => false);
      }
    };

    const run = async (
      argsForInput: (inputName: string) => string[],
      onProgress?: FfmpegProgressHandler,
      onLog?: (message: string) => void,
      timeoutMs = -1
    ): Promise<string> => {
      ensureActive();
      this.logBuffer = "";
      try {
        this.runLogHandler = onLog ?? null;
        this.operationProgressHandler = onProgress ?? null;
        const exitCode = await ffmpeg.exec(argsForInput(inputName), timeoutMs);
        ensureActive();
        if (exitCode !== 0) {
          throw new Error(
            `FFmpeg stopped with exit code ${exitCode}.\n${this.logBuffer.slice(-4000)}`
          );
        }
        return this.logBuffer;
      } catch (error: unknown) {
        ensureActive();
        throw error;
      } finally {
        if (this.ffmpeg === ffmpeg) {
          this.operationProgressHandler = null;
          this.runLogHandler = null;
        }
      }
    };

    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      if (this.ffmpeg === ffmpeg) {
        this.operationProgressHandler = null;
        this.runLogHandler = null;
      }
      await Promise.all(
        [...preparedFiles].map((path) => ffmpeg.deleteFile(path).catch(() => false))
      );
      await cleanupInput();
    };

    const prepareFile: BrowserFfmpegSession["prepareFile"] = async (
      argsForInput,
      outputName,
      onProgress
    ) => {
      preparedFiles.add(outputName);
      await run(argsForInput, onProgress);
    };

    return { transcode, run, prepareFile, dispose };
  }

  async transcode(
    file: File,
    argsForInput: (inputName: string) => string[],
    outputName: string,
    onProgress?: FfmpegProgressHandler
  ): Promise<Uint8Array<ArrayBuffer>> {
    const session = await this.createSession(file);
    try {
      return await session.transcode(argsForInput, outputName, onProgress);
    } finally {
      await session.dispose();
    }
  }

  async run(
    file: File,
    argsForInput: (inputName: string) => string[],
    onProgress?: FfmpegProgressHandler,
    onLog?: (message: string) => void,
    timeoutMs = -1
  ): Promise<string> {
    const session = await this.createSession(file);
    try {
      return await session.run(argsForInput, onProgress, onLog, timeoutMs);
    } finally {
      await session.dispose();
    }
  }

  private assertActive(ffmpeg: FFmpeg, operationGeneration: number): void {
    if (this.loadGeneration !== operationGeneration || this.ffmpeg !== ffmpeg || !ffmpeg.loaded) {
      throw new Error("Export cancelled.");
    }
  }

  cancel(): void {
    this.loadGeneration += 1;
    this.loadController?.abort(new Error("Export cancelled."));
    this.loadController = null;
    this.loading = null;
    this.sessionOwner = null;
    this.operationProgressHandler = null;
    this.runLogHandler = null;
    if (!this.ffmpeg) return;
    this.ffmpeg.off("progress", this.handleProgress);
    this.ffmpeg.off("log", this.handleLog);
    this.ffmpeg.terminate();
    this.ffmpeg = null;
  }

  dispose(): void {
    this.cancel();
  }
}
