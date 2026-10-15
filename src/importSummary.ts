import type { ExpandedImportPaths } from "./ipc";

type ImportSummaryInput = Pick<
  ExpandedImportPaths,
  | "foldersScanned"
  | "skippedFolderLinks"
  | "skippedNonVideoFiles"
  | "superseded"
  | "truncated"
  | "unreadableItems"
>;

export type ImportSummary = {
  shouldReport: boolean;
  tone: "success" | "warning";
  title: string;
  message: string;
};

export function summarizeImportResults(
  expanded: ImportSummaryInput,
  videoCount: number
): ImportSummary {
  const foundVideos = videoCount > 0;
  const details =
    videoCount > 0
      ? [`Queued ${videoCount} ${videoCount === 1 ? "video" : "videos"}`]
      : ["No supported videos found"];

  if (expanded.skippedNonVideoFiles > 0) {
    const fileLabel = expanded.skippedNonVideoFiles === 1 ? "file" : "files";
    details.push(`skipped ${expanded.skippedNonVideoFiles} non-video ${fileLabel}`);
  }
  if (expanded.skippedFolderLinks > 0) {
    const folderLabel = expanded.skippedFolderLinks === 1 ? "folder link" : "folder links";
    details.push(`skipped ${expanded.skippedFolderLinks} ${folderLabel}`);
  }
  if (expanded.unreadableItems > 0) {
    const itemLabel = expanded.unreadableItems === 1 ? "item" : "items";
    details.push(`could not read ${expanded.unreadableItems} ${itemLabel}`);
  }
  const incomplete = expanded.truncated || expanded.superseded;
  if (expanded.truncated) {
    details.push("scan reached its entry limit; results may be incomplete");
  } else if (expanded.superseded) {
    details.push("scan was superseded; results may be incomplete");
  }

  const hasSkippedItems =
    expanded.skippedNonVideoFiles > 0 ||
    expanded.skippedFolderLinks > 0 ||
    expanded.unreadableItems > 0;
  const shouldReport =
    expanded.foldersScanned > 0 ||
    hasSkippedItems ||
    incomplete ||
    !foundVideos;
  const title = incomplete
    ? expanded.foldersScanned > 0
      ? "Folder Import Incomplete"
      : "Import Incomplete"
    : foundVideos
      ? expanded.foldersScanned > 0
        ? "Folder Import Complete"
        : "Import Results"
      : "No Videos Found";
  const folderLabel = expanded.foldersScanned === 1 ? "folder" : "folders";
  const folderSummary =
    expanded.foldersScanned > 0 ? ` · scanned ${expanded.foldersScanned} ${folderLabel}` : "";

  return {
    shouldReport,
    tone: hasSkippedItems || incomplete || !foundVideos ? "warning" : "success",
    title,
    message: `${details.join(" · ")}${folderSummary}`,
  };
}
