export type WindowContentSize = { width: number; height: number };
/**
 * A stable content width per work area, with room for native decorations.
 * The width never exceeds the 16:9 preview's footprint: the preview pane is
 * 432 CSS px wide and the app adds 28 px of horizontal padding around it,
 * for a 460 px content width, the same width the fixed window used before
 * dynamic sizing. Wider windows only stretch the controls around a preview
 * that cannot grow.
 */
export function widthForWorkArea(
  availableWidth: number,
  chromeWidth: number,
  scale: number
): number {
  return Math.max(1, Math.min(460, Math.floor((availableWidth - chromeWidth) / scale) - 2));
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
