// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCompression, type BatchProgressPayload } from "../hooks/useCompression";

type Handler = (event: { payload: BatchProgressPayload }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  },
}));
vi.mock("../ipc", () => ({ isTauriRuntime: () => true, cancelCompression: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function payload(item_id: number, phase: BatchProgressPayload["phase"]): BatchProgressPayload {
  return {
    item_id,
    item_percent: phase === "encoding" ? 40 : 100,
    percent: 50,
    eta: "1m",
    status: phase === "encoding" ? "Encoding" : "Done",
    phase,
    active_count: 1,
    completed_count: phase === "encoding" ? 0 : 1,
    total_count: 2,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  handlers.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("flushes coalesced progress on a timeout while the document is hidden", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  const seen: BatchProgressPayload[] = [];
  let progress = -1;
  function Harness() {
    const compression = useCompression({ onBatchProgress: (p) => seen.push(p) });
    progress = compression.progress;
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  const handler = handlers.get("batch-progress");
  expect(handler).toBeDefined();

  // RAF is paused for hidden windows, so this encoding payload can only
  // arrive via the ~250 ms timeout fallback.
  await act(async () => {
    handler!({ payload: payload(2, "encoding") });
  });
  expect(seen).toEqual([]);
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  expect(seen.map((p) => p.item_id)).toEqual([2]);
  expect(progress).toBe(50);
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

it("delivers a terminal payload even when another item progresses in the same frame", async () => {
  const seen: BatchProgressPayload[] = [];
  function Harness() {
    useCompression({ onBatchProgress: (p) => seen.push(p) });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  const handler = handlers.get("batch-progress");
  expect(handler).toBeDefined();

  // Item 2 reports encoding progress, then item 1 finishes, all before any
  // animation frame fires. The old single-slot coalescer kept only item
  // 1's payload, and in the reverse order it overwrote item 1's completed
  // payload, so item 1 never left "encoding". The per-item pending map
  // plus the synchronous terminal flush deliver both, in arrival order.
  await act(async () => {
    handler!({ payload: payload(2, "encoding") });
    handler!({ payload: payload(1, "completed") });
  });
  expect(seen.map((p) => [p.item_id, p.phase])).toEqual([
    [2, "encoding"],
    [1, "completed"],
  ]);
});
