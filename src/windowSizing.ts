export type WindowContentSize = { width: number; height: number };
export type WindowLayout = "normal" | "compact" | "narrow";

export function chooseWindowLayout(
  sizes: Record<WindowLayout, WindowContentSize>,
  workArea: WindowContentSize,
  chrome: WindowContentSize,
  scale: number
): WindowLayout {
  const layouts: WindowLayout[] = ["normal", "compact", "narrow"];
  const ratio = (layout: WindowLayout) => {
    const size = sizes[layout];
    return Math.max(
      ((size.width + 2) * scale + chrome.width) / workArea.width,
      ((size.height + 2) * scale + chrome.height) / workArea.height
    );
  };
  // Prefer the normal layout whenever it fits. If none can fit, use the
  // arrangement that exceeds the available area by the smallest proportion.
  return (
    layouts.find((layout) => ratio(layout) <= 1) ??
    layouts.reduce((best, layout) => (ratio(layout) < ratio(best) ? layout : best))
  );
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
