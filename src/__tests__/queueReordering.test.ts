import { describe, expect, it } from "vitest";
import {
  isQueueItemDrag,
  QUEUE_ITEM_DRAG_TYPE,
  queueItemDragId,
} from "../queueReordering";

function transferWith(entries: Record<string, string>) {
  return {
    types: Object.keys(entries),
    getData: (type: string) => entries[type] ?? "",
  };
}

describe("queue drag identification", () => {
  it("recognizes only drags carrying the private queue type", () => {
    expect(isQueueItemDrag([QUEUE_ITEM_DRAG_TYPE])).toBe(true);
    expect(isQueueItemDrag(["Files"])).toBe(false);
    expect(isQueueItemDrag(["text/plain"])).toBe(false);
    expect(isQueueItemDrag([])).toBe(false);
    expect(isQueueItemDrag(undefined)).toBe(false);
    expect(isQueueItemDrag(null)).toBe(false);
  });

  it("never interprets a foreign drop payload as a queue item id", () => {
    // A file drag carries no queue data; reading its text as an id used
    // to produce Number("") === 0 and silently reorder the first item.
    expect(queueItemDragId(transferWith({ Files: "" }), null)).toBeNull();
    expect(queueItemDragId(transferWith({ "text/plain": "" }), 0)).toBeNull();
    // Selected text that happens to be numeric is not a queue drag.
    expect(queueItemDragId(transferWith({ "text/plain": "2" }), 2)).toBeNull();
  });

  it("accepts an internal drag whose id matches the drag state", () => {
    const transfer = transferWith({ [QUEUE_ITEM_DRAG_TYPE]: "3" });
    expect(queueItemDragId(transfer, 3)).toBe(3);
    // A stale or mismatched payload is rejected.
    expect(queueItemDragId(transfer, 4)).toBeNull();
    expect(queueItemDragId(transfer, null)).toBeNull();
    expect(queueItemDragId(null, 3)).toBeNull();
    expect(queueItemDragId(undefined, 3)).toBeNull();
  });
});
