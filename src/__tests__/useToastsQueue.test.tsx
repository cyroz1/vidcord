// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../hooks/useToasts";
import { sendSystemNotification } from "../ipc";

vi.mock("../ipc", () => ({ sendSystemNotification: vi.fn(async () => true) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useToasts queue cap", () => {
  let root: Root | null = null;
  let hook: ReturnType<typeof useToasts> | null = null;

  async function mount() {
    function Harness() {
      hook = useToasts();
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<Harness />));
  }

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    hook = null;
    vi.mocked(sendSystemNotification).mockClear();
  });

  it("never evicts a persistent toast for a non-persistent newcomer, and drops that newcomer silently", async () => {
    await mount();
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        hook!.addToast("info", `Persistent ${index}`, "stays", {
          durationMs: null,
          notifySystem: false,
        });
      }
    });
    expect(hook!.toasts.map((toast) => toast.title)).toEqual([
      "Persistent 0",
      "Persistent 1",
      "Persistent 2",
      "Persistent 3",
      "Persistent 4",
    ]);

    await act(async () => {
      hook!.addToast("info", "Newcomer", "must be dropped");
    });
    // Flush the serialized notification queue: a notification for the
    // dropped newcomer would have been queued synchronously if one fired.
    await act(async () => {});

    // Queue unchanged and no system notification fired for a toast that
    // was never shown in-app.
    expect(hook!.toasts.map((toast) => toast.title)).toEqual([
      "Persistent 0",
      "Persistent 1",
      "Persistent 2",
      "Persistent 3",
      "Persistent 4",
    ]);
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it("evicts the oldest non-persistent toast before any persistent toast", async () => {
    await mount();
    await act(async () => {
      hook!.addToast("info", "Persistent offer", "stays", {
        durationMs: null,
        notifySystem: false,
      });
      for (let index = 0; index < 4; index += 1) {
        hook!.addToast("info", `Transient ${index}`, "goes", { notifySystem: false });
      }
      hook!.addToast("info", "Newcomer", "stays and notifies");
    });

    expect(hook!.toasts.map((toast) => toast.title)).toEqual([
      "Persistent offer",
      "Transient 1",
      "Transient 2",
      "Transient 3",
      "Newcomer",
    ]);
    expect(sendSystemNotification).toHaveBeenCalledWith("Newcomer", "stays and notifies");
  });
});
