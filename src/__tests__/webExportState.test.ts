import { describe, expect, it } from "vitest";
import { effectiveBrowserExportMode, shouldCopyBrowserExport } from "../web/webExportState";

describe("browser export state", () => {
  it("uses the standard compressor for Batch regardless of the prior single-file mode", () => {
    expect(effectiveBrowserExportMode("batch")).toBe("compress");
    expect(effectiveBrowserExportMode("gif")).toBe("gif");
  });

  it("never uses the clipboard convenience path for Batch", () => {
    expect(shouldCopyBrowserExport("gif", false)).toBe(true);
    expect(shouldCopyBrowserExport("gif", true)).toBe(false);
    expect(shouldCopyBrowserExport("compress", false)).toBe(false);
  });
});
