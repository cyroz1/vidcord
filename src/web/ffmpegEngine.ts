import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

export type FfmpegProgressHandler = (progress: number) => void;

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

  private sequence = 0;

  private progressHandler: FfmpegProgressHandler | null = null;

  private lastLog = "";

  private readonly handleProgress = ({ progress }: { progress: number }) => {
    this.progressHandler?.(Math.max(0, Math.min(1, progress)));
  };

  private readonly handleLog = ({ message }: { message: string }) => {
    this.lastLog = message.trim().slice(-500);
  };

  get isLoaded(): boolean {
    return this.ffmpeg?.loaded === true;
  }

  setProgressHandler(handler: FfmpegProgressHandler | null): void {
    this.progressHandler = handler;
  }

  async load(): Promise<void> {
    if (this.ffmpeg?.loaded) return;
    if (this.loading) return this.loading;

    const ffmpeg = new FFmpeg();
    ffmpeg.on("progress", this.handleProgress);
    ffmpeg.on("log", this.handleLog);
    this.ffmpeg = ffmpeg;
    this.loading = ffmpeg
      .load({ coreURL, wasmURL })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.ffmpeg = null;
        throw new Error(`The browser encoder could not start: ${String(error)}`);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async transcode(
    file: File,
    argsForInput: (inputName: string) => string[],
    outputName: string
  ): Promise<Uint8Array<ArrayBuffer>> {
    await this.load();
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) throw new Error("The browser encoder is not available.");

    const sequence = ++this.sequence;
    const inputName = inputFileName(file, sequence);
    const inputData = await fetchFile(file);
    this.lastLog = "";
    await ffmpeg.writeFile(inputName, inputData);

    try {
      const exitCode = await ffmpeg.exec(argsForInput(inputName));
      if (exitCode !== 0) {
        const detail = this.lastLog ? ` ${this.lastLog}` : "";
        throw new Error(`FFmpeg stopped with exit code ${exitCode}.${detail}`);
      }
      return readBytes(await ffmpeg.readFile(outputName));
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => false);
      await ffmpeg.deleteFile(outputName).catch(() => false);
    }
  }

  cancel(): void {
    if (!this.ffmpeg) return;
    this.ffmpeg.off("progress", this.handleProgress);
    this.ffmpeg.off("log", this.handleLog);
    this.ffmpeg.terminate();
    this.ffmpeg = null;
    this.loading = null;
  }

  dispose(): void {
    this.cancel();
    this.progressHandler = null;
  }
}
