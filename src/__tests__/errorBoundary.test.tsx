// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ErrorBoundary, { MAX_ERROR_RETRIES } from "../ErrorBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Crashing(): never {
  throw new Error("deterministic boom");
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const reload = vi.fn();

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  );
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  reload.mockClear();
  vi.restoreAllMocks();
});

it("escalates to a reload after repeated deterministic failures instead of looping forever", async () => {
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload },
    configurable: true,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ErrorBoundary>
        <Crashing />
      </ErrorBoundary>
    )
  );
  expect(container.textContent).toContain("deterministic boom");
  expect(button("Reload app")).toBeDefined();

  // Each "Try again" re-renders the same crashing child and fails again.
  for (let attempt = 1; attempt < MAX_ERROR_RETRIES; attempt += 1) {
    const tryAgain = button("Try again");
    expect(tryAgain).toBeDefined();
    await act(async () => tryAgain!.click());
    expect(container.textContent).toContain("deterministic boom");
  }

  // The retry budget is exhausted: only the reload escalation remains.
  expect(button("Try again")).toBeUndefined();
  const reloadButton = button("Reload app");
  expect(reloadButton).toBeDefined();
  expect(container.textContent).toContain("needs to reload");
  await act(async () => reloadButton!.click());
  expect(reload).toHaveBeenCalledOnce();
});
