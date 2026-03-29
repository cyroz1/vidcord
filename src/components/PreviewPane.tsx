import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  filePath: string | null;
  startTime: number;
  endTime: number;
  probeData: { duration: number; width: number; height: number } | null;
};

export default function PreviewPane({ filePath, startTime, endTime, probeData }: Props) {
  const [frameB64, setFrameB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const fetchFrame = useCallback(async (path: string, time: number) => {
    activeRef.current = true;
    setLoading(true);
    try {
      const b64 = await invoke<string>("get_preview_frame", { path, timeSec: time });
      if (activeRef.current) setFrameB64(b64);
    } catch {
      // no-op
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!filePath || !probeData) {
      activeRef.current = false;
      setFrameB64(null);
      return;
    }
    activeRef.current = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchFrame(filePath, startTime);
    }, 150);
    return () => {
      activeRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [filePath, startTime, fetchFrame, probeData]);

  const aspect = probeData ? probeData.width / probeData.height : 16 / 9;

  return (
    <div style={{
      background: "var(--surface)",
      borderRadius: "var(--radius)",
      overflow: "hidden",
      position: "relative",
      width: "100%",
      aspectRatio: `${aspect}`,
      maxHeight: "220px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      {frameB64 ? (
        <img
          src={`data:image/jpeg;base64,${frameB64}`}
          alt="preview"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          {loading ? "Loading preview…" : filePath ? "Preview" : "No file selected"}
        </span>
      )}
      {probeData && (
        <div style={{
          position: "absolute",
          bottom: "6px",
          right: "8px",
          fontSize: "11px",
          color: "rgba(255,255,255,0.7)",
          background: "rgba(0,0,0,0.5)",
          borderRadius: "4px",
          padding: "2px 6px",
        }}>
          {probeData.width}×{probeData.height} · {probeData.duration.toFixed(1)}s
        </div>
      )}
      {/* Time indicator */}
      {probeData && probeData.duration > 0 && (
        <div style={{
          position: "absolute",
          bottom: "6px",
          left: "8px",
          fontSize: "11px",
          color: "rgba(255,255,255,0.7)",
          background: "rgba(0,0,0,0.5)",
          borderRadius: "4px",
          padding: "2px 6px",
        }}>
          {startTime.toFixed(1)}s → {endTime.toFixed(1)}s
        </div>
      )}
    </div>
  );
}
