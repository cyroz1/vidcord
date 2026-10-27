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
        onClearQueue={vi.fn()}
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
        onClearQueue={vi.fn()}
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

it("keeps item names stable across progress-only updates", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const renderItems = (items: BatchQueueItem[]) => (
    <BatchQueue
      items={items}
      onClearQueue={vi.fn()}
      onMoveItem={vi.fn()}
      onReorderItem={vi.fn()}
      onRemoveItem={vi.fn()}
      onRetryItem={vi.fn()}
      onRetryFailed={vi.fn()}
      actionsDisabled={false}
    />
  );

  await act(async () => root!.render(renderItems(ITEMS)));
  expect(names()).toEqual(["alpha.mp4", "beta.mp4", "gamma.mp4"]);

  // A progress tick replaces the items array identity (and the encoding
  // item's object) without changing any id/path: names must stay put and
  // the new progress must render.
  const ticked = ITEMS.map((item) =>
    item.id === 1 ? { ...item, status: "encoding" as const, progress: 55 } : item
  );
  await act(async () => root!.render(renderItems(ticked)));
  expect(names()).toEqual(["alpha.mp4", "beta.mp4", "gamma.mp4"]);
  expect(container.querySelector('[aria-label="55% complete"]')).not.toBeNull();
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
        onClearQueue={vi.fn()}
        onMoveItem={vi.fn()}
        onReorderItem={onReorderItem}
        onRemoveItem={vi.fn()}
        onRetryItem={vi.fn()}
        onRetryFailed={vi.fn()}
        actionsDisabled={false}
      />
    )
  );

  // A real internal drag carries the private queue drag type; the stub
  // mirrors what the browser's DataTransfer does with it.
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "",
    dropEffect: "",
    types: [] as string[],
    files: [] as File[],
    setData: (type: string, value: string) => {
      store.set(type, value);
      dataTransfer.types = [...store.keys()];
    },
    getData: (type: string) => store.get(type) ?? "",
  };
  const dragStart = new Event("dragstart", { bubbles: true });
  Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });

  const rows = container.querySelectorAll("li");
  await act(async () => rows[0]?.dispatchEvent(dragStart));
  await act(async () => rows[2]?.dispatchEvent(drop));

  expect(onReorderItem).toHaveBeenCalledWith(1, 3);
});

it("pages long queues and keeps a moved item focused across page boundaries", async () => {
  const manyItems: BatchQueueItem[] = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    inputPath: `/clips/${index + 1}.mp4`,
    status: "queued",
    progress: 0,
  }));

  function QueueHarness() {
    const [queue, setQueue] = useState(manyItems);
    return (
      <BatchQueue
        items={queue}
        onClearQueue={vi.fn()}
        onMoveItem={(id, direction) =>
          setQueue((current) => moveBatchQueueItem(current, id, direction))
        }
        onReorderItem={vi.fn()}
        onRemoveItem={(id) => setQueue((current) => current.filter((item) => item.id !== id))}
        onRetryItem={vi.fn()}
        onRetryFailed={vi.fn()}
        actionsDisabled={false}
      />
    );
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<QueueHarness />));
  expect(names()).toEqual(["1.mp4", "2.mp4", "3.mp4"]);
  await act(async () =>
    container?.querySelector<HTMLButtonElement>('[aria-label="Move 3.mp4 down in queue"]')?.click()
  );
  expect(names()).toEqual(["3.mp4", "5.mp4", "6.mp4"]);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Move 3.mp4 down in queue");
  await act(async () =>
    [...(container?.querySelectorAll<HTMLButtonElement>(".pagination button") ?? [])][1]?.click()
  );
  expect(names()).toEqual(["7.mp4"]);
  await act(async () =>
    container?.querySelector<HTMLButtonElement>('[aria-label="Remove 7.mp4 from queue"]')?.click()
  );
  expect(names()).toEqual(["3.mp4", "5.mp4", "6.mp4"]);
});

it("can jump directly to a page in a large queue", async () => {
  const items: BatchQueueItem[] = Array.from({ length: 36 }, (_, index) => ({
    id: index + 1,
    inputPath: `/clips/${index + 1}.mp4`,
    status: "queued",
    progress: 0,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <BatchQueue
        items={items}
        onClearQueue={vi.fn()}
        onMoveItem={vi.fn()}
        onReorderItem={vi.fn()}
        onRemoveItem={vi.fn()}
        onRetryItem={vi.fn()}
        onRetryFailed={vi.fn()}
        actionsDisabled={false}
      />
    )
  );
  const input = container.querySelector<HTMLInputElement>(".page-jump input")!;
  input.value = "10";
  await act(async () =>
    container
      ?.querySelector<HTMLFormElement>(".page-jump")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(names()).toEqual(["28.mp4", "29.mp4", "30.mp4"]);
});

it("reduces the queue to one row when the work area is very short", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  try {
    container = document.createElement("div");
    container.className = "app";
    container.setAttribute("data-compact-tight", "");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <BatchQueue
          items={ITEMS}
          onClearQueue={vi.fn()}
          onMoveItem={vi.fn()}
          onReorderItem={vi.fn()}
          onRemoveItem={vi.fn()}
          onRetryItem={vi.fn()}
          onRetryFailed={vi.fn()}
          actionsDisabled={false}
        />
      )
    );
    expect(names()).toEqual(["alpha.mp4"]);
    await act(async () => {
      container?.removeAttribute("data-compact-tight");
      await Promise.resolve();
    });
    expect(names()).toEqual(["alpha.mp4", "beta.mp4"]);
  } finally {
    width.mockRestore();
  }
});
