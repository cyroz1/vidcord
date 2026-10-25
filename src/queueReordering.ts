export type QueueMoveDirection = "up" | "down";

/// Drag data type marking a drag as an internal queue reorder. Foreign
/// drags (files from the OS, text from another window) never carry it,
/// so queue rows can let those drops bubble to the import handlers
/// instead of misreading their text payload as a queue item id
/// (`Number("")` is 0, which silently reordered the first item).
export const QUEUE_ITEM_DRAG_TYPE = "application/x-vidcord-queue-item";

export function isQueueItemDrag(types: readonly string[] | null | undefined): boolean {
  return types != null && Array.from(types).includes(QUEUE_ITEM_DRAG_TYPE);
}

/// The dragged item id from a drop, or null when the drop is not one of
/// our drags. The transferred id must agree with the internal drag
/// state; the plain-text payload is never trusted.
export function queueItemDragId(
  dataTransfer: { getData: (type: string) => string } | null | undefined,
  draggedItemId: number | null
): number | null {
  if (!dataTransfer || draggedItemId === null) return null;
  const value = dataTransfer.getData(QUEUE_ITEM_DRAG_TYPE);
  if (value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id === draggedItemId ? id : null;
}

export function moveQueueItem<T extends { id: number }>(
  items: readonly T[],
  itemId: number,
  direction: QueueMoveDirection
): T[] {
  const fromIndex = items.findIndex((item) => item.id === itemId);
  if (fromIndex < 0) return items as T[];

  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  if (toIndex < 0 || toIndex >= items.length) return items as T[];

  const next = [...items];
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  return next;
}

export function reorderQueueItem<T extends { id: number }>(
  items: readonly T[],
  draggedItemId: number,
  targetItemId: number
): T[] {
  const fromIndex = items.findIndex((item) => item.id === draggedItemId);
  const targetIndex = items.findIndex((item) => item.id === targetItemId);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return items as T[];

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}
