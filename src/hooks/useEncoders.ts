import { useCallback, useEffect, useRef, useState } from "react";
import { detectEncoders, type Encoder } from "../ipc";

export type { Encoder };

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

  // Keep the latest prop values in refs so the stable marker callbacks below
  // can notify through the current toast handler without invalidating
  // downstream useCallbacks in App.tsx on every render.
  const savedEncoderLabelRef = useRef(savedEncoderLabel);
  const savedEncoderIndexRef = useRef(savedEncoderIndex);
  const onFfmpegMissingRef = useRef(onFfmpegMissing);
  useEffect(() => {
    savedEncoderLabelRef.current = savedEncoderLabel;
    savedEncoderIndexRef.current = savedEncoderIndex;
    onFfmpegMissingRef.current = onFfmpegMissing;
  }, [savedEncoderLabel, savedEncoderIndex, onFfmpegMissing]);

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
  }, [clearFfmpegMissing, markFfmpegMissing]);

  useEffect(() => {
    if (!settingsLoaded) return;
    refreshEncoders().catch(() => {});
  }, [settingsLoaded, refreshEncoders]);

  return { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders, markFfmpegMissing };
}
