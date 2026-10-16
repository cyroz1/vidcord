import { startTransition, useEffect, useRef, useState, useCallback } from "react";
import { loadSettings, saveSettings as persistSettings, type Settings } from "../ipc";
import {
  gifPresetIndexForTarget,
  migrateLegacyGifQualityIndex,
  normalizeGifTarget,
  GIF_PRESETS,
} from "../gifPresets";
import { normalizeGifOutputFormat, type GifOutputFormat } from "../gifOutputFormat";

import {
  createSettingsPresetId,
  MAX_SETTINGS_PRESETS,
  normalizePresetName,
  normalizePresetSettings,
  parseSettingsPresets,
  type PresetSettings,
  type SettingsPreset,
  type CompletionAction,
  type OutputDestination,
} from "../settingsPresets";

export type { CompletionAction, OutputDestination } from "../settingsPresets";

export function useSettings() {
  const settingsRef = useRef<Settings>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presetsRef = useRef<SettingsPreset[]>([]);
  // Patches saved while the initial load is still in flight are recorded so
  // the load can re-apply them on top of the loaded settings instead of
  // silently overwriting a change the user made in the load window.
  const patchesDuringLoadRef = useRef<Settings>({});
  const loadCompletedRef = useRef(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [presets, setPresets] = useState<SettingsPreset[]>([]);
  // Encoder identity persisted in settings, exposed as state so consumers
  // (useEncoders) react to it directly instead of reading settingsRef
  // during render.
  const [savedEncoderLabel, setSavedEncoderLabel] = useState<string | undefined>(undefined);
  const [savedEncoderIndex, setSavedEncoderIndex] = useState(0);
  const [cachedEncoders, setCachedEncoders] = useState<unknown>(undefined);

  // Persisted settings values
  const [qualityIdx, setQualityIdx] = useState(0);
  const [gifMode, setGifMode] = useState(false);
  const [gifOutputFormat, setGifOutputFormat] = useState<GifOutputFormat>("gif");
  const [gifQualityIdx, setGifQualityIdx] = useState(0);
  const [gifFps, setGifFps] = useState(15);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [losslessMode, setLosslessMode] = useState(false);
  const [advSize, setAdvSize] = useState("");
  const [advResolution, setAdvResolution] = useState("Native");
  const [fpsOption, setFpsOption] = useState("off");
  const [advFps, setAdvFps] = useState("");
  const [advEncoder, setAdvEncoder] = useState("");
  const [removeAudio, setRemoveAudio] = useState(false);
  const [audioNormalize, setAudioNormalize] = useState(false);
  const [cropAspectRatio, setCropAspectRatio] = useState("off");
  const [batchTrimStartSeconds, setBatchTrimStartSeconds] = useState(0);
  const [batchTrimEndSeconds, setBatchTrimEndSeconds] = useState(0);
  const [outputDestination, setOutputDestination] = useState<OutputDestination>("downloads");
  const [customOutputDirectory, setCustomOutputDirectory] = useState("");
  const [completionAction, setCompletionAction] = useState<CompletionAction>("copy");
  const [closeAppAfterExport, setCloseAppAfterExport] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await loadSettings().catch((): Settings => ({}));
      if (cancelled) return;
      // Re-apply any patches saved during the load window: they win over
      // the loaded values for both the persisted object and React state.
      const s: Settings = { ...loaded, ...patchesDuringLoadRef.current };
      const gifTargetMb = normalizeGifTarget(
        s.gif_target_mb,
        migrateLegacyGifQualityIndex(s.gif_quality_index) ?? 5
      );
      const legacyCloseAction = s.completion_action === "close";
      const hasCloseAppPreference = typeof s.close_app_after_export === "boolean";
      const migratedSettings = {
        ...s,
        gif_target_mb: gifTargetMb,
        ...(legacyCloseAction ? { completion_action: "none" } : {}),
        ...(legacyCloseAction && !hasCloseAppPreference ? { close_app_after_export: true } : {}),
        // The 7.4 schema is semantic. JSON serialization omits this undefined
        // legacy field while the typed Rust loader still accepts old files.
        gif_quality_index: undefined,
      };
      const savedLosslessMode =
        typeof s.lossless_mode === "boolean" ? s.lossless_mode : s.quality_index === 5;
      const migratedLosslessPreset = typeof s.lossless_mode !== "boolean" && s.quality_index === 5;
      // Apply the lossless migration BEFORE the persist check below.
      // Previously settingsRef was persisted first and only then rewritten
      // with quality_index: 0 / lossless_mode: true, so the migrated values
      // diverged from disk until some unrelated save happened to flush them.
      settingsRef.current = migratedLosslessPreset
        ? {
            // Migrate the short-lived Lossless Trim quality preset to its
            // dedicated mode toggle.
            ...migratedSettings,
            quality_index: 0,
            lossless_mode: true,
            advanced_mode: false,
          }
        : migratedSettings;
      loadCompletedRef.current = true;
      if (
        s.gif_target_mb !== gifTargetMb ||
        s.gif_quality_index !== undefined ||
        legacyCloseAction ||
        migratedLosslessPreset ||
        Object.keys(patchesDuringLoadRef.current).length > 0
      ) {
        void persistSettings(settingsRef.current).catch(() => {});
      }
      const loadedPresets = parseSettingsPresets(s.presets);
      presetsRef.current = loadedPresets;
      startTransition(() => {
        if (cancelled) return;
        setPresets(loadedPresets);
        setSavedEncoderLabel(typeof s.encoder_label === "string" ? s.encoder_label : undefined);
        setSavedEncoderIndex(
          typeof s.encoder_index === "number" && Number.isFinite(s.encoder_index)
            ? s.encoder_index
            : 0
        );
        setCachedEncoders(s.encoder_capabilities);
        if (
          !migratedLosslessPreset &&
          typeof s.quality_index === "number" &&
          s.quality_index >= 0 &&
          s.quality_index <= 5
        ) {
          setQualityIdx(s.quality_index);
        }
        if (typeof s.gif_mode === "boolean") setGifMode(s.gif_mode);
        setGifOutputFormat(normalizeGifOutputFormat(s.gif_output_format));
        setGifQualityIdx(gifPresetIndexForTarget(gifTargetMb));
        if (s.gif_fps === 15 || s.gif_fps === 30 || s.gif_fps === 50) {
          setGifFps(s.gif_fps);
        }
        setLosslessMode(savedLosslessMode);
        if (typeof s.advanced_mode === "boolean") {
          setAdvancedMode(savedLosslessMode ? false : s.advanced_mode);
        }
        if (typeof s.advanced_target_size === "string") setAdvSize(s.advanced_target_size);
        if (typeof s.advanced_resolution === "string") setAdvResolution(s.advanced_resolution);
        if (typeof s.fps_option === "string") setFpsOption(s.fps_option);
        if (typeof s.advanced_fps === "string") setAdvFps(s.advanced_fps);
        if (typeof s.advanced_encoder === "string") setAdvEncoder(s.advanced_encoder);
        if (typeof s.remove_audio === "boolean") setRemoveAudio(s.remove_audio);
        if (typeof s.audio_normalize === "boolean") setAudioNormalize(s.audio_normalize);
        if (typeof s.crop_aspect_ratio === "string") setCropAspectRatio(s.crop_aspect_ratio);
        if (
          typeof s.batch_trim_start_seconds === "number" &&
          Number.isFinite(s.batch_trim_start_seconds)
        ) {
          setBatchTrimStartSeconds(Math.max(0, s.batch_trim_start_seconds));
        }
        if (
          typeof s.batch_trim_end_seconds === "number" &&
          Number.isFinite(s.batch_trim_end_seconds)
        ) {
          setBatchTrimEndSeconds(Math.max(0, s.batch_trim_end_seconds));
        }
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
        if (
          s.completion_action === "reveal" ||
          s.completion_action === "copy" ||
          s.completion_action === "none"
        ) {
          setCompletionAction(s.completion_action);
        } else if (legacyCloseAction) {
          setCompletionAction("none");
        }
        if (typeof s.close_app_after_export === "boolean") {
          setCloseAppAfterExport(s.close_app_after_export);
        } else if (legacyCloseAction) {
          setCloseAppAfterExport(true);
        }
        setSettingsLoaded(true);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSettings = useCallback((patch: Settings) => {
    settingsRef.current = { ...settingsRef.current, ...patch };
    if (!loadCompletedRef.current) {
      patchesDuringLoadRef.current = { ...patchesDuringLoadRef.current, ...patch };
    }
    if ("encoder_label" in patch) {
      setSavedEncoderLabel(
        typeof patch.encoder_label === "string" ? patch.encoder_label : undefined
      );
    }
    if ("encoder_index" in patch) {
      setSavedEncoderIndex(
        typeof patch.encoder_index === "number" && Number.isFinite(patch.encoder_index)
          ? patch.encoder_index
          : 0
      );
    }
    if ("encoder_capabilities" in patch) {
      setCachedEncoders(patch.encoder_capabilities);
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      persistSettings(settingsRef.current).catch(() => {});
    }, 250);
  }, []);

  const flushSettings = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    await persistSettings(settingsRef.current);
  }, []);

  const getSettingsSnapshot = useCallback(
    (encoderIndex = 0, encoderLabel = ""): PresetSettings => ({
      quality_index: qualityIdx,
      gif_mode: gifMode,
      gif_output_format: gifOutputFormat,
      gif_target_mb: GIF_PRESETS[gifQualityIdx]?.sizeMb ?? GIF_PRESETS[0].sizeMb,
      gif_fps: gifFps,
      advanced_mode: advancedMode,
      lossless_mode: losslessMode,
      advanced_target_size: advSize,
      advanced_resolution: advResolution,
      fps_option: fpsOption,
      advanced_fps: advFps,
      advanced_encoder: advEncoder,
      remove_audio: removeAudio,
      audio_normalize: audioNormalize,
      crop_aspect_ratio: cropAspectRatio,
      batch_trim_start_seconds: batchTrimStartSeconds,
      batch_trim_end_seconds: batchTrimEndSeconds,
      encoder_index: encoderIndex,
      encoder_label: encoderLabel,
    }),
    [
      advEncoder,
      advFps,
      advResolution,
      advSize,
      advancedMode,
      audioNormalize,
      batchTrimEndSeconds,
      batchTrimStartSeconds,
      cropAspectRatio,
      fpsOption,
      gifFps,
      gifMode,
      gifOutputFormat,
      gifQualityIdx,
      losslessMode,
      qualityIdx,
      removeAudio,
    ]
  );

  const restoreSettings = useCallback((value: unknown): PresetSettings => {
    const restored = normalizePresetSettings(value);
    setQualityIdx(restored.quality_index);
    setGifMode(restored.gif_mode);
    setGifOutputFormat(restored.gif_output_format);
    setGifQualityIdx(gifPresetIndexForTarget(restored.gif_target_mb));
    setGifFps(restored.gif_fps);
    setAdvancedMode(restored.advanced_mode);
    setLosslessMode(restored.lossless_mode);
    setAdvSize(restored.advanced_target_size);
    setAdvResolution(restored.advanced_resolution);
    setFpsOption(restored.fps_option);
    setAdvFps(restored.advanced_fps);
    setAdvEncoder(restored.advanced_encoder);
    setRemoveAudio(restored.remove_audio);
    setAudioNormalize(restored.audio_normalize);
    setCropAspectRatio(restored.crop_aspect_ratio);
    setBatchTrimStartSeconds(restored.batch_trim_start_seconds);
    setBatchTrimEndSeconds(restored.batch_trim_end_seconds);
    return restored;
  }, []);

  const savePreset = useCallback(
    (name: string, settings: PresetSettings): SettingsPreset | null => {
      const normalizedName = normalizePresetName(name);
      if (!normalizedName) return null;

      const current = presetsRef.current;
      const existing = current.find(
        (preset) => preset.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
      );
      if (!existing && current.length >= MAX_SETTINGS_PRESETS) return null;

      const nextPreset: SettingsPreset = {
        id: existing?.id ?? createSettingsPresetId(),
        name: normalizedName,
        settings: normalizePresetSettings(settings),
      };
      const next = existing
        ? current.map((preset) => (preset.id === existing.id ? nextPreset : preset))
        : [...current, nextPreset];
      presetsRef.current = next;
      setPresets(next);
      saveSettings({ presets: next });
      return nextPreset;
    },
    [saveSettings]
  );

  const deletePreset = useCallback(
    (id: string): SettingsPreset | null => {
      const current = presetsRef.current;
      const deleted = current.find((preset) => preset.id === id);
      if (!deleted) return null;

      const next = current.filter((preset) => preset.id !== id);
      presetsRef.current = next;
      setPresets(next);
      saveSettings({ presets: next });
      return deleted;
    },
    [saveSettings]
  );

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
    savedEncoderLabel,
    savedEncoderIndex,
    cachedEncoders,
    qualityIdx,
    setQualityIdx,
    gifMode,
    setGifMode,
    gifOutputFormat,
    setGifOutputFormat,
    gifQualityIdx,
    setGifQualityIdx,
    gifFps,
    setGifFps,
    advancedMode,
    setAdvancedMode,
    losslessMode,
    setLosslessMode,
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
    audioNormalize,
    setAudioNormalize,
    cropAspectRatio,
    setCropAspectRatio,
    batchTrimStartSeconds,
    setBatchTrimStartSeconds,
    batchTrimEndSeconds,
    setBatchTrimEndSeconds,
    outputDestination,
    setOutputDestination,
    customOutputDirectory,
    setCustomOutputDirectory,
    completionAction,
    setCompletionAction,
    closeAppAfterExport,
    setCloseAppAfterExport,
    presets,
    flushSettings,
    getSettingsSnapshot,
    restoreSettings,
    savePreset,
    deletePreset,
    saveSettings,
  };
}
