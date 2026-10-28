export type WindowContentSize = { width: number; height: number };
/** A stable content width per work area, with room for native decorations. */
export function widthForWorkArea(
  availableWidth: number,
  chromeWidth: number,
  scale: number
): number {
  return Math.max(1, Math.min(850, Math.floor((availableWidth - chromeWidth) / scale) - 2));
}

export function nativeSizeForContent(
  content: WindowContentSize,
  viewport: WindowContentSize,
  baselineRequest: WindowContentSize,
  scale: number
): WindowContentSize {
  return {
    width: Math.max(
      1,
      Math.ceil(baselineRequest.width + (content.width + 2 - viewport.width) * scale)
    ),
    height: Math.max(
      1,
      Math.ceil(baselineRequest.height + (content.height + 2 - viewport.height) * scale)
    ),
  };
}
