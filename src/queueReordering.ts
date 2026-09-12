export type QueueMoveDirection = "up" | "down";

export function moveQueueItem<T extends { id: number }>(
  items: readonly T[],
  itemId: number,
  direction: QueueMoveDirection
): T[] {
  const fromIndex = items.findIndex((item) => item.id === itemId);
  if (fromIndex < 0) return [...items];

  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  if (toIndex < 0 || toIndex >= items.length) return [...items];

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
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return [...items];

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}
