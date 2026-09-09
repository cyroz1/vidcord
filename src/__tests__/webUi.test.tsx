// @vitest-environment happy-dom

import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../web/DesktopUpgrade", () => ({
  default: ({ children }: { children?: unknown }) => children,
}));

import WebApp from "../web/WebApp";
import WebTrimTimeline from "../web/WebTrimTimeline";

let root: Root;
let container: HTMLDivElement;
let storageValues: Map<string, string>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  storageValues = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  storageValues.clear();
});

describe("browser UI", () => {
  it("locks trim history during exports and supports the advertised shortcuts", async () => {
    function TimelineHarness({ disabled = false }: { disabled?: boolean }) {
      const [range, setRange] = useState({ start: 10, end: 50 });
      return (
        <WebTrimTimeline
          duration={60}
          startTime={range.start}
          endTime={range.end}
          currentTime={20}
          disabled={disabled}
          editableTimes
          losslessTrim={false}
          losslessInfoLoading={false}
          losslessInfoError={null}
          historyKey="clip"
          loopPlayback={false}
          onLoopPlaybackChange={vi.fn()}
          onRangeChange={(start, end) => setRange({ start, end })}
          onSeek={vi.fn()}
        />
      );
    }
    await act(async () => root.render(<TimelineHarness />));
    const timeline = container.querySelector(".web-timeline")!;
    await act(async () =>
      timeline.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }))
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Trim start"]')?.value).toBe(
      "20"
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Undo trim"]')?.disabled
    ).toBe(false);
    await act(async () => root.render(<TimelineHarness disabled />));
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Undo trim"]')?.disabled
    ).toBe(true);
    await act(async () =>
      timeline.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })
      )
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Trim start"]')?.value).toBe(
      "20"
    );
    await act(async () => root.render(<TimelineHarness />));
    await act(async () =>
      timeline.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })
      )
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Trim start"]')?.value).toBe(
      "10"
    );
    await act(async () =>
      timeline.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true })
      )
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Trim start"]')?.value).toBe(
      "20"
    );
    const track = container.querySelector(".web-trim-dual-wrap")!;
    const normalScroll = new WheelEvent("wheel", { deltaY: 10, cancelable: true });
    await act(async () => track.dispatchEvent(normalScroll));
    expect(normalScroll.defaultPrevented).toBe(false);
    const zoom = new WheelEvent("wheel", { deltaY: -10, ctrlKey: true, cancelable: true });
    // happy-dom's WheelEvent currently omits the MouseEvent modifier fields.
    Object.defineProperty(zoom, "ctrlKey", { value: true });
    await act(async () => track.dispatchEvent(zoom));
    expect(zoom.defaultPrevented).toBe(true);
  });
  it("renders the shared GIF targets when GIF mode is selected", async () => {
    await act(async () => {
      root.render(<WebApp />);
    });

    const gifButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "GIF"
    );
    expect(gifButton).toBeDefined();

    await act(async () => {
      gifButton?.click();
    });

    const targetSelect = container.querySelector<HTMLSelectElement>(".web-gif-grid select");
    expect(Array.from(targetSelect?.options ?? [], (option) => option.textContent)).toEqual([
      "5 MB",
      "10 MB",
      "20 MB",
    ]);
  });

  it("exposes browser timeline snap and zoom controls", async () => {
    const onRangeChange = vi.fn();
    const onSeek = vi.fn();

    await act(async () => {
      root.render(
        <WebTrimTimeline
          duration={60}
          startTime={10}
          endTime={50}
          currentTime={20}
          editableTimes
          losslessTrim={false}
          losslessInfoLoading={false}
          losslessInfoError={null}
          historyKey="clip"
          loopPlayback={false}
          onLoopPlaybackChange={vi.fn()}
          onRangeChange={onRangeChange}
          onSeek={onSeek}
        />
      );
    });

    const moreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More trim options"]'
    );
    expect(moreButton).not.toBeNull();

    await act(async () => {
      moreButton?.click();
    });

    expect(container.querySelector('select[aria-label="Timeline snap interval"]')).not.toBeNull();
    const zoomIn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Zoom timeline in"]'
    );
    expect(zoomIn).not.toBeNull();

    await act(async () => {
      zoomIn?.click();
    });

    expect(
      container.querySelector('button[aria-label="Reset timeline zoom to 1x"]')?.textContent
    ).toBe("1.3x");
  });

  it("does not advertise desktop-only keyboard shortcuts in the browser timeline", async () => {
    await act(async () => {
      root.render(
        <WebTrimTimeline
          duration={60}
          startTime={10}
          endTime={50}
          currentTime={20}
          editableTimes={false}
          losslessTrim={false}
          losslessInfoLoading={false}
          losslessInfoError={null}
          historyKey="clip-shortcuts"
          loopPlayback={false}
          onLoopPlaybackChange={vi.fn()}
          onRangeChange={vi.fn()}
          onSeek={vi.fn()}
        />
      );
    });

    const labeledButtons = container.querySelectorAll<HTMLButtonElement>(
      "button.web-trim-labeled-btn"
    );
    expect(labeledButtons[0]?.title).toBe("Set in point to playhead");
    expect(labeledButtons[1]?.title).toBe("Set out point to playhead");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Undo trim"]')?.title
    ).toBe("Undo trim");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Redo trim"]')?.title
    ).toBe("Redo trim");
  });
});
