import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelCompression, type ProbeData } from "../ipc";

export type { ProbeData };

type Props = {
  onToast: (type: "success" | "error" | "warning" | "info", title: string, msg: string) => void;
};

export type CompressProgressPayload = {
  percent: number;
  eta: string;
  status: string;
  attempt?: number;
  attempt_total?: number;
  encoder?: string;
  video_bitrate_k?: number;
};

export type CompressDonePayload = {
  success: boolean;
  cancelled?: boolean;
  message: string;
  output_size_bytes?: number;
  target_size_bytes?: number;
  smallest_output_size_bytes?: number;
};

export function useCompression({ onToast: _onToast }: Props) {
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState("Ready");

  // Subscribe to backend compression events
  useEffect(() => {
    const unsub1 = listen<CompressProgressPayload>("compress-progress", (e) => {
      setProgress(e.payload.percent);
      setEta(formatCompressionProgress(e.payload));
    });
    const unsub2 = listen<CompressDonePayload>("compress-done", (e) => {
      setCompressing(false);
      setProgress(e.payload.success ? 100 : 0);
      setEta(formatCompressionDone(e.payload));
    });
    return () => {
      unsub1.then((fn) => fn());
      unsub2.then((fn) => fn());
    };
  }, []);

  const cancelCompress = useCallback(() => {
    cancelCompression().catch(() => {});
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

export function formatSizeMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (!Number.isFinite(mb) || mb < 0) return "0 MB";
  if (mb >= 100) return `${mb.toFixed(0)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}

export function formatCompressionProgress(payload: CompressProgressPayload): string {
  const details: string[] = [];
  if (
    typeof payload.attempt === "number" &&
    typeof payload.attempt_total === "number" &&
    payload.attempt_total > 1
  ) {
    details.push(`Attempt ${payload.attempt}`);
  }
  if (payload.encoder) details.push(payload.encoder);
  if (typeof payload.video_bitrate_k === "number") {
    details.push(`${payload.video_bitrate_k} kbps`);
  }
  if (details.length > 0) return `${details.join(" · ")} · ETA: ${payload.eta}`;
  return `${payload.status} ETA: ${payload.eta}`;
}

export function formatCompressionDone(payload: CompressDonePayload): string {
  if (payload.success && typeof payload.output_size_bytes === "number") {
    const target =
      typeof payload.target_size_bytes === "number"
        ? ` (target ${formatSizeMb(payload.target_size_bytes)})`
        : "";
    return `Compressed to ${formatSizeMb(payload.output_size_bytes)}${target}.`;
  }
  if (
    !payload.success &&
    typeof payload.smallest_output_size_bytes === "number" &&
    typeof payload.target_size_bytes === "number"
  ) {
    return `Smallest result was ${formatSizeMb(
      payload.smallest_output_size_bytes
    )}, above target ${formatSizeMb(payload.target_size_bytes)}.`;
  }
  return payload.message;
}

export function calculateBitrate(
  sizeMb: number,
  durationSec: number,
  removeAudio: boolean
): number {
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
