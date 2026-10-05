import { memo } from "react";
import ProgressSection from "./ProgressSection";
import type { CompletionAction, OutputDestination } from "../hooks/useSettings";
import type { ImportScanProgress } from "../ipc";

type Props = {
  outputDestination: OutputDestination;
  customOutputDirectory: string;
  completionAction: CompletionAction;
  closeAppAfterExport: boolean;
  exportSummary: string;
  readyActionLabel: string;
  showProgress: boolean;
  compressing: boolean;
  cancelling: boolean;
  finalizingOutput: boolean;
  selectionScanning: boolean;
  selectionScanProgress: ImportScanProgress | null;
  ffmpegMissing: boolean;
  batchMode: boolean;
  batchReady: boolean;
  losslessTrim: boolean;
  losslessInfoLoading: boolean;
  filePath: string | null;
  probeReady: boolean;
  progress: number;
  eta: string;
  onOutputDestinationChange: (destination: OutputDestination) => void;
  onChooseCustomOutputDirectory: () => void;
  onCompletionActionChange: (action: CompletionAction) => void;
  onCloseAppAfterExportChange: (close: boolean) => void;
  onStartCompression: () => void;
  onCancelCompression: () => void;
};

function ExportSection({
  outputDestination,
  customOutputDirectory,
  completionAction,
  closeAppAfterExport,
  exportSummary,
  readyActionLabel,
  showProgress,
  compressing,
  cancelling,
  finalizingOutput,
  selectionScanning,
  selectionScanProgress,
  ffmpegMissing,
  batchMode,
  batchReady,
  losslessTrim,
  losslessInfoLoading,
  filePath,
  probeReady,
  progress,
  eta,
  onOutputDestinationChange,
  onChooseCustomOutputDirectory,
  onCompletionActionChange,
  onCloseAppAfterExportChange,
  onStartCompression,
  onCancelCompression,
}: Props) {
  const e2eDisabledReason = selectionScanning
    ? "selection-scanning"
    : ffmpegMissing
      ? "ffmpeg-missing"
      : cancelling
        ? "cancelling"
        : finalizingOutput
          ? "finalizing-output"
          : !compressing && losslessTrim && losslessInfoLoading
            ? "lossless-keyframes-loading"
            : !compressing && (batchMode ? !batchReady : !filePath || !probeReady)
              ? "missing-export-input"
              : "";

  return (
    <>
      <div className="output-options" aria-label="Output options">
        <div className="output-option">
          <label htmlFor="output-destination-select">Save to</label>
          <div className="output-select-row">
            <select
              id="output-destination-select"
              value={outputDestination}
              onChange={(event) =>
                onOutputDestinationChange(event.target.value as OutputDestination)
              }
            >
              <option value="downloads">Downloads</option>
              <option value="source">Clip folder</option>
              <option value="ask">Ask when done</option>
              <option value="custom">Custom folder</option>
            </select>
            {outputDestination === "custom" && (
              <button
                type="button"
                className="custom-folder-btn"
                title={customOutputDirectory || "Choose a custom output folder"}
                aria-label="Choose a custom output folder"
                onClick={onChooseCustomOutputDirectory}
              >
                {customOutputDirectory.split(/[\\/]/).filter(Boolean).pop() || "Choose"}
              </button>
            )}
          </div>
        </div>

        <div className="output-option output-completion-option">
          <label htmlFor="completion-action-select">After export</label>
          <div className="output-completion-controls">
            <select
              id="completion-action-select"
              value={completionAction}
              onChange={(event) => onCompletionActionChange(event.target.value as CompletionAction)}
            >
              <option value="copy">Copy file</option>
              <option value="reveal">Show in folder</option>
              <option value="none">Do nothing</option>
            </select>
            <label className="output-close-toggle" title="Close vidcord after a successful export">
              <input
                type="checkbox"
                checked={closeAppAfterExport}
                onChange={(event) => onCloseAppAfterExportChange(event.target.checked)}
              />
              Close app
            </label>
          </div>
        </div>
      </div>

      {!showProgress && (
        <div className="export-summary" aria-label="Export summary">
          {exportSummary}
        </div>
      )}

      {selectionScanning && (
        <div className="selection-scan-progress" role="status" aria-live="polite">
          {selectionScanProgress?.foldersScanned
            ? `Scanning folders · ${selectionScanProgress.itemsDiscovered} items found · ${selectionScanProgress.videosFound} videos found`
            : `Preparing selected files · ${selectionScanProgress?.itemsDiscovered ?? 0} items found`}
        </div>
      )}

      <button
        className={`compress-btn${compressing ? " cancel" : ""}`}
        data-e2e-disabled-reason={
          import.meta.env.VITE_VIDCORD_E2E === "1" ? e2eDisabledReason : undefined
        }
        onClick={compressing ? onCancelCompression : onStartCompression}
        disabled={
          selectionScanning ||
          ffmpegMissing ||
          cancelling ||
          finalizingOutput ||
          (!compressing && losslessTrim && losslessInfoLoading) ||
          (!compressing && (batchMode ? !batchReady : !filePath || !probeReady))
        }
      >
        {cancelling
          ? "Cancelling..."
          : finalizingOutput
            ? "Saving Output..."
            : compressing
              ? "Cancel"
              : selectionScanning
                ? selectionScanProgress?.foldersScanned
                  ? "Scanning Folder..."
                  : "Preparing..."
                : readyActionLabel}
      </button>

      {showProgress && <ProgressSection progress={progress} eta={eta} />}
    </>
  );
}

export default memo(ExportSection);
