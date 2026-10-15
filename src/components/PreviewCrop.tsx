import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const outerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
};

const innerBaseStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  display: "grid",
  placeItems: "center",
};

/** Fit a centered crop inside the preview without changing its outer frame. */
export default memo(function PreviewCrop({
  crop,
  children,
}: {
  crop: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [frameRatio, setFrameRatio] = useState(16 / 9);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        const nextRatio = width / height;
        setFrameRatio((current) => (current === nextRatio ? current : nextRatio));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const ratio = useMemo(() => {
    const [width, height] = crop.split(":").map(Number);
    return width > 0 && height > 0 ? width / height : null;
  }, [crop]);
  const innerStyle = useMemo<CSSProperties>(
    () => ({
      ...innerBaseStyle,
      width: `${ratio ? Math.min(1, ratio / frameRatio) * 100 : 100}%`,
      height: `${ratio ? Math.min(1, frameRatio / ratio) * 100 : 100}%`,
    }),
    [ratio, frameRatio]
  );
  return (
    <div ref={ref} style={outerStyle}>
      <div className={ratio ? "preview-crop-active" : undefined} style={innerStyle}>
        {children}
      </div>
    </div>
  );
});
