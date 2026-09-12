// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import DesktopUpgrade from "../web/DesktopUpgrade";
import { LATEST_RELEASE_URL } from "../web/desktopDownloads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it("falls back to the release page when the response has no matching desktop asset", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ tag_name: "v7.3", assets: [] })))
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const stylesheet = document.createElement("link");
  stylesheet.dataset.vidcordMarketingStyles = "true";
  document.head.appendChild(stylesheet);
  try {
    await act(async () => root.render(<DesktopUpgrade />));
    expect(container.querySelector('[data-download-for="macos"]')?.getAttribute("href")).toBe(
      LATEST_RELEASE_URL
    );
    await act(async () =>
      container.querySelector<HTMLAnchorElement>('[data-download-for="windows"]')!.click()
    );
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>(".arch-option"));
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.href)).toEqual([LATEST_RELEASE_URL, LATEST_RELEASE_URL]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    stylesheet.remove();
  }
});
