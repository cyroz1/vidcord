import type {
  BrowserFfmpegEngine,
  BrowserFfmpegSession,
  FfmpegProgressHandler,
} from "./ffmpegEngine";
import {
  buildCompressionArgs,
  buildAudioPeakAnalysisArgs,
  buildGifArgs,
  buildGifPaletteArgs,
  buildLosslessArgs,
  createExportPlan,
  getFillBitrate,
  getRetryBitrate,
  outputFileName,
  parsePeakNormalizationGain,
  type ExportPlan,
} from "./exportPlan";
import { progressFromMediaTime } from "./browserProgress";
import type { BrowserVideoMetadata } from "./webMedia";
import type { BrowserMode, BrowserSettings } from "./webSettings";

const SIZE_SAMPLE_MIN_DURATION_SECONDS = 120;
const SIZE_SAMPLE_DURATION_SECONDS = 4;
const GIF_SAMPLE_MIN_DURATION_SECONDS = 30;
const GIF_SAMPLE_DURATION_SECONDS = 1;
const SIZE_SAMPLE_SAFETY_MARGIN = 1.03;
const SIZE_REFINE_RATIO = 0.95;
const SIZE_UNDERSIZE_RETRY_LIMIT = 2;

export type ExportProgressSegment = {
  /** Overall progress where the current operation starts (0-1). */
  start: number;
  /** Overall progress where the current operation ends (0-1). */
  end: number;
};

export type ExportProgressHandler = (
  progress: number,
  status: string,
  segment?: ExportProgressSegment
) => void;

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
  // Match the failing audio line, not an unrelated video failure next to the
  // input's ordinary audio-stream description in the diagnostic log.
  return message
    .toLowerCase()
    .split("\n")
    .some(
      (line) =>
        /audio|aac|loudnorm|volumedetect|0:a|channel|sample.?fmt/.test(line) &&
        /error|failed|fail|invalid|unsupported|unknown|missing|unavailable|could not|cannot|not found|no such filter/.test(
          line
        )
    );
}

function operationProgressHandler(
  onProgress: ExportProgressHandler | undefined,
  start: number,
  end: number,
  status: string,
  durationSeconds: number,
  fullDurationSeconds?: number
): FfmpegProgressHandler {
  let lastProgress = 0;
  return ({ progress, time }) => {
    const safeProgress = progressFromMediaTime(
      time,
      durationSeconds,
      progress,
      fullDurationSeconds
    );
    const monotonicProgress = Math.max(lastProgress, safeProgress);
    lastProgress = monotonicProgress;
    onProgress?.(start + (end - start) * monotonicProgress, status, { start, end });
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
  // Keep user-facing filenames out of FFmpeg's option parser and virtual FS.
  const encodedName = `output.${plan.outputExtension}`;

  const engineWithSession = engine as BrowserFfmpegEngine & {
    createSession?: (file: File) => Promise<BrowserFfmpegSession>;
  };
  let session: BrowserFfmpegSession | null = null;

  try {
    const createSession = engineWithSession.createSession;
    if (typeof createSession === "function") {
      session = await createSession.call(engine, file);
    }

    const transcodeFile = (
      argsForInput: (inputName: string) => string[],
      outputName: string,
      progressHandler?: FfmpegProgressHandler
    ) =>
      session
        ? session.transcode(argsForInput, outputName, progressHandler)
        : engine.transcode(file, argsForInput, outputName, progressHandler);
    const runFile = (
      argsForInput: (inputName: string) => string[],
      progressHandler?: FfmpegProgressHandler,
      logHandler?: (message: string) => void
    ) =>
      session
        ? session.run(argsForInput, progressHandler, logHandler)
        : engine.run(file, argsForInput, progressHandler, logHandler);

    if (mode === "lossless") {
      onProgress?.(0, "Encoding lossless trim…", { start: 0, end: 1 });
      let bytes = await transcodeFile(
        (inputName) =>
          buildLosslessArgs(
            inputName,
            encodedName,
            plan.startTime,
            plan.endTime,
            settings.removeAudio
          ),
        encodedName,
        operationProgressHandler(
          onProgress,
          0,
          1,
          "Encoding lossless trim…",
          plan.selectedDuration,
          metadata.duration
        )
      );
      onProgress?.(1, "Finishing export…", { start: 0, end: 1 });
      const outputBytes = bytes.byteLength;
      const blob = new Blob([bytes], { type: extensionMimeType(plan.outputExtension) });
      bytes = new Uint8Array();
      return {
        blob,
        fileName: baseName,
        bytes: outputBytes,
        wasOversized: false,
        normalizationSkipped: false,
        audioRemovedForCompatibility: false,
      };
    }

    const maximumAttempts = mode === "gif" ? 4 : plan.targetSizeMb === null ? 1 : 4;
    let bitrate = plan.bitrateKbps;
    let audioGainDb: number | null = null;
    let normalizationSkipped = false;
    let audioRemovedForCompatibility = false;
    let bestBytes: Uint8Array<ArrayBuffer> | null = null;
    let bestNormalizationSkipped = false;
    let bestAudioRemovedForCompatibility = false;
    let smallestOversizeBytes: number | null = null;
    let undersizeRetries = 0;
    let lastOversizedBytes: Uint8Array<ArrayBuffer> | null = null;

    const shouldAnalyzeAudio =
      settings.audioNormalize && !settings.removeAudio && metadata.hasAudio && mode !== "gif";
    const canDropAudio = mode !== "gif" && !settings.removeAudio && metadata.hasAudio;
    const analysisEnd = shouldAnalyzeAudio ? 0.12 : 0;
    const preflightDuration =
      mode === "gif" ? GIF_SAMPLE_DURATION_SECONDS : SIZE_SAMPLE_DURATION_SECONDS;
    const shouldRunSizePreflight =
      plan.targetSizeMb !== null &&
      bitrate !== null &&
      plan.selectedDuration >=
        (mode === "gif" ? GIF_SAMPLE_MIN_DURATION_SECONDS : SIZE_SAMPLE_MIN_DURATION_SECONDS);
    const preflightSpan = shouldRunSizePreflight ? 0.06 : 0;
    const encodingSpan = 1 - analysisEnd - preflightSpan;

    if (shouldAnalyzeAudio) {
      onProgress?.(0, "Analyzing audio peak…", { start: 0, end: analysisEnd });
      try {
        const analysisLog = await runFile(
          (inputName) => buildAudioPeakAnalysisArgs(inputName, plan),
          operationProgressHandler(
            onProgress,
            0,
            analysisEnd,
            "Analyzing audio peak…",
            plan.selectedDuration,
            metadata.duration
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
      onProgress?.(analysisEnd, "Preparing encoder…", { start: analysisEnd, end: 1 });
    }

    if (shouldRunSizePreflight && bitrate !== null && plan.targetSizeMb !== null) {
      const sampleDuration = Math.min(preflightDuration, plan.selectedDuration);
      const samplePlan: ExportPlan = {
        ...plan,
        endTime: plan.startTime + sampleDuration,
        selectedDuration: sampleDuration,
      };
      const preflightStart = analysisEnd;
      const preflightEnd = preflightStart + preflightSpan;
      const sampleOutputName = mode === "gif" ? "size-sample.gif" : "size-sample.mp4";
      const sampleProgress = operationProgressHandler(
        onProgress,
        preflightStart,
        preflightEnd,
        "Estimating output size…",
        sampleDuration,
        metadata.duration
      );

      onProgress?.(preflightStart, "Estimating output size…", {
        start: preflightStart,
        end: preflightEnd,
      });
      let sizeAdjusted = false;
      try {
        let paletteName: string | undefined;
        if (mode === "gif" && session?.prepareFile) {
          paletteName = "size-sample-palette.png";
          const paletteEnd = preflightStart + preflightSpan * 0.35;
          await session.prepareFile(
            (inputName) =>
              buildGifPaletteArgs(inputName, paletteName!, metadata, settings, samplePlan, bitrate),
            paletteName,
            operationProgressHandler(
              onProgress,
              preflightStart,
              paletteEnd,
              "Estimating GIF size…",
              sampleDuration,
              metadata.duration
            )
          );
        }

        const sampleBytes = await transcodeFile(
          (inputName) =>
            mode === "gif"
              ? buildGifArgs(
                  inputName,
                  sampleOutputName,
                  metadata,
                  settings,
                  samplePlan,
                  plan.targetHeight ?? 480,
                  bitrate,
                  paletteName
                )
              : buildCompressionArgs(
                  inputName,
                  sampleOutputName,
                  metadata,
                  settings,
                  samplePlan,
                  bitrate,
                  audioGainDb
                ),
          sampleOutputName,
          sampleProgress
        );
        const projectedBytes = Math.ceil(
          (sampleBytes.byteLength * plan.selectedDuration * SIZE_SAMPLE_SAFETY_MARGIN) /
            sampleDuration
        );
        const targetBytes = plan.targetSizeMb * 1024 * 1024;
        const adjustedBitrate =
          projectedBytes > targetBytes
            ? getRetryBitrate(bitrate, projectedBytes, plan.targetSizeMb)
            : getFillBitrate(bitrate, projectedBytes, plan.targetSizeMb, plan.sourceBitrateKbps);
        if (adjustedBitrate !== bitrate) {
          bitrate = adjustedBitrate;
          sizeAdjusted = true;
        }
      } catch (error: unknown) {
        if (String(error).toLowerCase().includes("cancel")) throw error;
      }
      onProgress?.(
        preflightEnd,
        sizeAdjusted
          ? "Starting full export with an adjusted size estimate…"
          : "Starting full export…",
        {
          start: preflightStart,
          end: preflightEnd,
        }
      );
    }

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const attemptLabel = maximumAttempts > 1 ? ` · pass ${attempt + 1}/${maximumAttempts}` : "";
      const attemptStart = analysisEnd + preflightSpan + (encodingSpan * attempt) / maximumAttempts;
      const attemptEnd =
        analysisEnd + preflightSpan + (encodingSpan * (attempt + 1)) / maximumAttempts;
      const encodingStatus =
        mode === "gif" ? `Rendering GIF${attemptLabel}` : `Encoding${attemptLabel}`;
      onProgress?.(attemptStart, encodingStatus, { start: attemptStart, end: attemptEnd });
      const outputName = `${attempt}-${encodedName}`;
      let paletteName: string | undefined;
      let renderStart = attemptStart;
      if (mode === "gif" && session?.prepareFile) {
        paletteName = `palette-${attempt}.png`;
        renderStart = attemptStart + (attemptEnd - attemptStart) * 0.4;
        // A separate palette pass avoids buffering the entire decoded clip
        // behind palettegen's end-of-stream output in a split filter graph.
        await session.prepareFile(
          (inputName) =>
            buildGifPaletteArgs(inputName, paletteName!, metadata, settings, plan, bitrate),
          paletteName,
          operationProgressHandler(
            onProgress,
            attemptStart,
            renderStart,
            `Building GIF palette${attemptLabel}`,
            plan.selectedDuration,
            metadata.duration
          )
        );
      }
      const transcode = (encodeSettings: BrowserSettings, gainDb: number | null) =>
        transcodeFile(
          (inputName) =>
            mode === "gif"
              ? buildGifArgs(
                  inputName,
                  outputName,
                  metadata,
                  encodeSettings,
                  plan,
                  plan.targetHeight ?? 480,
                  bitrate,
                  paletteName
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
            renderStart,
            attemptEnd,
            encodingStatus,
            plan.selectedDuration,
            metadata.duration
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
            onProgress?.(attemptStart, "Audio normalization unavailable; retrying export…", {
              start: attemptStart,
              end: attemptEnd,
            });
            continue;
          }

          if (canDropAudio && audioCompatibilityFailure && !audioRemovedForCompatibility) {
            audioRemovedForCompatibility = true;
            onProgress?.(attemptStart, "Audio track unavailable; retrying video-only export…", {
              start: attemptStart,
              end: attemptEnd,
            });
            continue;
          }

          if (bestBytes) {
            bytes = bestBytes;
            break;
          }

          throw error;
        }
      }
      onProgress?.(attemptEnd, "Checking output size…", { start: attemptStart, end: attemptEnd });

      if (isTargetMet(bytes.byteLength, plan.targetSizeMb)) {
        lastOversizedBytes = null;
        const improved = bestBytes === null || bytes.byteLength > bestBytes.byteLength;
        if (improved) {
          bestBytes = bytes;
          bestNormalizationSkipped = normalizationSkipped;
          bestAudioRemovedForCompatibility = audioRemovedForCompatibility;
        }

        if (
          improved &&
          mode !== "gif" &&
          bitrate !== null &&
          plan.targetSizeMb !== null &&
          undersizeRetries < SIZE_UNDERSIZE_RETRY_LIMIT &&
          attempt + 1 < maximumAttempts &&
          bytes.byteLength < plan.targetSizeMb * 1024 * 1024 * SIZE_REFINE_RATIO
        ) {
          const nextBitrate = getFillBitrate(
            bitrate,
            bytes.byteLength,
            plan.targetSizeMb,
            plan.sourceBitrateKbps
          );
          if (nextBitrate > bitrate) {
            bitrate = nextBitrate;
            undersizeRetries += 1;
            continue;
          }
        }
        break;
      }

      if (bitrate !== null && plan.targetSizeMb !== null) {
        lastOversizedBytes = bytes;
        smallestOversizeBytes =
          smallestOversizeBytes === null
            ? bytes.byteLength
            : Math.min(smallestOversizeBytes, bytes.byteLength);
        const nextBitrate = getRetryBitrate(bitrate, bytes.byteLength, plan.targetSizeMb);
        if (nextBitrate >= bitrate || attempt + 1 >= maximumAttempts) break;
        bitrate = nextBitrate;
      } else {
        break;
      }
    }

    onProgress?.(1, "Finishing export…", { start: 0, end: 1 });
    if (bestBytes) {
      const outputBytes = bestBytes.byteLength;
      const blob = new Blob([bestBytes], { type: extensionMimeType(plan.outputExtension) });
      bestBytes = null;
      return {
        blob,
        fileName: baseName,
        bytes: outputBytes,
        wasOversized: false,
        normalizationSkipped: bestNormalizationSkipped,
        audioRemovedForCompatibility: bestAudioRemovedForCompatibility,
      };
    }
    if (mode === "gif" && lastOversizedBytes) {
      const outputBytes = lastOversizedBytes.byteLength;
      const blob = new Blob([lastOversizedBytes], {
        type: extensionMimeType(plan.outputExtension),
      });
      return {
        blob,
        fileName: baseName,
        bytes: outputBytes,
        wasOversized: true,
        normalizationSkipped,
        audioRemovedForCompatibility,
      };
    }
    if (plan.targetSizeMb !== null && smallestOversizeBytes !== null) {
      throw new Error(
        `Could not reach the selected ${plan.targetSizeMb} MB target. The smallest attempt was ${(smallestOversizeBytes / (1024 * 1024)).toFixed(2)} MB.`
      );
    }
    throw new Error("The video export did not produce an output file.");
  } finally {
    if (session) await session.dispose().catch(() => undefined);
  }
}
