import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { isBrowserFileSizeSupported, MAX_BROWSER_INPUT_LABEL } from "./webMedia";

export type FfmpegProgressEvent = {
  progress: number;
  time: number;
};

export type FfmpegProgressHandler = (event: FfmpegProgressEvent) => void;

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

async function resolveWasmSource(): Promise<WasmSource> {
  let response: Response;

  try {
    response = await fetch(`${wasmURL}.gz`, { cache: "force-cache" });
  } catch {
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
  const blobURL = URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }));

  return {
    url: blobURL,
    cleanup: () => URL.revokeObjectURL(blobURL),
  };
}

function readBytes(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const source = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
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

  private sequence = 0;

  private operationProgressHandler: FfmpegProgressHandler | null = null;

  private lastLog = "";

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
    this.lastLog = message.trim().slice(-500);
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
    this.loading = (async () => {
      let wasmSource: WasmSource | null = null;

      try {
        wasmSource = await resolveWasmSource();
        if (this.loadGeneration !== loadGeneration || this.ffmpeg !== ffmpeg) {
          ffmpeg.terminate();
          throw new Error("The browser encoder load was cancelled.");
        }
        await ffmpeg.load({ coreURL, wasmURL: wasmSource.url });
      } catch (error: unknown) {
        if (this.ffmpeg === ffmpeg) this.ffmpeg = null;
        ffmpeg.terminate();
        throw new Error(`The browser encoder could not start: ${String(error)}`);
      } finally {
        wasmSource?.cleanup();
        if (this.loadGeneration === loadGeneration) this.loading = null;
      }
    })();
    return this.loading;
  }

  async transcode(
    file: File,
    argsForInput: (inputName: string) => string[],
    outputName: string,
    onProgress?: FfmpegProgressHandler
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!isBrowserFileSizeSupported(file)) {
      throw new Error(`Browser exports support video files up to ${MAX_BROWSER_INPUT_LABEL}.`);
    }
    await this.load();
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) throw new Error("The browser encoder is not available.");

    const sequence = ++this.sequence;
    const inputName = inputFileName(file, sequence);
    const inputData = await fetchFile(file);
    this.lastLog = "";
    this.logBuffer = "";
    this.runLogHandler = null;
    await ffmpeg.writeFile(inputName, inputData);

    try {
      this.operationProgressHandler = onProgress ?? null;
      const exitCode = await ffmpeg.exec(argsForInput(inputName));
      if (exitCode !== 0) {
        const detail = this.lastLog ? ` ${this.lastLog}` : "";
        throw new Error(`FFmpeg stopped with exit code ${exitCode}.${detail}`);
      }
      return readBytes(await ffmpeg.readFile(outputName));
    } finally {
      this.operationProgressHandler = null;
      this.runLogHandler = null;
      await ffmpeg.deleteFile(inputName).catch(() => false);
      await ffmpeg.deleteFile(outputName).catch(() => false);
    }
  }

  async run(
    file: File,
    argsForInput: (inputName: string) => string[],
    onProgress?: FfmpegProgressHandler,
    onLog?: (message: string) => void
  ): Promise<string> {
    if (!isBrowserFileSizeSupported(file)) {
      throw new Error(`Browser exports support video files up to ${MAX_BROWSER_INPUT_LABEL}.`);
    }
    await this.load();
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) throw new Error("The browser encoder is not available.");

    const sequence = ++this.sequence;
    const inputName = inputFileName(file, sequence);
    const inputData = await fetchFile(file);
    this.lastLog = "";
    this.logBuffer = "";
    const operationGeneration = this.loadGeneration;
    await ffmpeg.writeFile(inputName, inputData);

    try {
      this.runLogHandler = onLog ?? null;
      this.operationProgressHandler = onProgress ?? null;
      const exitCode = await ffmpeg.exec(argsForInput(inputName));
      if (this.loadGeneration !== operationGeneration) {
        throw new Error("Export cancelled.");
      }
      if (exitCode !== 0) {
        const detail = this.lastLog ? ` ${this.lastLog}` : "";
        throw new Error(`FFmpeg stopped with exit code ${exitCode}.${detail}`);
      }
      return this.logBuffer;
    } catch (error: unknown) {
      if (this.loadGeneration !== operationGeneration) throw new Error("Export cancelled.");
      throw error;
    } finally {
      this.operationProgressHandler = null;
      this.runLogHandler = null;
      await ffmpeg.deleteFile(inputName).catch(() => false);
    }
  }

  cancel(): void {
    this.loadGeneration += 1;
    this.operationProgressHandler = null;
    this.runLogHandler = null;
    if (!this.ffmpeg) return;
    this.ffmpeg.off("progress", this.handleProgress);
    this.ffmpeg.off("log", this.handleLog);
    this.ffmpeg.terminate();
    this.ffmpeg = null;
    this.loading = null;
  }

  dispose(): void {
    this.cancel();
  }
}
