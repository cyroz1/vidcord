// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSettings } from "../hooks/useSettings";
import { loadSettings, saveSettings, type Settings } from "../ipc";

vi.mock("../ipc", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(async () => {}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.clearAllMocks();
});

it("persists the migrated lossless settings on load, not the pre-migration values", async () => {
  // Legacy shape: quality preset 5 was the short-lived Lossless Trim slot
  // and there is no dedicated lossless_mode flag yet.
  vi.mocked(loadSettings).mockResolvedValue({ quality_index: 5 } as Settings);
  let hook: ReturnType<typeof useSettings> | null = null;
  function Harness() {
    hook = useSettings();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  await act(async () => {});

  expect(hook!.settingsLoaded).toBe(true);
  expect(hook!.losslessMode).toBe(true);
  expect(hook!.qualityIdx).toBe(0);
  // The single load-time persist must already carry the migration rewrite;
  // before the fix it carried quality_index: 5 and the rewrite was only
  // applied in memory, diverging from disk until an unrelated save.
  expect(saveSettings).toHaveBeenCalledOnce();
  const persisted = vi.mocked(saveSettings).mock.calls[0][0];
  expect(persisted.quality_index).toBe(0);
  expect(persisted.lossless_mode).toBe(true);
  expect(persisted.advanced_mode).toBe(false);
  expect(hook!.settingsRef.current).toMatchObject({
    quality_index: 0,
    lossless_mode: true,
    advanced_mode: false,
  });
});

it("loads and persists the gif output format, normalizing invalid values", async () => {
  vi.mocked(loadSettings).mockResolvedValue({ gif_output_format: "webp" } as Settings);
  let hook: ReturnType<typeof useSettings> | null = null;
  function Harness() {
    hook = useSettings();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  await act(async () => {});

  expect(hook!.settingsLoaded).toBe(true);
  expect(hook!.gifOutputFormat).toBe("webp");
  const persisted = vi.mocked(saveSettings).mock.calls[0][0];
  expect(persisted.gif_output_format).toBe("webp");
});

it("falls back to gif when the persisted output format is unknown", async () => {
  vi.mocked(loadSettings).mockResolvedValue({ gif_output_format: "avif" } as unknown as Settings);
  let hook: ReturnType<typeof useSettings> | null = null;
  function Harness() {
    hook = useSettings();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  await act(async () => {});

  expect(hook!.gifOutputFormat).toBe("gif");
  const persisted = vi.mocked(saveSettings).mock.calls[0][0];
  expect(persisted.gif_output_format).toBe("gif");
});
