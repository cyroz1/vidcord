import { describe, expect, it } from "vitest";
import { createImportScanId } from "../importScanId";

describe("createImportScanId", () => {
  it("returns a distinct caller id for every scan in the current page session", () => {
    expect(createImportScanId()).not.toBe(createImportScanId());
  });
});
