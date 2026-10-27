import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  batchOutputSummary,
  isBatchItemRetryable,
  type BatchQueueItem,
  type BatchQueueMoveDirection,
} from "../batchProcessing";
import type { BatchProgressPayload } from "../ipc";
import { isQueueItemDrag, QUEUE_ITEM_DRAG_TYPE, queueItemDragId } from "../queueReordering";

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

const DEFAULT_PAGE_SIZE = 3;

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
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const queueRef = useRef<HTMLElement>(null);
  const pageSizeRef = useRef(DEFAULT_PAGE_SIZE);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const pendingMoveFocus = useRef<{ id: number; direction: BatchQueueMoveDirection } | null>(null);
  const summary = useMemo(() => batchOutputSummary(items), [items]);
  const completed = summary.completed + liveSummary.completed;
  const failed = summary.failed + liveSummary.failed;
  const cancelled = summary.cancelled + liveSummary.cancelled;
  const retryable = summary.retryable + liveSummary.failed + liveSummary.cancelled;

  useEffect(() => {
    const queue = queueRef.current;
    if (!queue) return;
    const app = queue.closest(".app");
    const updatePageSize = () => {
      if (!queue.clientWidth) return;
      const next =
        queue.clientWidth < 340
          ? app?.hasAttribute("data-compact-tight")
            ? 1
            : 2
          : DEFAULT_PAGE_SIZE;
      if (next !== pageSizeRef.current) {
        const previous = pageSizeRef.current;
        pageSizeRef.current = next;
        setPageSize(next);
        setPage((current) => Math.floor((current * previous) / next));
      }
    };
    updatePageSize();
    const observer = new ResizeObserver(updatePageSize);
    observer.observe(queue);
    const layoutObserver = new MutationObserver(updatePageSize);
    if (app)
      layoutObserver.observe(app, { attributes: true, attributeFilter: ["data-compact-tight"] });
    return () => {
      observer.disconnect();
      layoutObserver.disconnect();
    };
  }, []);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const startIndex = currentPage * pageSize;
  const visibleItems = items.slice(startIndex, startIndex + pageSize);

  useLayoutEffect(() => {
    const pending = pendingMoveFocus.current;
    if (!pending) return;
    const row = queueRef.current?.querySelector<HTMLElement>(`[data-queue-id="${pending.id}"]`);
    const button = row?.querySelector<HTMLButtonElement>(
      `button[data-move-direction="${pending.direction}"]:not(:disabled)`
    );
    (button ?? row?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    pendingMoveFocus.current = null;
  }, [items, currentPage]);

  const clearDragState = () => {
    setDraggedItemId(null);
    setDragOverItemId(null);
  };

  return (
    <section className="batch-queue" aria-labelledby="batch-queue-title" ref={queueRef}>
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
      <ol className="batch-queue-list" aria-label="Batch queue">
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
              data-queue-id={item.id}
              draggable={!actionsDisabled}
              onDragStart={(event) => {
                if (actionsDisabled) return;
                setDraggedItemId(item.id);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(QUEUE_ITEM_DRAG_TYPE, String(item.id));
                }
              }}
              onDragOver={(event) => {
                if (actionsDisabled) return;
                // Only internal queue drags are reorder targets; foreign
                // drags keep their default handling.
                if (!isQueueItemDrag(event.dataTransfer?.types)) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                if (dragOverItemId !== item.id) setDragOverItemId(item.id);
              }}
              onDrop={(event) => {
                if (actionsDisabled) return;
                const sourceId = queueItemDragId(event.dataTransfer, draggedItemId);
                if (sourceId === null) return;
                event.preventDefault();
                if (sourceId !== item.id) onReorderItem(sourceId, item.id);
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
                  data-move-direction="up"
                  onClick={() => {
                    pendingMoveFocus.current = { id: item.id, direction: "up" };
                    onMoveItem(item.id, "up");
                    setPage(Math.floor((index - 1) / pageSize));
                  }}
                  disabled={actionsDisabled || index === 0}
                  aria-label={`Move ${name} up in queue`}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  className="batch-queue-move"
                  type="button"
                  data-move-direction="down"
                  onClick={() => {
                    pendingMoveFocus.current = { id: item.id, direction: "down" };
                    onMoveItem(item.id, "down");
                    setPage(Math.floor((index + 1) / pageSize));
                  }}
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
      {pageCount > 1 && (
        <div className="pagination" aria-label="Batch queue pages">
          <button
            type="button"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 0}
          >
            Previous
          </button>
          {pageCount > 10 ? (
            <form
              className="page-jump"
              onSubmit={(event) => {
                event.preventDefault();
                const requested = Number(pageInputRef.current?.value);
                if (Number.isFinite(requested)) {
                  setPage(Math.max(0, Math.min(pageCount - 1, Math.floor(requested) - 1)));
                }
              }}
            >
              <input
                key={`${currentPage}:${pageCount}`}
                ref={pageInputRef}
                type="number"
                min="1"
                max={pageCount}
                defaultValue={currentPage + 1}
                aria-label="Go to page"
              />
              <span> / {pageCount}</span>
              <button type="submit">Go</button>
            </form>
          ) : (
            <span aria-live="polite">
              {startIndex + 1}–{startIndex + visibleItems.length} of {items.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage === pageCount - 1}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

export default memo(BatchQueue);
