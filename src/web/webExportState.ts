import type { BrowserMode } from "./webSettings";

export type BrowserWorkflowMode = BrowserMode | "batch";

export function effectiveBrowserExportMode(mode: BrowserWorkflowMode): BrowserMode {
  return mode === "batch" ? "compress" : mode;
}

export function shouldCopyBrowserExport(mode: BrowserMode, batchMode: boolean): boolean {
  return !batchMode && mode !== "compress";
}
