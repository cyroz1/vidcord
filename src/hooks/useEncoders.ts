import { useCallback, useEffect, useRef, useState } from "react";
import { detectEncoders, type Encoder } from "../ipc";

export type { Encoder };

export function selectEncoderIndex(
  encoders: Encoder[],
  savedEncoderLabel: string | undefined,
  savedEncoderIndex: number
): number {
  if (encoders.length === 0) return 0;
  if (savedEncoderLabel) {
    const labelIndex = encoders.findIndex((encoder) => encoder.label === savedEncoderLabel);
    if (labelIndex >= 0) return labelIndex;
  }
  return Math.max(0, Math.min(savedEncoderIndex, encoders.length - 1));
}

type Props = {
  settingsLoaded: boolean;
  savedEncoderLabel: string | undefined;
  savedEncoderIndex: number;
  onFfmpegMissing: () => void;
};

export function useEncoders({
  settingsLoaded,
  savedEncoderLabel,
  savedEncoderIndex,
  onFfmpegMissing,
}: Props) {
  const [encoders, setEncoders] = useState<Encoder[]>([
    { name: "libx264", label: "CPU (libx264)" },
  ]);
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
  const onFfmpegMissingRef = useRef(onFfmpegMissing);
  useEffect(() => {
    savedEncoderLabelRef.current = savedEncoderLabel;
    savedEncoderIndexRef.current = savedEncoderIndex;
    settingsLoadedRef.current = settingsLoaded;
    onFfmpegMissingRef.current = onFfmpegMissing;
  }, [savedEncoderLabel, savedEncoderIndex, settingsLoaded, onFfmpegMissing]);

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
      if (list.length > 0) {
        const missing = Boolean(list[0].ffmpeg_missing);
        if (missing) markFfmpegMissing();
        else clearFfmpegMissing();
        const detected = list.map(({ name, label }) => ({ name, label }));
        detectedEncodersRef.current = detected;
        setEncoders(detected);
        if (settingsLoadedRef.current) {
          setEncoderIdx(
            selectEncoderIndex(
              detected,
              savedEncoderLabelRef.current,
              savedEncoderIndexRef.current
            )
          );
        }
      }
    });
  }, [clearFfmpegMissing, markFfmpegMissing]);

  useEffect(() => {
    // Encoder discovery does not depend on settings I/O. Start it immediately,
    // then reconcile the saved selection once both operations have completed.
    refreshEncoders().catch(() => {});
  }, [refreshEncoders]);

  useEffect(() => {
    if (!settingsLoaded || !detectedEncodersRef.current) return;
    setEncoderIdx(
      selectEncoderIndex(detectedEncodersRef.current, savedEncoderLabel, savedEncoderIndex)
    );
  }, [savedEncoderIndex, savedEncoderLabel, settingsLoaded]);

  return { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders, markFfmpegMissing };
}
