import { useEffect, useRef, useState, useCallback } from "react";
import { loadSettings, saveSettings as persistSettings, type Settings } from "../ipc";

export function useSettings() {
  const settingsRef = useRef<Settings>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Persisted settings values
  const [qualityIdx, setQualityIdx] = useState(0);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advSize, setAdvSize] = useState("");
  const [advResolution, setAdvResolution] = useState("Native");
  const [fpsOption, setFpsOption] = useState("off");
  const [advFps, setAdvFps] = useState("");
  const [advEncoder, setAdvEncoder] = useState("");
  const [removeAudio, setRemoveAudio] = useState(false);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [completionAction, setCompletionAction] = useState<"open_folder" | "copy_clipboard">(
    "open_folder"
  );

  useEffect(() => {
    (async () => {
      const s = await loadSettings().catch((): Settings => ({}));
      settingsRef.current = s;
      if (typeof s.quality_index === "number") setQualityIdx(s.quality_index);
      if (typeof s.advanced_mode === "boolean") setAdvancedMode(s.advanced_mode);
      if (typeof s.advanced_target_size === "string") setAdvSize(s.advanced_target_size);
      if (typeof s.advanced_resolution === "string") setAdvResolution(s.advanced_resolution);
      if (typeof s.fps_option === "string") setFpsOption(s.fps_option);
      if (typeof s.advanced_fps === "string") setAdvFps(s.advanced_fps);
      if (typeof s.advanced_encoder === "string") setAdvEncoder(s.advanced_encoder);
      if (typeof s.remove_audio === "boolean") setRemoveAudio(s.remove_audio);
      if (typeof s.output_directory === "string") {
        setOutputDirectory(s.output_directory);
      }
      if (s.completion_action === "open_folder" || s.completion_action === "copy_clipboard") {
        setCompletionAction(s.completion_action);
      }
      setSettingsLoaded(true);
    })();
  }, []);

  const saveSettings = useCallback((patch: Settings) => {
    settingsRef.current = { ...settingsRef.current, ...patch };
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      persistSettings(settingsRef.current).catch(() => {});
    }, 250);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        // Flush any pending write so a change made within the 250 ms debounce
        // window isn't lost if the component unmounts (or the window closes)
        // before the timer fires. Settings payload is tiny — no perf concern.
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        persistSettings(settingsRef.current).catch(() => {});
      }
    };
  }, []);

  return {
    settingsRef,
    settingsLoaded,
    qualityIdx,
    setQualityIdx,
    advancedMode,
    setAdvancedMode,
    advSize,
    setAdvSize,
    advResolution,
    setAdvResolution,
    fpsOption,
    setFpsOption,
    advFps,
    setAdvFps,
    advEncoder,
    setAdvEncoder,
    removeAudio,
    setRemoveAudio,
    outputDirectory,
    setOutputDirectory,
    completionAction,
    setCompletionAction,
    saveSettings,
  };
}
