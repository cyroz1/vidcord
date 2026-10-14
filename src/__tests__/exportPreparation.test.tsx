// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCompression } from "../hooks/useCompression";

vi.mock("../ipc", () => ({ isTauriRuntime: () => false, cancelCompression: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("cancels delayed preparation without letting its late result affect a newer export", async () => {
  let compression!: ReturnType<typeof useCompression>;
  function Harness() {
    compression = useCompression({ onToast: () => {} });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  try {
    let resolvePath!: () => void;
    const pathResolved = new Promise<void>((resolve) => {
      resolvePath = resolve;
    });
    const launchEncoder = vi.fn();
    const cancelled = compression.beginPreparation();
    const pendingExport = pathResolved.then(() => {
      if (compression.finishPreparation(cancelled)) launchEncoder();
    });
    await act(async () => {
      compression.setCompressing(true);
      await compression.cancelCompress();
    });
    expect(cancelled.aborted).toBe(true);
    expect(compression.compressing).toBe(false);
    const next = compression.beginPreparation();
    resolvePath();
    await pendingExport;
    expect(launchEncoder).not.toHaveBeenCalled();
    expect(next.aborted).toBe(false);
    expect(compression.finishPreparation(next)).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
