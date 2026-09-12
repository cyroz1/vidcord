// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import BatchQueue from "../components/BatchQueue";
import { moveBatchQueueItem, type BatchQueueItem } from "../batchProcessing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const ITEMS: BatchQueueItem[] = [
  { id: 1, inputPath: "/clips/alpha.mp4", status: "queued", progress: 0 },
  {
    id: 2,
    inputPath: "/clips/beta.mp4",
    status: "failed",
    progress: 100,
    message: "Encoder failed",
  },
  {
    id: 3,
    inputPath: "/clips/gamma.mp4",
    status: "cancelled",
    progress: 100,
    message: "Cancelled",
  },
];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function names(): string[] {
  return Array.from(
    container?.querySelectorAll<HTMLElement>(".batch-queue-name") ?? [],
    (node) => node.textContent ?? ""
  );
}

it("reorders the rendered queue with accessible move controls", async () => {
  const onMoveItem = vi.fn();
  const onReorderItem = vi.fn();
  const onRemoveItem = vi.fn();
  const onRetryItem = vi.fn();
  const onRetryFailed = vi.fn();

  function QueueHarness() {
    const [queue, setQueue] = useState(ITEMS);
    return (
      <BatchQueue
        items={queue}
        onMoveItem={(id, direction) => {
          onMoveItem(id, direction);
          setQueue((current) => moveBatchQueueItem(current, id, direction));
        }}
        onReorderItem={onReorderItem}
        onRemoveItem={onRemoveItem}
        onRetryItem={onRetryItem}
        onRetryFailed={onRetryFailed}
        actionsDisabled={false}
      />
    );
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => root!.render(<QueueHarness />));
  expect(names()).toEqual(["alpha.mp4", "beta.mp4", "gamma.mp4"]);

  await act(async () => {
    container
      ?.querySelector<HTMLButtonElement>('button[aria-label="Move beta.mp4 up in queue"]')
      ?.click();
  });
  expect(onMoveItem).toHaveBeenCalledWith(2, "up");
  expect(names()).toEqual(["beta.mp4", "alpha.mp4", "gamma.mp4"]);
  expect(container?.querySelector('[aria-label="Retry beta.mp4"]')).not.toBeNull();

  await act(async () => {
    container?.querySelector<HTMLButtonElement>('[aria-label="Retry beta.mp4"]')?.click();
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Retry 2 unsuccessful batch items"]')
      ?.click();
  });
  expect(onRetryItem).toHaveBeenCalledWith(2);
  expect(onRetryFailed).toHaveBeenCalledTimes(1);
});

it("disables queue actions while an export is running", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () =>
    root!.render(
      <BatchQueue
        items={ITEMS}
        onMoveItem={vi.fn()}
        onReorderItem={vi.fn()}
        onRemoveItem={vi.fn()}
        onRetryItem={vi.fn()}
        onRetryFailed={vi.fn()}
        actionsDisabled
      />
    )
  );

  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Move alpha.mp4 up in queue"]')
      ?.disabled
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Retry beta.mp4"]')?.disabled
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Remove alpha.mp4 from queue"]')
      ?.disabled
  ).toBe(true);
  expect(container.querySelector("li")?.getAttribute("draggable")).toBe("false");
});

it("forwards drag-and-drop reordering by stable item ids", async () => {
  const onReorderItem = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () =>
    root!.render(
      <BatchQueue
        items={ITEMS}
        onMoveItem={vi.fn()}
        onReorderItem={onReorderItem}
        onRemoveItem={vi.fn()}
        onRetryItem={vi.fn()}
        onRetryFailed={vi.fn()}
        actionsDisabled={false}
      />
    )
  );

  const rows = container.querySelectorAll("li");
  await act(async () => rows[0]?.dispatchEvent(new Event("dragstart", { bubbles: true })));
  await act(async () =>
    rows[2]?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }))
  );

  expect(onReorderItem).toHaveBeenCalledWith(1, 3);
});
