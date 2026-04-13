import { useEffect, useRef, useState } from "react";
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
  const [encoders, setEncoders] = useState<Encoder[]>([{ name: "libx264", label: "CPU (libx264)" }]);
  const [encoderIdx, setEncoderIdx] = useState(0);
  const [ffmpegMissing, setFfmpegMissing] = useState(false);
  const missingNotifiedRef = useRef(false);

  const refreshEncoders = () => {
    return invoke<Encoder[]>("detect_encoders").then((list) => {
      if (list.length > 0) {
        const missing = Boolean((list[0] as Encoder & { ffmpeg_missing?: boolean }).ffmpeg_missing);
        setFfmpegMissing(missing);
        if (missing && !missingNotifiedRef.current) {
          missingNotifiedRef.current = true;
          onFfmpegMissing();
        }
        if (!missing) {
          missingNotifiedRef.current = false;
        }
        setEncoders(list.map(({ name, label }) => ({ name, label })));
        if (savedEncoderLabel) {
          const idx = list.findIndex((e) => e.label === savedEncoderLabel);
          if (idx >= 0) {
            setEncoderIdx(idx);
            return;
          }
        }
        setEncoderIdx(Math.min(savedEncoderIndex, list.length - 1));
      }
    });
  };

  useEffect(() => {
    if (!settingsLoaded) return;
    refreshEncoders().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  return { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders };
}
