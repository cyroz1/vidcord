import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ProbeData = { duration: number; width: number; height: number; bitrate: number };

type Props = {
  onToast: (type: "success" | "error" | "warning" | "info", title: string, msg: string) => void;
};

export function useCompression({ onToast }: Props) {
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState("Ready");

  // Subscribe to backend compression events
  useEffect(() => {
    const unsub1 = listen<{ percent: number; eta: string; status: string }>(
      "compress-progress",
      (e) => {
        setProgress(e.payload.percent);
        setEta(`${e.payload.status} ETA: ${e.payload.eta}`);
      }
    );
    const unsub2 = listen<{ success: boolean; message: string }>("compress-done", (e) => {
      setCompressing(false);
      setProgress(e.payload.success ? 100 : 0);
      setEta(e.payload.message);
    });
    return () => {
      unsub1.then((fn) => fn());
      unsub2.then((fn) => fn());
    };
  }, []);

  const cancelCompress = useCallback(() => {
    invoke("cancel_compression").catch(() => {});
    setCompressing(false);
    setEta("Cancelled");
  }, []);

  const resetProgress = useCallback(() => {
    setProgress(0);
    setEta("Ready");
  }, []);

  return {
    compressing,
    setCompressing,
    progress,
    eta,
    cancelCompress,
    resetProgress,
  };
}

// ---------------------------------------------------------------------------
// Pure calculation helpers (exported for reuse and testability)
// ---------------------------------------------------------------------------

export function calculateBitrate(sizeMb: number, durationSec: number, removeAudio: boolean): number {
  const totalKbits = sizeMb * 1024 * 8;
  const audioKbits = removeAudio ? 0 : 128 * durationSec;
  const videoBitrate = (totalKbits - audioKbits) / durationSec;
  return Math.max(100, Math.floor(videoBitrate * 0.9));
}

export function resolutionToShortSide(choice: string): number | null {
  const map: Record<string, number> = {
    "4k": 2160,
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
  };
  return map[choice.toLowerCase()] ?? null;
}

export function computeTargetDimensions(
  ow: number,
  oh: number,
  targetH: number | null,
  targetShort: number | null
): [number, number] | null {
  if (ow <= 0 || oh <= 0) return null;
  if (targetShort) {
    if (targetShort >= Math.min(ow, oh)) return null;
    const scale = targetShort / Math.min(ow, oh);
    let tw = Math.ceil(ow * scale);
    let th = Math.ceil(oh * scale);
    if (tw % 2 !== 0) tw++;
    if (th % 2 !== 0) th++;
    return [tw, th];
  }
  if (targetH) {
    if (targetH >= oh) return null;
    const th = targetH;
    let tw = Math.ceil((ow / oh) * th);
    if (tw % 2 !== 0) tw++;
    return [tw, th];
  }
  return null;
}
