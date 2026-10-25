import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  batchOutputSummary,
  isBatchItemRetryable,
  type BatchQueueItem,
  type BatchQueueMoveDirection,
} from "../batchProcessing";
import type { BatchProgressPayload } from "../ipc";

type Props = {
  items: readonly BatchQueueItem[];
  liveSummary?: {
    completed: number;
    failed: number;
    cancelled: number;
  };
  progressById?: ReadonlyMap<
    number,
    Pick<BatchProgressPayload, "item_percent" | "phase" | "status">
  >;
  onClearQueue: () => void;
  onRemoveItem: (id: number) => void;
  onMoveItem: (id: number, direction: BatchQueueMoveDirection) => void;
  onReorderItem: (draggedId: number, targetId: number) => void;
  onRetryItem: (id: number) => void;
  onRetryFailed: () => void;
  actionsDisabled: boolean;
  activeProgress?: BatchProgressPayload | null;
};

const EMPTY_PROGRESS_BY_ID: ReadonlyMap<
  number,
  Pick<BatchProgressPayload, "item_percent" | "phase" | "status">
> = new Map();

const EMPTY_LIVE_SUMMARY = { completed: 0, failed: 0, cancelled: 0 };

const ROW_HEIGHT = 56;
const ROW_GAP = 4;
const ROW_STRIDE = ROW_HEIGHT + ROW_GAP;
const OVERSCAN_ROWS = 6;
const INITIAL_VISIBLE_ROWS = 12;

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
  liveSummary = EMPTY_LIVE_SUMMARY,
  progressById = EMPTY_PROGRESS_BY_ID,
  onClearQueue,
  onRemoveItem,
  onMoveItem,
  onReorderItem,
  onRetryItem,
  onRetryFailed,
  actionsDisabled,
  activeProgress = null,
}: Props) {
  const [draggedItemId, setDraggedItemId] = useState<number | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const summary = useMemo(() => batchOutputSummary(items), [items]);
  const completed = summary.completed + liveSummary.completed;
  const failed = summary.failed + liveSummary.failed;
  const cancelled = summary.cancelled + liveSummary.cancelled;
  const retryable = summary.retryable + liveSummary.failed + liveSummary.cancelled;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateHeight = () => setViewportHeight(viewport.clientHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const firstItem = items[0];
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = 0;
    setScrollTop(0);
  }, [items.length, firstItem?.id, firstItem?.inputPath]);

  const startIndex =
    viewportHeight === 0 ? 0 : Math.max(0, Math.floor(scrollTop / ROW_STRIDE) - OVERSCAN_ROWS);
  const visibleCount =
    viewportHeight === 0
      ? INITIAL_VISIBLE_ROWS
      : Math.ceil(viewportHeight / ROW_STRIDE) + OVERSCAN_ROWS * 2;
  const visibleItems = items.slice(startIndex, Math.min(items.length, startIndex + visibleCount));
  const listHeight = Math.max(0, items.length * ROW_STRIDE - ROW_GAP);

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
        <button
          className="batch-queue-clear"
          type="button"
          onClick={onClearQueue}
          disabled={actionsDisabled}
          aria-label="Clear all videos from the queue"
        >
          Clear queue
        </button>
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
      <div
        className="batch-queue-viewport"
        ref={viewportRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <ol className="batch-queue-list" aria-label="Batch queue" style={{ height: listHeight }}>
          {visibleItems.map((item, visibleIndex) => {
            const index = startIndex + visibleIndex;
            const name = fileName(item.inputPath);
            const liveProgress =
              progressById.get(item.id) ??
              (activeProgress?.item_id === item.id ? activeProgress : undefined);
            const status = liveProgress?.phase ?? item.status;
            const progress = liveProgress?.item_percent ?? item.progress;
            const message = liveProgress?.status ?? item.message;
            const retryItem = isBatchItemRetryable(status);
            return (
              <li
                className={`batch-queue-item ${status}${
                  draggedItemId === item.id ? " dragging" : ""
                }${dragOverItemId === item.id ? " drag-over" : ""}`}
                key={item.id}
                aria-posinset={index + 1}
                aria-setsize={items.length}
                style={{ top: index * ROW_STRIDE }}
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
                  if (dragOverItemId !== item.id) setDragOverItemId(item.id);
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
                <span
                  className="batch-queue-drag-handle"
                  aria-hidden="true"
                  title="Drag to reorder"
                >
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
                    {STATUS_LABELS[status]}
                    {message && (status === "failed" || status === "cancelled")
                      ? ` · ${message}`
                      : ""}
                  </span>
                </span>
                <span className="batch-queue-progress" aria-label={`${progress}% complete`}>
                  {status === "completed"
                    ? "✓"
                    : status === "failed"
                      ? "!"
                      : status === "cancelled"
                        ? "–"
                        : `${Math.round(progress)}%`}
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
      </div>
    </section>
  );
}

export default memo(BatchQueue);
