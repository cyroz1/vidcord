import { useEffect, type RefObject } from "react";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../ipc";
import { nativeSizeForContent, widthForWorkArea } from "../windowSizing";

/** Size the native client area from the rendered layout, not from window chrome. */
export function useDesktopWindowSizing(appRef: RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const app = appRef.current;
    if (!app || !isTauriRuntime()) return;

    const nativeWindow = getCurrentWindow();
    let frame: number | null = null;
    let running = false;
    let dirty = false;
    let disposed = false;
    let lastAttempt = "";
    let monitorKey = "";
    let stableWidth = 0;
    let unlistenMove: (() => void) | undefined;
    let lastIssued: { width: number; height: number; scale: number } | null = null;
    let lastApplied: { width: number; height: number; scale: number } | null = null;

    const syncSelectMeasures = () => {
      for (const wrapper of app.querySelectorAll<HTMLElement>(".sized-select")) {
        const select = wrapper.querySelector<HTMLSelectElement>("select");
        const measure = wrapper.querySelector<HTMLElement>("span");
        if (!select || !measure) continue;
        const style = getComputedStyle(select);
        // Match the selected value's actual text metrics, including system
        // text scaling, when determining the control's intrinsic width.
        for (const property of [
          "fontFamily",
          "fontSize",
          "fontStyle",
          "fontWeight",
          "lineHeight",
          "letterSpacing",
          "padding",
        ] as const) {
          if (measure.style[property] !== style[property])
            measure.style[property] = style[property];
        }
      }
    };

    // Measure a hidden copy so layout probes never repaint the live window.
    const measure = (layout: "normal" | "narrow", width: number) => {
      const copy = app.cloneNode(true) as HTMLDivElement;
      copy.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;width:${width}px`;
      copy.setAttribute("aria-hidden", "true");
      if (layout === "narrow") {
        copy.dataset.compactHeight = "";
        copy.dataset.compactNarrow = "";
      } else {
        delete copy.dataset.compactHeight;
        delete copy.dataset.compactNarrow;
      }
      // Do not create a second media player while measuring the clone.
      for (const media of copy.querySelectorAll("video, audio")) media.removeAttribute("src");
      document.body.appendChild(copy);
      try {
        let height = Math.ceil(Math.max(copy.getBoundingClientRect().height, copy.scrollHeight));
        const overlays = copy.querySelectorAll<HTMLElement>(
          ".feedback-dialog[role=dialog], .encoders-dialog[role=dialog], .update-modal, .audio-track-popup, .trim-options-panel:not([hidden])"
        );
        for (const overlay of overlays) {
          height = Math.max(height, Math.ceil(overlay.getBoundingClientRect().height) + 36);
        }
        return height;
      } finally {
        copy.remove();
      }
    };

    const schedule = () => {
      dirty = true;
      if (running || frame !== null || disposed) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void resize();
      });
    };

    const resize = async () => {
      running = true;
      dirty = false;
      try {
        syncSelectMeasures();
        const [inner, outer, monitor, position] = await Promise.all([
          nativeWindow.innerSize(),
          nativeWindow.outerSize().catch(() => null),
          currentMonitor().catch(() => null),
          nativeWindow.outerPosition().catch(() => null),
        ]);
        if (disposed || window.innerWidth <= 0) return;

        // Native getters can include GTK client-side decorations even when
        // setSize targets the WebView. Calibrate from the last size request
        // that produced a viewport resize, rather than assuming the getter and
        // setter use the same origin. CSS pixels also account for WebView zoom.
        const scale = window.devicePixelRatio || 1;
        if (lastApplied?.scale !== scale) lastApplied = null;
        const chromeWidth = Math.max(0, (outer?.width ?? inner.width) - window.innerWidth * scale);
        const chromeHeight = Math.max(
          0,
          (outer?.height ?? inner.height) - window.innerHeight * scale
        );
        const availableWidth = monitor?.workArea.size.width || window.screen.availWidth * scale;
        const availableHeight = monitor?.workArea.size.height || window.screen.availHeight * scale;
        const tight = (availableHeight - chromeHeight) / scale < 420;
        if (tight !== app.hasAttribute("data-compact-tight")) {
          if (tight) app.dataset.compactTight = "";
          else delete app.dataset.compactTight;
          // The queue can show fewer rows and the import area can reflow on a
          // very short display; measure again after those changes take effect.
          dirty = true;
          return;
        }
        // Keep the horizontal size fixed while the user works. The shared
        // width accommodates the advanced controls and the narrow layout; it
        // is recalculated only when the monitor, work area, or scale changes.
        const nextMonitorKey = JSON.stringify([monitor?.name, monitor?.workArea, scale]);
        if (monitorKey !== nextMonitorKey || stableWidth === 0) {
          monitorKey = nextMonitorKey;
          stableWidth = widthForWorkArea(availableWidth, chromeWidth, scale);
          lastAttempt = "";
        }
        const normalHeight = measure("normal", stableWidth);
        const narrowHeight = measure("narrow", stableWidth);
        const availableCssHeight = (availableHeight - chromeHeight) / scale;
        const narrow = normalHeight + 2 > availableCssHeight && narrowHeight < normalHeight;
        app.toggleAttribute("data-compact-height", narrow);
        app.toggleAttribute("data-compact-narrow", narrow);
        const width = stableWidth;
        const height = narrow ? narrowHeight : normalHeight;
        const widthDelta = width + 2 - window.innerWidth;
        const heightDelta = height + 2 - window.innerHeight;
        if (Math.abs(widthDelta) < 1 && Math.abs(heightDelta) < 1) {
          lastAttempt = "";
          return;
        }
        const target = nativeSizeForContent(
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
          lastApplied ?? { width: window.innerWidth * scale, height: window.innerHeight * scale },
          scale
        );
        const targetWidth = target.width;
        const targetHeight = target.height;
        const attempt = `${window.innerWidth}:${window.innerHeight}:${targetWidth}:${targetHeight}`;
        // A compositor may refuse a size (for example, when it exceeds the
        // screen). Do not spin requesting the same impossible size forever.
        if (attempt === lastAttempt) return;
        lastAttempt = attempt;
        lastIssued = { ...target, scale };
        await nativeWindow.setSize(new PhysicalSize(targetWidth, targetHeight));
        if (monitor && position && outer) {
          const area = monitor.workArea;
          const outerWidth = outer.width + widthDelta * scale;
          const outerHeight = outer.height + heightDelta * scale;
          const x = Math.max(
            area.position.x,
            Math.round(Math.min(position.x, area.position.x + area.size.width - outerWidth))
          );
          const y = Math.max(
            area.position.y,
            Math.round(Math.min(position.y, area.position.y + area.size.height - outerHeight))
          );
          if (x !== position.x || y !== position.y) {
            // Wayland compositors may control placement themselves.
            await nativeWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
          }
        }
      } catch (error) {
        console.warn("Unable to size the desktop window", error);
      } finally {
        running = false;
        if (dirty && !disposed) schedule();
      }
    };

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(app);
    const observedOverlays = new Set<Element>();
    const syncOverlays = () => {
      const overlays = new Set(
        app.querySelectorAll(
          ".feedback-dialog[role=dialog], .encoders-dialog[role=dialog], .update-modal, .audio-track-popup, .trim-options-panel"
        )
      );
      for (const element of observedOverlays) {
        if (!overlays.has(element)) {
          resizeObserver.unobserve(element);
          observedOverlays.delete(element);
        }
      }
      for (const element of overlays) {
        if (!observedOverlays.has(element)) {
          resizeObserver.observe(element);
          observedOverlays.add(element);
        }
      }
      schedule();
    };
    const mutationObserver = new MutationObserver((records) => {
      // Playback time and toast updates do not affect the main layout. Avoid
      // remeasuring the whole window on every video timeupdate.
      const affectsLayout = records.some((record) => {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest(".preview-pane, .toast-container");
      });
      if (affectsLayout) syncOverlays();
    });
    mutationObserver.observe(app, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "open"],
    });
    const onResize = () => {
      if (lastIssued?.scale === (window.devicePixelRatio || 1)) lastApplied = lastIssued;
      schedule();
    };
    window.addEventListener("resize", onResize);
    app.addEventListener("input", schedule);
    app.addEventListener("change", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    void nativeWindow
      .onMoved(schedule)
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenMove = unlisten;
      })
      .catch(() => {});
    syncOverlays();

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      unlistenMove?.();
      window.removeEventListener("resize", onResize);
      app.removeEventListener("input", schedule);
      app.removeEventListener("change", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [appRef]);
}
