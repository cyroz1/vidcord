export type BrowserBatchQueueItem = {
  id: number;
  file: File;
};

export type BrowserBatchItemStatus =
  | "queued"
  | "encoding"
  | "downloaded"
  | "above-target"
  | "failed"
  | "cancelled";

const STATUS_LABELS: Record<BrowserBatchItemStatus, string> = {
  queued: "Queued",
  encoding: "Encoding",
  downloaded: "Downloaded",
  "above-target": "Above target",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function isBrowserBatchItemRetryable(status: BrowserBatchItemStatus | undefined): boolean {
  return status === "failed" || status === "cancelled";
}

export function browserBatchStatusLabel(status: BrowserBatchItemStatus): string {
  return STATUS_LABELS[status];
}
