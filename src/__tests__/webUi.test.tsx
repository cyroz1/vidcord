// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../web/DesktopUpgrade", () => ({ default: () => null }));

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
});
