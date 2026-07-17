import { useEffect, useRef, useState, useCallback } from "react";
import { loadSettings, saveSettings as persistSettings, type Settings } from "../ipc";

export type OutputDestination = "downloads" | "source" | "ask" | "custom";
export type CompletionAction = "reveal" | "copy";

export function useSettings() {
  const settingsRef = useRef<Settings>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Persisted settings values
  const [qualityIdx, setQualityIdx] = useState(0);
  const [gifMode, setGifMode] = useState(false);
  const [gifQualityIdx, setGifQualityIdx] = useState(0);
  const [gifFps, setGifFps] = useState(15);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advSize, setAdvSize] = useState("");
  const [advResolution, setAdvResolution] = useState("Native");
  const [fpsOption, setFpsOption] = useState("off");
  const [advFps, setAdvFps] = useState("");
  const [advEncoder, setAdvEncoder] = useState("");
  const [removeAudio, setRemoveAudio] = useState(false);
  const [outputDestination, setOutputDestination] = useState<OutputDestination>("downloads");
  const [customOutputDirectory, setCustomOutputDirectory] = useState("");
  const [completionAction, setCompletionAction] = useState<CompletionAction>("copy");

  useEffect(() => {
    (async () => {
      const s = await loadSettings().catch((): Settings => ({}));
      settingsRef.current = s;
      if (typeof s.quality_index === "number") setQualityIdx(s.quality_index);
      if (typeof s.gif_mode === "boolean") setGifMode(s.gif_mode);
      if (s.gif_quality_index === 0 || s.gif_quality_index === 1) {
        setGifQualityIdx(s.gif_quality_index);
      }
      if (s.gif_fps === 15 || s.gif_fps === 30 || s.gif_fps === 50) {
        setGifFps(s.gif_fps);
      }
      if (typeof s.advanced_mode === "boolean") setAdvancedMode(s.advanced_mode);
      if (typeof s.advanced_target_size === "string") setAdvSize(s.advanced_target_size);
      if (typeof s.advanced_resolution === "string") setAdvResolution(s.advanced_resolution);
      if (typeof s.fps_option === "string") setFpsOption(s.fps_option);
      if (typeof s.advanced_fps === "string") setAdvFps(s.advanced_fps);
      if (typeof s.advanced_encoder === "string") setAdvEncoder(s.advanced_encoder);
      if (typeof s.remove_audio === "boolean") setRemoveAudio(s.remove_audio);
      if (
        s.output_destination === "downloads" ||
        s.output_destination === "source" ||
        s.output_destination === "ask" ||
        s.output_destination === "custom"
      ) {
        setOutputDestination(s.output_destination);
      }
      if (typeof s.custom_output_directory === "string") {
        setCustomOutputDirectory(s.custom_output_directory);
      }
      if (s.completion_action === "reveal" || s.completion_action === "copy") {
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
    gifMode,
    setGifMode,
    gifQualityIdx,
    setGifQualityIdx,
    gifFps,
    setGifFps,
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
    outputDestination,
    setOutputDestination,
    customOutputDirectory,
    setCustomOutputDirectory,
    completionAction,
    setCompletionAction,
    saveSettings,
  };
}
