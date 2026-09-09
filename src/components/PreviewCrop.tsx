import { useEffect, useRef, useState, type ReactNode } from "react";

/** Fit a centered crop inside the preview without changing its outer frame. */
export default function PreviewCrop({ crop, children }: { crop: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [frameRatio, setFrameRatio] = useState(16 / 9);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setFrameRatio(width / height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [width, height] = crop.split(":").map(Number);
  const ratio = width > 0 && height > 0 ? width / height : null;
  return (
    <div
      ref={ref}
      style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}
    >
      <div
        className={ratio ? "preview-crop-active" : undefined}
        style={{
          position: "relative",
          overflow: "hidden",
          width: `${ratio ? Math.min(1, ratio / frameRatio) * 100 : 100}%`,
          height: `${ratio ? Math.min(1, frameRatio / ratio) * 100 : 100}%`,
          display: "grid",
          placeItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
