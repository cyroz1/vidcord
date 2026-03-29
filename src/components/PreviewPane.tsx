import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

type Props = {
  filePath: string | null;
  startTime: number;
  endTime: number;
  probeData: { duration: number; width: number; height: number } | null;
};

export default function PreviewPane({ filePath, startTime, endTime, probeData }: Props) {
  const [frameB64, setFrameB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------------------------------------------------------------------
  // Frame preview (static JPEG)
  // ---------------------------------------------------------------------------
  const fetchFrame = useCallback(async (path: string, time: number) => {
    activeRef.current = true;
    setLoading(true);
    try {
      const b64 = await invoke<string>("get_preview_frame", { path, timeSec: time });
      if (activeRef.current) setFrameB64(b64);
    } catch {
      if (activeRef.current) setFrameB64(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!filePath || !probeData) {
      activeRef.current = false;
      setFrameB64(null);
      stopPlayback();
      return;
    }
    activeRef.current = false;
    stopPlayback();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchFrame(filePath, startTime);
    }, 150);
    return () => {
      activeRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, startTime, fetchFrame, probeData]);

  // ---------------------------------------------------------------------------
  // Video playback
  // ---------------------------------------------------------------------------
  const stopPlayback = useCallback(() => {
    if (stopTimerRef.current) {
      clearInterval(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    const vid = videoRef.current;
    if (vid) {
      vid.pause();
      vid.src = "";
    }
    setPlaying(false);
  }, []);

  const startPlayback = useCallback(() => {
    if (!filePath || !probeData) return;
    const vid = videoRef.current;
    if (!vid) return;

    const src = convertFileSrc(filePath);
    vid.src = src;
    vid.currentTime = startTime;

    vid.oncanplay = () => {
      vid.currentTime = startTime;
      vid.play().catch(() => stopPlayback());
      setPlaying(true);

      // Poll position and stop at endTime
      if (stopTimerRef.current) clearInterval(stopTimerRef.current);
      stopTimerRef.current = setInterval(() => {
        if (vid.currentTime >= endTime || vid.ended) {
          stopPlayback();
        }
      }, 100);
    };

    vid.onerror = () => stopPlayback();
  }, [filePath, probeData, startTime, endTime, stopPlayback]);

  // Stop playback when trim range changes
  useEffect(() => {
    stopPlayback();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, endTime]);

  // Cleanup on unmount
  useEffect(() => () => {
    stopPlayback();
    if (debounceRef.current) clearTimeout(debounceRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const aspect = probeData ? probeData.width / probeData.height : 16 / 9;
  const canPlay = !!filePath && !!probeData && endTime > startTime;

  return (
    <div
      style={{
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
        cursor: canPlay ? "default" : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Static frame preview */}
      {frameB64 && !playing ? (
        <img
          src={`data:image/jpeg;base64,${frameB64}`}
          alt="preview"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : !playing ? (
        <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          {loading ? "Loading preview…" : filePath ? "Preview" : "No file selected"}
        </span>
      ) : null}

      {/* Video element for playback */}
      <video
        ref={videoRef}
        style={{
          display: playing ? "block" : "none",
          width: "100%",
          height: "100%",
          objectFit: "contain",
          background: "#000",
        }}
        onEnded={stopPlayback}
      />

      {/* Play/Stop overlay buttons — show on hover when preview is ready */}
      {canPlay && hovered && (
        <div style={{
          position: "absolute",
          display: "flex",
          gap: "12px",
          alignItems: "center",
          justifyContent: "center",
        }}>
          {!playing ? (
            <button
              onClick={startPlayback}
              title="Play trim segment"
              style={overlayBtnStyle}
            >
              {/* Play triangle */}
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <polygon points="6,4 18,11 6,18" fill="white" />
              </svg>
            </button>
          ) : (
            <button
              onClick={stopPlayback}
              title="Stop playback"
              style={overlayBtnStyle}
            >
              {/* Stop square */}
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <rect x="5" y="5" width="12" height="12" rx="2" fill="white" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Info overlay */}
      {probeData && (
        <div style={{
          position: "absolute", bottom: "6px", right: "8px",
          fontSize: "11px", color: "rgba(255,255,255,0.85)",
          background: "rgba(0,0,0,0.55)", borderRadius: "4px", padding: "2px 6px",
          pointerEvents: "none",
        }}>
          {probeData.width}×{probeData.height} · {probeData.duration.toFixed(1)}s
        </div>
      )}
      {probeData && probeData.duration > 0 && (
        <div style={{
          position: "absolute", bottom: "6px", left: "8px",
          fontSize: "11px", color: "rgba(255,255,255,0.85)",
          background: "rgba(0,0,0,0.55)", borderRadius: "4px", padding: "2px 6px",
          pointerEvents: "none",
        }}>
          {startTime.toFixed(1)}s → {endTime.toFixed(1)}s
        </div>
      )}
    </div>
  );
}

const overlayBtnStyle: React.CSSProperties = {
  background: "linear-gradient(135deg, rgba(255,255,255,0.27) 0%, rgba(255,255,255,0.12) 100%)",
  border: "1px solid rgba(255,255,255,0.63)",
  borderRadius: "50%",
  width: "48px",
  height: "48px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  backdropFilter: "blur(4px)",
};
