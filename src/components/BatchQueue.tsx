import { memo } from "react";
import type { BatchQueueItem } from "../batchProcessing";

type Props = {
  items: readonly BatchQueueItem[];
  onRemoveItem: (id: number) => void;
  removeDisabled: boolean;
};

const STATUS_LABELS: Record<BatchQueueItem["status"], string> = {
  queued: "Queued",
  probing: "Reading details",
  encoding: "Encoding",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function BatchQueue({ items, onRemoveItem, removeDisabled }: Props) {
  const completed = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;

  return (
    <section className="batch-queue" aria-labelledby="batch-queue-title">
      <div className="batch-queue-heading">
        <div>
          <span className="section-kicker">Batch queue</span>
          <h2 id="batch-queue-title">{items.length} videos selected</h2>
        </div>
        <span className="batch-queue-count" aria-live="polite">
          {completed} complete{failed > 0 ? ` · ${failed} failed` : ""}
        </span>
      </div>
      <ol className="batch-queue-list">
        {items.map((item) => (
          <li className={`batch-queue-item ${item.status}`} key={item.id}>
            <span className="batch-queue-index" aria-hidden="true">
              {item.id + 1}
            </span>
            <span className="batch-queue-copy">
              <span className="batch-queue-name" title={item.inputPath}>
                {fileName(item.inputPath)}
              </span>
              {item.details && (
                <span className="batch-queue-details" title={item.details}>
                  {item.details}
                </span>
              )}
              <span className="batch-queue-status">
                {STATUS_LABELS[item.status]}
                {item.message && item.status === "failed" ? ` · ${item.message}` : ""}
              </span>
            </span>
            <span className="batch-queue-progress" aria-label={`${item.progress}% complete`}>
              {item.status === "completed"
                ? "✓"
                : item.status === "failed"
                  ? "!"
                  : item.status === "cancelled"
                    ? "–"
                    : `${Math.round(item.progress)}%`}
            </span>
            <button
              className="batch-queue-remove"
              type="button"
              onClick={() => onRemoveItem(item.id)}
              disabled={removeDisabled}
              aria-label={`Remove ${fileName(item.inputPath)} from queue`}
              title="Remove from queue"
            >
              ×
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default memo(BatchQueue);
