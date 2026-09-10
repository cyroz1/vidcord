import { memo, useState } from "react";
import {
  isBatchItemRetryable,
  type BatchQueueItem,
  type BatchQueueMoveDirection,
} from "../batchProcessing";

type Props = {
  items: readonly BatchQueueItem[];
  onRemoveItem: (id: number) => void;
  onMoveItem: (id: number, direction: BatchQueueMoveDirection) => void;
  onReorderItem: (draggedId: number, targetId: number) => void;
  onRetryItem: (id: number) => void;
  onRetryFailed: () => void;
  actionsDisabled: boolean;
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

function BatchQueue({
  items,
  onRemoveItem,
  onMoveItem,
  onReorderItem,
  onRetryItem,
  onRetryFailed,
  actionsDisabled,
}: Props) {
  const [draggedItemId, setDraggedItemId] = useState<number | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<number | null>(null);
  const completed = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const retryable = items.filter((item) => isBatchItemRetryable(item.status)).length;

  const clearDragState = () => {
    setDraggedItemId(null);
    setDragOverItemId(null);
  };

  return (
    <section className="batch-queue" aria-labelledby="batch-queue-title">
      <div className="batch-queue-heading">
        <div>
          <span className="section-kicker">Batch queue</span>
          <h2 id="batch-queue-title">{items.length} videos selected</h2>
        </div>
        <span className="batch-queue-count" aria-live="polite">
          {completed} complete{failed > 0 ? ` · ${failed} failed` : ""}
          {cancelled > 0 ? ` · ${cancelled} cancelled` : ""}
        </span>
      </div>
      <div className="batch-queue-actions">
        <span className="batch-queue-hint">Drag items or use arrows to set the export order.</span>
        {retryable > 0 && (
          <button
            className="batch-queue-retry-all"
            type="button"
            onClick={onRetryFailed}
            disabled={actionsDisabled}
            aria-label={`Retry ${retryable} unsuccessful batch item${retryable === 1 ? "" : "s"}`}
          >
            Retry {retryable === 1 ? "item" : `${retryable} items`}
          </button>
        )}
      </div>
      <ol className="batch-queue-list" aria-label="Batch queue">
        {items.map((item, index) => {
          const name = fileName(item.inputPath);
          const retryItem = isBatchItemRetryable(item.status);
          return (
            <li
              className={`batch-queue-item ${item.status}${
                draggedItemId === item.id ? " dragging" : ""
              }${dragOverItemId === item.id ? " drag-over" : ""}`}
              key={item.id}
              draggable={!actionsDisabled}
              onDragStart={(event) => {
                if (actionsDisabled) return;
                setDraggedItemId(item.id);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", String(item.id));
                }
              }}
              onDragOver={(event) => {
                if (actionsDisabled) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                if (draggedItemId !== item.id) setDragOverItemId(item.id);
              }}
              onDrop={(event) => {
                if (actionsDisabled) return;
                event.preventDefault();
                const transferValue = event.dataTransfer?.getData("text/plain") ?? "";
                const dataTransferId = Number(transferValue);
                const sourceId =
                  draggedItemId ?? (Number.isInteger(dataTransferId) ? dataTransferId : null);
                if (sourceId !== null && sourceId !== item.id) onReorderItem(sourceId, item.id);
                clearDragState();
              }}
              onDragEnd={clearDragState}
            >
              <span className="batch-queue-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="batch-queue-drag-handle" aria-hidden="true" title="Drag to reorder">
                ⋮⋮
              </span>
              <span className="batch-queue-copy">
                <span className="batch-queue-name" title={item.inputPath}>
                  {name}
                </span>
                {item.details && (
                  <span className="batch-queue-details" title={item.details}>
                    {item.details}
                  </span>
                )}
                <span className="batch-queue-status">
                  {STATUS_LABELS[item.status]}
                  {item.message && (item.status === "failed" || item.status === "cancelled")
                    ? ` · ${item.message}`
                    : ""}
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
              <span className="batch-queue-controls">
                <button
                  className="batch-queue-move"
                  type="button"
                  onClick={() => onMoveItem(item.id, "up")}
                  disabled={actionsDisabled || index === 0}
                  aria-label={`Move ${name} up in queue`}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="batch-queue-move"
                  type="button"
                  onClick={() => onMoveItem(item.id, "down")}
                  disabled={actionsDisabled || index === items.length - 1}
                  aria-label={`Move ${name} down in queue`}
                  title="Move down"
                >
                  ↓
                </button>
                {retryItem && (
                  <button
                    className="batch-queue-retry"
                    type="button"
                    onClick={() => onRetryItem(item.id)}
                    disabled={actionsDisabled}
                    aria-label={`Retry ${name}`}
                    title="Retry this item"
                  >
                    Retry
                  </button>
                )}
                <button
                  className="batch-queue-remove"
                  type="button"
                  onClick={() => onRemoveItem(item.id)}
                  disabled={actionsDisabled}
                  aria-label={`Remove ${name} from queue`}
                  title="Remove from queue"
                >
                  ×
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default memo(BatchQueue);
