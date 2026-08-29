import { BrowserFfmpegEngine } from "./ffmpegEngine";
import {
  buildCompressionArgs,
  buildAudioPeakAnalysisArgs,
  buildGifArgs,
  buildLosslessArgs,
  createExportPlan,
  getRetryBitrate,
  outputFileName,
  parsePeakNormalizationGain,
} from "./exportPlan";
import type { BrowserVideoMetadata } from "./webMedia";
import type { BrowserMode, BrowserSettings } from "./webSettings";

export type ExportProgressHandler = (progress: number, status: string) => void;

export type BrowserExportResult = {
  blob: Blob;
  fileName: string;
  bytes: number;
  wasOversized: boolean;
};

function extensionMimeType(extension: string): string {
  if (extension === "gif") return "image/gif";
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  if (extension === "mkv") return "video/x-matroska";
  return "video/mp4";
}

function isTargetMet(bytes: number, targetSizeMb: number | null): boolean {
  return targetSizeMb === null || bytes <= targetSizeMb * 1024 * 1024;
}

export async function exportBrowserFile({
  engine,
  file,
  metadata,
  settings,
  mode,
  startTime,
  endTime,
  fileIndex = 0,
  onProgress,
}: {
  engine: BrowserFfmpegEngine;
  file: File;
  metadata: BrowserVideoMetadata;
  settings: BrowserSettings;
  mode: BrowserMode;
  startTime: number;
  endTime: number;
  fileIndex?: number;
  onProgress?: ExportProgressHandler;
}): Promise<BrowserExportResult> {
  const plan = createExportPlan(metadata, settings, mode, startTime, endTime);
  const baseName = outputFileName(file.name, plan.outputExtension, fileIndex);

  if (mode === "lossless") {
    onProgress?.(0, "Preparing stream copy…");
    const bytes = await engine.transcode(
      file,
      (inputName) => buildLosslessArgs(inputName, baseName, plan.startTime, plan.endTime),
      baseName
    );
    return {
      blob: new Blob([bytes], { type: extensionMimeType(plan.outputExtension) }),
      fileName: baseName,
      bytes: bytes.byteLength,
      wasOversized: false,
    };
  }

  const maximumAttempts = mode === "gif" ? 3 : plan.targetSizeMb === null ? 1 : 3;
  let bitrate = plan.bitrateKbps;
  let audioGainDb: number | null = null;
  let lastBytes: Uint8Array<ArrayBuffer> = new Uint8Array();
  let lastHeight = plan.targetHeight ?? 480;

  if (settings.audioNormalize && !settings.removeAudio && mode !== "gif") {
    onProgress?.(0, "Analyzing audio peak…");
    try {
      const analysisLog = await engine.run(file, (inputName) =>
        buildAudioPeakAnalysisArgs(inputName, plan)
      );
      audioGainDb = parsePeakNormalizationGain(analysisLog);
    } catch {
      // Keep the export usable when a browser FFmpeg build cannot expose an
      // audio stream for analysis. buildCompressionArgs uses loudnorm as the
      // compatibility fallback in that case.
      audioGainDb = null;
    }
  }

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const attemptLabel = maximumAttempts > 1 ? ` · pass ${attempt + 1}/${maximumAttempts}` : "";
    onProgress?.(
      attempt / maximumAttempts,
      mode === "gif" ? `Rendering GIF${attemptLabel}` : `Encoding${attemptLabel}`
    );
    const outputName = `${attempt}-${baseName}`;
    const bytes = await engine.transcode(
      file,
      (inputName) =>
        mode === "gif"
          ? buildGifArgs(inputName, outputName, metadata, settings, plan, lastHeight)
          : buildCompressionArgs(
              inputName,
              outputName,
              metadata,
              settings,
              plan,
              bitrate,
              audioGainDb
            ),
      outputName
    );
    lastBytes = bytes;
    onProgress?.((attempt + 1) / maximumAttempts, "Checking output size…");

    if (isTargetMet(bytes.byteLength, plan.targetSizeMb)) {
      return {
        blob: new Blob([bytes], { type: extensionMimeType(plan.outputExtension) }),
        fileName: baseName,
        bytes: bytes.byteLength,
        wasOversized: false,
      };
    }

    if (mode === "gif") {
      lastHeight = Math.max(240, Math.round(lastHeight * 0.72));
    } else if (bitrate !== null && plan.targetSizeMb !== null) {
      bitrate = getRetryBitrate(bitrate, bytes.byteLength, plan.targetSizeMb);
    }
  }

  return {
    blob: new Blob([lastBytes], { type: extensionMimeType(plan.outputExtension) }),
    fileName: baseName,
    bytes: lastBytes.byteLength,
    wasOversized: true,
  };
}
