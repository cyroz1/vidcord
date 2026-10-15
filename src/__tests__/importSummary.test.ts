import { describe, expect, it } from "vitest";
import { summarizeImportResults } from "../importSummary";

const cleanFolderScan = {
  foldersScanned: 1,
  skippedFolderLinks: 0,
  skippedNonVideoFiles: 0,
  superseded: false,
  truncated: false,
  unreadableItems: 0,
};

describe("summarizeImportResults", () => {
  it("warns when an import scan stops at its entry limit", () => {
    const result = summarizeImportResults({ ...cleanFolderScan, truncated: true }, 3);

    expect(result).toMatchObject({
      shouldReport: true,
      tone: "warning",
      title: "Folder Import Incomplete",
    });
    expect(result.message).toContain("results may be incomplete");
  });

  it("keeps a complete folder scan successful", () => {
    const result = summarizeImportResults(cleanFolderScan, 2);

    expect(result).toMatchObject({
      shouldReport: true,
      tone: "success",
      title: "Folder Import Complete",
    });
  });

  it("warns when a scan is superseded and may not load its partial results", () => {
    const result = summarizeImportResults({ ...cleanFolderScan, superseded: true }, 1);

    expect(result).toMatchObject({
      shouldReport: true,
      tone: "warning",
      title: "Folder Import Incomplete",
    });
    expect(result.message).toContain("scan was superseded");
  });
});
