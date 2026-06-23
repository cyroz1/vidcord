import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Encoder = { name: string; label: string };

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

  // Keep the latest prop values in refs so `refreshEncoders` can have an
  // empty dep array — a stable identity means downstream useCallbacks in
  // App.tsx (retryFfmpegDetection, installFfmpeg) don't invalidate every
  // render.
  const savedEncoderLabelRef = useRef(savedEncoderLabel);
  const savedEncoderIndexRef = useRef(savedEncoderIndex);
  const onFfmpegMissingRef = useRef(onFfmpegMissing);
  useEffect(() => {
    savedEncoderLabelRef.current = savedEncoderLabel;
    savedEncoderIndexRef.current = savedEncoderIndex;
    onFfmpegMissingRef.current = onFfmpegMissing;
  }, [savedEncoderLabel, savedEncoderIndex, onFfmpegMissing]);

  const refreshEncoders = useCallback(() => {
    return invoke<Encoder[]>("detect_encoders").then((list) => {
      if (list.length > 0) {
        const missing = Boolean((list[0] as Encoder & { ffmpeg_missing?: boolean }).ffmpeg_missing);
        setFfmpegMissing(missing);
        if (missing && !missingNotifiedRef.current) {
          missingNotifiedRef.current = true;
          onFfmpegMissingRef.current();
        }
        if (!missing) {
          missingNotifiedRef.current = false;
        }
        setEncoders(list.map(({ name, label }) => ({ name, label })));
        const label = savedEncoderLabelRef.current;
        if (label) {
          const idx = list.findIndex((e) => e.label === label);
          if (idx >= 0) {
            setEncoderIdx(idx);
            return;
          }
        }
        setEncoderIdx(Math.min(savedEncoderIndexRef.current, list.length - 1));
      }
    });
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    refreshEncoders().catch(() => {});
  }, [settingsLoaded, refreshEncoders]);

  return { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders };
}
