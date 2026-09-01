import { BrowserFfmpegEngine, type FfmpegProgressHandler } from "./ffmpegEngine";
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
import { progressFromMediaTime } from "./browserProgress";
import type { BrowserVideoMetadata } from "./webMedia";
import type { BrowserMode, BrowserSettings } from "./webSettings";

export type ExportProgressHandler = (progress: number, status: string) => void;

export type BrowserExportResult = {
  blob: Blob;
  fileName: string;
  bytes: number;
  wasOversized: boolean;
  normalizationSkipped: boolean;
  audioRemovedForCompatibility: boolean;
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

export function isAudioCompatibilityError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /audio|aac|loudnorm|volumedetect|0:a|channel|sample.?fmt|stream.?specifier/.test(normalized) &&
    /error|failed|fail|invalid|unsupported|unknown|missing|unavailable|could not|cannot|not found/.test(
      normalized
    )
  );
}

function operationProgressHandler(
  onProgress: ExportProgressHandler | undefined,
  start: number,
  end: number,
  status: string,
  durationSeconds: number
): FfmpegProgressHandler {
  let lastProgress = 0;
  return ({ progress, time }) => {
    const safeProgress = progressFromMediaTime(time, durationSeconds, progress);
    const monotonicProgress = Math.max(lastProgress, safeProgress);
    lastProgress = monotonicProgress;
    onProgress?.(start + (end - start) * monotonicProgress, status);
  };
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
    onProgress?.(0, "Encoding lossless trim…");
    const bytes = await engine.transcode(
      file,
      (inputName) =>
        buildLosslessArgs(inputName, baseName, plan.startTime, plan.endTime, settings.removeAudio),
      baseName,
      operationProgressHandler(onProgress, 0, 1, "Encoding lossless trim…", plan.selectedDuration)
    );
    onProgress?.(1, "Finishing export…");
    return {
      blob: new Blob([bytes], { type: extensionMimeType(plan.outputExtension) }),
      fileName: baseName,
      bytes: bytes.byteLength,
      wasOversized: false,
      normalizationSkipped: false,
      audioRemovedForCompatibility: false,
    };
  }

  const maximumAttempts = mode === "gif" ? 4 : plan.targetSizeMb === null ? 1 : 3;
  let bitrate = plan.bitrateKbps;
  let audioGainDb: number | null = null;
  let normalizationSkipped = false;
  let audioRemovedForCompatibility = false;
  let lastBytes: Uint8Array<ArrayBuffer> = new Uint8Array();

  const shouldAnalyzeAudio =
    settings.audioNormalize && !settings.removeAudio && metadata.hasAudio && mode !== "gif";
  const canDropAudio = mode !== "gif" && !settings.removeAudio && metadata.hasAudio;
  const analysisEnd = shouldAnalyzeAudio ? 0.12 : 0;
  const encodingSpan = 1 - analysisEnd;

  if (shouldAnalyzeAudio) {
    onProgress?.(0, "Analyzing audio peak…");
    try {
      const analysisLog = await engine.run(
        file,
        (inputName) => buildAudioPeakAnalysisArgs(inputName, plan),
        operationProgressHandler(
          onProgress,
          0,
          analysisEnd,
          "Analyzing audio peak…",
          plan.selectedDuration
        )
      );
      audioGainDb = parsePeakNormalizationGain(analysisLog);
    } catch (error: unknown) {
      if (String(error).toLowerCase().includes("cancel")) throw error;
      // Keep the export usable when a browser FFmpeg build cannot expose an
      // audio stream for analysis. The encode below will try loudnorm first,
      // then retry without an audio filter if that fallback is unavailable.
      audioGainDb = null;
    }
    onProgress?.(analysisEnd, "Preparing encoder…");
  }

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const attemptLabel = maximumAttempts > 1 ? ` · pass ${attempt + 1}/${maximumAttempts}` : "";
    const attemptStart = analysisEnd + (encodingSpan * attempt) / maximumAttempts;
    const attemptEnd = analysisEnd + (encodingSpan * (attempt + 1)) / maximumAttempts;
    const encodingStatus =
      mode === "gif" ? `Rendering GIF${attemptLabel}` : `Encoding${attemptLabel}`;
    onProgress?.(attemptStart, encodingStatus);
    const outputName = `${attempt}-${baseName}`;
    const transcode = (encodeSettings: BrowserSettings, gainDb: number | null) =>
      engine.transcode(
        file,
        (inputName) =>
          mode === "gif"
            ? buildGifArgs(
                inputName,
                outputName,
                metadata,
                encodeSettings,
                plan,
                plan.targetHeight ?? 480,
                bitrate
              )
            : buildCompressionArgs(
                inputName,
                outputName,
                metadata,
                encodeSettings,
                plan,
                bitrate,
                gainDb
              ),
        outputName,
        operationProgressHandler(
          onProgress,
          attemptStart,
          attemptEnd,
          encodingStatus,
          plan.selectedDuration
        )
      );
    let bytes: Uint8Array<ArrayBuffer>;
    while (true) {
      const encodeSettings = {
        ...settings,
        audioNormalize: normalizationSkipped ? false : settings.audioNormalize,
        removeAudio: audioRemovedForCompatibility || settings.removeAudio,
      };
      try {
        bytes = await transcode(
          encodeSettings,
          normalizationSkipped || audioRemovedForCompatibility ? null : audioGainDb
        );
        break;
      } catch (error: unknown) {
        const errorMessage = String(error).toLowerCase();
        if (errorMessage.includes("cancel")) throw error;
        const audioCompatibilityFailure = isAudioCompatibilityError(errorMessage);

        if (shouldAnalyzeAudio && audioCompatibilityFailure && !normalizationSkipped) {
          normalizationSkipped = true;
          onProgress?.(attemptStart, "Audio normalization unavailable; retrying export…");
          continue;
        }

        if (canDropAudio && audioCompatibilityFailure && !audioRemovedForCompatibility) {
          audioRemovedForCompatibility = true;
          onProgress?.(attemptStart, "Audio track unavailable; retrying video-only export…");
          continue;
        }

        throw error;
      }
    }
    lastBytes = bytes;
    onProgress?.(attemptEnd, "Checking output size…");

    if (isTargetMet(bytes.byteLength, plan.targetSizeMb)) {
      onProgress?.(1, "Finishing export…");
      return {
        blob: new Blob([bytes], { type: extensionMimeType(plan.outputExtension) }),
        fileName: baseName,
        bytes: bytes.byteLength,
        wasOversized: false,
        normalizationSkipped,
        audioRemovedForCompatibility,
      };
    }

    if (mode === "gif") {
      if (bitrate !== null && plan.targetSizeMb !== null) {
        bitrate = getRetryBitrate(bitrate, bytes.byteLength, plan.targetSizeMb);
      }
    } else if (bitrate !== null && plan.targetSizeMb !== null) {
      bitrate = getRetryBitrate(bitrate, bytes.byteLength, plan.targetSizeMb);
    }
  }

  onProgress?.(1, "Finishing export…");
  return {
    blob: new Blob([lastBytes], { type: extensionMimeType(plan.outputExtension) }),
    fileName: baseName,
    bytes: lastBytes.byteLength,
    wasOversized: true,
    normalizationSkipped,
    audioRemovedForCompatibility,
  };
}
