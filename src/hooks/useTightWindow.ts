import { useEffect, useState, type RefObject } from "react";

/** Observe the desktop layout's very-short-work-area setting. */
export function useTightWindow(ref: RefObject<HTMLElement>): boolean {
  const [tight, setTight] = useState(false);
  useEffect(() => {
    const app = ref.current?.closest(".app");
    if (!app) return;
    const update = () => setTight(app.hasAttribute("data-compact-tight"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(app, { attributes: true, attributeFilter: ["data-compact-tight"] });
    return () => observer.disconnect();
  }, [ref]);
  return tight;
}
