import { useCallback, useEffect, useRef, useState } from "react";
import { detectEncoders, type Encoder } from "../ipc";

export type { Encoder };

const FALLBACK_ENCODERS: Encoder[] = [{ name: "libx264", label: "CPU (libx264)" }];
const MAX_CACHED_ENCODERS = 32;
const ENCODER_NAME_RE = /^[A-Za-z0-9_]+$/;
const PREFERRED_H264_HARDWARE_ENCODERS = new Set([
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
  "h264_vaapi",
  "h264_videotoolbox",
]);
const STARTUP_REFRESH_SETTLE_MS = 900;

export function getEncoderRefreshDelay(
  settingsLoaded: boolean,
  startupBusy: boolean
): number | null {
  return settingsLoaded && !startupBusy ? STARTUP_REFRESH_SETTLE_MS : null;
}

export function parseCachedEncoders(value: unknown): Encoder[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CACHED_ENCODERS) return [];

  const parsed: Encoder[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      !record.name ||
      !ENCODER_NAME_RE.test(record.name) ||
      typeof record.label !== "string" ||
      !record.label.trim() ||
      record.label.length > 100
    ) {
      return [];
    }
    if (record.auto_selectable !== undefined && typeof record.auto_selectable !== "boolean") {
      return [];
    }
    parsed.push({
      name: record.name,
      label: record.label,
      ...(typeof record.auto_selectable === "boolean"
        ? { auto_selectable: record.auto_selectable }
        : {}),
    });
  }
  return parsed;
}

export function selectEncoderIndex(
  encoders: Encoder[],
  savedEncoderLabel: string | undefined,
  savedEncoderIndex: number
): number {
  if (encoders.length === 0) return 0;
  if (savedEncoderLabel) {
    const labelIndex = encoders.findIndex((encoder) => encoder.label === savedEncoderLabel);
    if (labelIndex >= 0) return labelIndex;
    return Math.max(0, Math.min(savedEncoderIndex, encoders.length - 1));
  }
  const hardwareIndex = encoders.findIndex(
    (encoder) =>
      PREFERRED_H264_HARDWARE_ENCODERS.has(encoder.name) && encoder.auto_selectable === true
  );
  return hardwareIndex >= 0 ? hardwareIndex : 0;
}

function encoderListsEqual(left: Encoder[] | null, right: Encoder[]): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    left.every(
      (encoder, index) =>
        encoder.name === right[index].name &&
        encoder.label === right[index].label &&
        encoder.auto_selectable === right[index].auto_selectable
    )
  );
}

type Props = {
  settingsLoaded: boolean;
  startupBusy: boolean;
  savedEncoderLabel: string | undefined;
  savedEncoderIndex: number;
  cachedEncoders: unknown;
  onEncodersDetected: (encoders: Encoder[]) => void;
  onFfmpegMissing: () => void;
};

export function useEncoders({
  settingsLoaded,
  startupBusy,
  savedEncoderLabel,
  savedEncoderIndex,
  cachedEncoders,
  onEncodersDetected,
  onFfmpegMissing,
}: Props) {
  const [encoders, setEncoders] = useState<Encoder[]>(FALLBACK_ENCODERS);
  const [encoderIdx, setEncoderIdx] = useState(0);
  const [ffmpegMissing, setFfmpegMissing] = useState(false);
  const missingNotifiedRef = useRef(false);
  const detectedEncodersRef = useRef<Encoder[] | null>(null);

  // Keep the latest prop values in refs so the stable marker callbacks below
  // can notify through the current toast handler without invalidating
  // downstream useCallbacks in App.tsx on every render.
  const savedEncoderLabelRef = useRef(savedEncoderLabel);
  const savedEncoderIndexRef = useRef(savedEncoderIndex);
  const settingsLoadedRef = useRef(settingsLoaded);
  const onEncodersDetectedRef = useRef(onEncodersDetected);
  const onFfmpegMissingRef = useRef(onFfmpegMissing);
  useEffect(() => {
    savedEncoderLabelRef.current = savedEncoderLabel;
    savedEncoderIndexRef.current = savedEncoderIndex;
    settingsLoadedRef.current = settingsLoaded;
    onEncodersDetectedRef.current = onEncodersDetected;
    onFfmpegMissingRef.current = onFfmpegMissing;
  }, [savedEncoderLabel, savedEncoderIndex, settingsLoaded, onEncodersDetected, onFfmpegMissing]);

  const markFfmpegMissing = useCallback(() => {
    setFfmpegMissing(true);
    if (!missingNotifiedRef.current) {
      missingNotifiedRef.current = true;
      onFfmpegMissingRef.current();
    }
  }, []);

  const clearFfmpegMissing = useCallback(() => {
    setFfmpegMissing(false);
    missingNotifiedRef.current = false;
  }, []);

  const refreshEncoders = useCallback(() => {
    return detectEncoders().then((list) => {
      if (list.length === 0) return false;

      const missing = Boolean(list[0].ffmpeg_missing);
      if (missing) markFfmpegMissing();
      else clearFfmpegMissing();
      const detected = list.map(({ name, label, auto_selectable }) => ({
        name,
        label,
        auto_selectable,
      }));
      const capabilitiesChanged = !encoderListsEqual(detectedEncodersRef.current, detected);
      detectedEncodersRef.current = detected;
      if (capabilitiesChanged) {
        setEncoders(detected);
        if (!missing) onEncodersDetectedRef.current(detected);
      }
      if (settingsLoadedRef.current) {
        setEncoderIdx(
          selectEncoderIndex(detected, savedEncoderLabelRef.current, savedEncoderIndexRef.current)
        );
      }
      return !missing;
    });
  }, [clearFfmpegMissing, markFfmpegMissing]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const cached = parseCachedEncoders(cachedEncoders);
    if (cached.length === 0) return;
    detectedEncodersRef.current = cached;
    setEncoders(cached);
    setEncoderIdx(selectEncoderIndex(cached, savedEncoderLabel, savedEncoderIndex));
  }, [cachedEncoders, savedEncoderIndex, savedEncoderLabel, settingsLoaded]);

  useEffect(() => {
    const refreshDelay = getEncoderRefreshDelay(settingsLoaded, startupBusy);
    if (refreshDelay === null) return;

    // Use the persisted capability list for the first interactive render and
    // wait for a quiet startup window before refreshing it. requestIdleCallback
    // can run before a cold Open With event reaches React, so a short settle
    // timer is required in addition to the browser's idle signal.
    let idleId: number | null = null;
    const run = () => {
      refreshEncoders().catch(() => {});
    };
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(run, { timeout: 1_500 });
      } else {
        run();
      }
    }, refreshDelay);
    return () => {
      window.clearTimeout(timer);
      if (idleId !== null) window.cancelIdleCallback(idleId);
    };
  }, [refreshEncoders, settingsLoaded, startupBusy]);

  useEffect(() => {
    if (!settingsLoaded || !detectedEncodersRef.current) return;
    setEncoderIdx(
      selectEncoderIndex(detectedEncodersRef.current, savedEncoderLabel, savedEncoderIndex)
    );
  }, [savedEncoderIndex, savedEncoderLabel, settingsLoaded]);

  return { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders, markFfmpegMissing };
}
