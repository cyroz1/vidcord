import { memo } from "react";
import ProgressSection from "./ProgressSection";
import type { CompletionAction, OutputDestination } from "../hooks/useSettings";

type Props = {
  outputDestination: OutputDestination;
  customOutputDirectory: string;
  completionAction: CompletionAction;
  exportSummary: string;
  readyActionLabel: string;
  showProgress: boolean;
  compressing: boolean;
  cancelling: boolean;
  finalizingOutput: boolean;
  ffmpegMissing: boolean;
  losslessTrim: boolean;
  losslessInfoLoading: boolean;
  filePath: string | null;
  probeReady: boolean;
  progress: number;
  eta: string;
  onOutputDestinationChange: (destination: OutputDestination) => void;
  onChooseCustomOutputDirectory: () => void;
  onCompletionActionChange: (action: CompletionAction) => void;
  onStartCompression: () => void;
  onCancelCompression: () => void;
};

function ExportSection({
  outputDestination,
  customOutputDirectory,
  completionAction,
  exportSummary,
  readyActionLabel,
  showProgress,
  compressing,
  cancelling,
  finalizingOutput,
  ffmpegMissing,
  losslessTrim,
  losslessInfoLoading,
  filePath,
  probeReady,
  progress,
  eta,
  onOutputDestinationChange,
  onChooseCustomOutputDirectory,
  onCompletionActionChange,
  onStartCompression,
  onCancelCompression,
}: Props) {
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

        <div className="output-option">
          <label htmlFor="completion-action-select">After export</label>
          <select
            id="completion-action-select"
            value={completionAction}
            onChange={(event) =>
              onCompletionActionChange(event.target.value as CompletionAction)
            }
          >
            <option value="copy">Copy file</option>
            <option value="reveal">Show in folder</option>
          </select>
        </div>
      </div>

      {!showProgress && (
        <div className="export-summary" aria-label="Export summary">
          {exportSummary}
        </div>
      )}

      <button
        className={`compress-btn${compressing ? " cancel" : ""}`}
        onClick={compressing ? onCancelCompression : onStartCompression}
        disabled={
          ffmpegMissing ||
          cancelling ||
          finalizingOutput ||
          (!compressing && losslessTrim && losslessInfoLoading) ||
          (!compressing && (!filePath || !probeReady))
        }
      >
        {cancelling
          ? "Cancelling..."
          : finalizingOutput
            ? "Saving Output..."
            : compressing
              ? "Cancel"
              : readyActionLabel}
      </button>

      {showProgress && <ProgressSection progress={progress} eta={eta} />}
    </>
  );
}

export default memo(ExportSection);
