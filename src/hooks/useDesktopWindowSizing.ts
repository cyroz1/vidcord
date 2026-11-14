import { useEffect, type RefObject } from "react";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../ipc";
import {
  isSettledSize,
  nativeSizeForContent,
  shouldUseNarrowLayout,
  widthForWorkArea,
} from "../windowSizing";

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
    let narrowBaseWidth = 0;
    let lastWorkflowMode = app.dataset.workflowMode;
    let lastSettledWidth = 0;
    let lastSettledHeight = 0;
    let unlistenMove: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    let lastIssued: { width: number; height: number; scale: number } | null = null;
    let lastApplied: { width: number; height: number; scale: number } | null = null;

    const syncSelectMeasures = (root: HTMLElement = app) => {
      for (const wrapper of root.querySelectorAll<HTMLElement>(".sized-select")) {
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

    // Measure each arrangement's minimum width without overlays, which are
    // positioned independently of the main content.
    const measureMinimumWidth = (layout: "normal" | "narrow") => {
      const copy = app.cloneNode(true) as HTMLDivElement;
      copy.style.cssText =
        "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;width:min-content";
      copy.setAttribute("aria-hidden", "true");
      if (layout === "narrow") {
        copy.dataset.compactHeight = "";
        copy.dataset.compactNarrow = "";
      } else {
        delete copy.dataset.compactHeight;
        delete copy.dataset.compactNarrow;
      }
      for (const media of copy.querySelectorAll("video, audio")) media.removeAttribute("src");
      for (const overlay of copy.querySelectorAll(
        ".feedback-dialog[role=dialog], .encoders-dialog[role=dialog], .update-modal, .audio-track-popup, .trim-options-panel, .encoder-options, .toast-container"
      ))
        overlay.remove();
      document.body.appendChild(copy);
      try {
        syncSelectMeasures(copy);
        // In the normal row, the encoder takes leftover width, so its full
        // label must contribute to the minimum. In the compact grid the row
        // already has its own width; forcing max-content there can make a
        // usable short-screen arrangement appear wider than the monitor.
        if (layout === "normal") {
          for (const wrapper of copy.querySelectorAll<HTMLElement>(".encoder-row .sized-select")) {
            wrapper.style.minWidth = "max-content";
          }
        }
        return Math.ceil(Math.max(copy.getBoundingClientRect().width, copy.scrollWidth));
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
        // Start with the preview's usual footprint and expand when content
        // needs more room. The compact arrangement trades width for height.
        const nextMonitorKey = JSON.stringify([monitor?.name, monitor?.workArea, scale]);
        if (monitorKey !== nextMonitorKey || stableWidth === 0) {
          monitorKey = nextMonitorKey;
          stableWidth = widthForWorkArea(availableWidth, chromeWidth, scale);
          narrowBaseWidth = 0;
          lastSettledWidth = 0;
          lastSettledHeight = 0;
          lastAttempt = "";
        }
        const availableCssWidth = Math.floor((availableWidth - chromeWidth) / scale) - 2;
        const workflowMode = app.dataset.workflowMode;
        if (workflowMode !== lastWorkflowMode) {
          // Some native window managers deliver a viewport wider than the
          // last request. Preserve the width the user actually saw when
          // switching modes, rather than shrinking to the earlier request.
          if (narrowBaseWidth > 0 && app.hasAttribute("data-compact-narrow")) {
            narrowBaseWidth = Math.max(
              narrowBaseWidth,
              Math.min(window.innerWidth - 2, availableCssWidth)
            );
          }
          lastWorkflowMode = workflowMode;
        }
        // Retain the first compact width as a floor on this monitor. Later
        // label changes may grow the window, then shrink it back to that
        // floor when the extra space is no longer needed.
        const normalMinWidth = measureMinimumWidth("normal");
        // nativeSizeForContent adds two pixels of viewport clearance. Count
        // that clearance toward the measured minimum rather than widening
        // the window by two pixels when the current viewport already fits.
        const normalWidth = Math.max(stableWidth, Math.min(normalMinWidth - 2, availableCssWidth));
        const narrowMinWidth = measureMinimumWidth("narrow");
        const measuredNarrowWidth = Math.max(
          normalWidth,
          Math.min(narrowMinWidth, availableCssWidth)
        );
        const narrowWidth = Math.max(narrowBaseWidth, measuredNarrowWidth);
        const normalHeight = measure("normal", normalWidth);
        const narrowHeight = measure("narrow", narrowWidth);
        const availableCssHeight = (availableHeight - chromeHeight) / scale;
        const narrow = shouldUseNarrowLayout(
          normalHeight,
          narrowHeight,
          narrowMinWidth,
          availableCssWidth,
          availableCssHeight,
          // Compact queues use fewer rows. A normal-layout clone still has
          // that reduced row count until React sees the wider queue, so
          // switching back would immediately restore rows and overflow again.
          app.dataset.workflowMode === "batch" && app.hasAttribute("data-compact-narrow")
        );
        app.toggleAttribute("data-compact-height", narrow);
        app.toggleAttribute("data-compact-narrow", narrow);
        // Switching modes can flip the arrangement (a shorter mode fits the
        // normal layout again). Once the narrow arrangement has engaged on
        // this monitor, keep its width for the normal arrangement too, so
        // the window does not change width mid-session on mode switches.
        if (narrow) {
          if (narrowBaseWidth === 0) narrowBaseWidth = narrowWidth;
        }
        const width = narrow ? narrowWidth : Math.max(narrowBaseWidth, normalWidth);
        const contentHeight = narrow
          ? narrowHeight
          : width === normalWidth
            ? normalHeight
            : measure("normal", width);
        // When neither arrangement fits, keep the window in the work area;
        // the root scroll container makes the remaining content reachable.
        const height = Math.min(contentHeight, Math.max(1, Math.floor(availableCssHeight) - 2));
        // The widths are anchored, but the height is re-measured fresh on
        // every pass. At fractional display scales the achieved viewport
        // height rounds differently from run to run, so the measured
        // content height can alternate by a pixel or two around the
        // applied size and the window resizes back and forth forever,
        // visible as flicker along its bottom edge. Once a height has been
        // applied for this width, keep it while fresh measurements stay
        // within a couple of pixels; real layout changes (mode switches,
        // extra rows appearing) move the height by far more than that.
        if (
          isSettledSize(
            width,
            height,
            { width: lastSettledWidth, height: lastSettledHeight },
            { width: window.innerWidth, height: window.innerHeight }
          )
        ) {
          lastAttempt = "";
          return;
        }
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
        lastSettledWidth = width;
        lastSettledHeight = height;
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
        lastAttempt = "";
        lastIssued = null;
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
      // Playback, toast, and progress text updates do not affect the main
      // layout. Avoid remeasuring the whole window for high-frequency changes.
      const affectsLayout = records.some((record) => {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest(
          ".preview-pane, .toast-container, .progress-status, .batch-queue-progress"
        );
      });
      if (affectsLayout) syncOverlays();
    });
    mutationObserver.observe(app, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "open", "data-workflow-mode"],
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
    void nativeWindow
      .onScaleChanged(() => {
        // Requests made for the previous monitor cannot calibrate the new
        // scale, even if WebKit has not updated devicePixelRatio yet.
        lastIssued = null;
        lastApplied = null;
        monitorKey = "";
        lastAttempt = "";
        schedule();
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenScale = unlisten;
      })
      .catch(() => {});
    syncOverlays();

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      unlistenMove?.();
      unlistenScale?.();
      window.removeEventListener("resize", onResize);
      app.removeEventListener("input", schedule);
      app.removeEventListener("change", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [appRef]);
}
