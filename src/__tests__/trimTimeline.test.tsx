// @vitest-environment happy-dom

import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import TrimTimeline from "../components/TrimTimeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    selectedDuration: 6,
    selectedDurationPct: 100,
    editableTimes: true,
    losslessTrim: false,
    losslessInfoLoading: false,
    losslessInfoError: null,
    trimReady: true,
    canSetInPoint: true,
    canSetOutPoint: true,
    canUndoTrim: false,
    canRedoTrim: false,
    snapMode: "off" as const,
    timelineZoom: 1,
    trimWrapRef: createRef<HTMLDivElement>() as RefObject<HTMLDivElement>,
    startTime: 0,
    endTime: 6,
    viewStartVal: 0,
    viewEndVal: 10000,
    startVal: 0,
    endVal: 10000,
    startPct: 0,
    endPct: 100,
    trimPlayheadRef: createRef<HTMLDivElement>() as RefObject<HTMLDivElement>,
    onSetInPoint: vi.fn(),
    onSetOutPoint: vi.fn(),
    onSnapModeChange: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onZoomIn: vi.fn(),
    onUndoTrim: vi.fn(),
    onRedoTrim: vi.fn(),
    loopPlayback: false,
    onLoopPlaybackChange: vi.fn(),
    onTrimWheel: vi.fn(),
    onTimelineClick: vi.fn(),
    onRangeDragStart: vi.fn(),
    onPlayheadDragStart: vi.fn(),
    onStartHandlePointerDown: vi.fn(),
    onEndHandlePointerDown: vi.fn(),
    onStartHandleFocus: vi.fn(),
    onEndHandleFocus: vi.fn(),
    onPointerUp: vi.fn(),
    onStartChange: vi.fn(),
    onEndChange: vi.fn(),
    onStartTimeCommit: vi.fn(),
    onEndTimeCommit: vi.fn(),
    ...overrides,
  };
}

async function render(props: ReturnType<typeof makeProps>) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(<TrimTimeline {...props} />));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("re-syncs a rejected time draft when the time prop changes externally", async () => {
  const props = makeProps();
  await render(props);
  const input = container!.querySelector<HTMLInputElement>('input[aria-label="Trim start time"]')!;
  expect(input.value).toBe("0.0s");

  await act(async () => input.focus());
  await act(async () => setInputValue(input, "bogus"));
  await act(async () => input.blur());

  // The rejected draft is retained and flagged (the 5.9 behavior).
  expect(input.value).toBe("bogus");
  expect(input.getAttribute("aria-invalid")).toBe("true");

  // An external change to the time prop (undo/redo, drag, zoom commit)
  // while the field is not being edited must not be masked by the draft.
  await render(makeProps({ ...props, startTime: 2.5 }));
  const updated = container!.querySelector<HTMLInputElement>(
    'input[aria-label="Trim start time"]'
  )!;
  expect(updated.value).toBe("2.5s");
  expect(updated.getAttribute("aria-invalid")).toBeNull();
});

it("does not steal focus back to a handle that was blurred before leaving the view", async () => {
  const props = makeProps();
  await render(props);
  const handle = container!.querySelector<HTMLInputElement>(".trim-start-handle")!;
  await act(async () => handle.focus());
  expect(document.activeElement).toBe(handle);
  await act(async () => handle.blur());
  expect(document.activeElement).not.toBe(handle);

  // Pan the handle out of view, then back in: the focus-restore effect must
  // not refocus it, because the user deliberately blurred it beforehand.
  await render(makeProps({ ...props, viewStartVal: 5000 }));
  expect(container!.querySelector(".trim-start-handle")).toBeNull();
  await render(makeProps({ ...props }));
  const remounted = container!.querySelector<HTMLInputElement>(".trim-start-handle")!;
  expect(remounted).not.toBeNull();
  expect(document.activeElement).not.toBe(remounted);
});
