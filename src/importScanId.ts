const SCAN_SESSION_ID =
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let nextScanId = 0;

export function createImportScanId(): string {
  nextScanId += 1;
  return `${SCAN_SESSION_ID}:${nextScanId}`;
}
