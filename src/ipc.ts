import { invoke } from "@tauri-apps/api/core";
import type { LosslessTrimInfo, LosslessVideoExtension } from "./losslessTrim";

export type Settings = Record<string, unknown>;

export type OutputExtension = LosslessVideoExtension | "gif" | "png";

export type ProbeData = {
  duration: number;
  width: number;
  height: number;
  display_width?: number;
  display_height?: number;
  frame_rate?: number;
  bitrate: number;
  codec: string;
  audio_tracks: AudioTrack[];
};

export type AudioTrack = {
  index: number;
  name: string;
  codec: string;
  bitrate_kbps: number;
  duration: number;
  size_bytes: number;
  channels: number;
};

export type Encoder = {
  name: string;
  label: string;
  auto_selectable?: boolean;
  ffmpeg_missing?: boolean;
};

export type FfmpegInstallResult = {
  status:
    | "installed"
    | "already_available"
    | "failed"
    | "unsupported"
    | "requires_privileged"
    | "needs_manual_download";
  message: string;
  hint_command?: string | null;
  guide_url?: string | null;
};

export type CompressOptions = {
  input_path: string;
  output_path: string;
  encoder: string;
  video_bitrate_k: number;
  target_size_mb: number | null;
  start_time: number;
  end_time: number;
  remove_audio: boolean;
  audio_track_indices?: number[] | null;
  audio_normalize?: boolean;
  crop_aspect_ratio?: string;
  output_fps: number | null;
  scale_filter: string | null;
  source_width?: number | null;
  source_height?: number | null;
  vaapi_device: string | null;
  gif_mode: boolean;
  lossless_trim: boolean;
  fallback_output_path?: string | null;
  fallback_target_size_mb?: number | null;
};

export type BatchCompressOptions = CompressOptions;

export type BatchCompressItem = {
  id: number;
  opts: BatchCompressOptions;
};

export type BatchProgressPayload = {
  item_id: number;
  item_percent: number;
  percent: number;
  eta: string;
  status: string;
  phase: "encoding" | "completed" | "failed" | "cancelled";
  active_count: number;
  completed_count: number;
  total_count: number;
  attempt?: number;
  attempt_total?: number;
  encoder?: string;
  video_bitrate_k?: number;
};

export type BatchItemResult = {
  id: number;
  input_path: string;
  success: boolean;
  cancelled?: boolean;
  message: string;
  output_path?: string | null;
  input_size_bytes?: number | null;
  output_size_bytes?: number | null;
};

export type BatchDonePayload = {
  success: boolean;
  cancelled: boolean;
  message: string;
  results: BatchItemResult[];
};

export type BatchPublicationPayload = {
  published_paths: string[];
  error?: string | null;
};

export type UpdateCheckResult = {
  update_available: boolean;
  latest_version?: string;
  release_url?: string;
  installer_available?: boolean;
  installer_name?: string;
};

export type UpdateInstallResult = {
  path: string;
  installer_name: string;
};

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export function frontendReady(): Promise<void> {
  return invoke("frontend_ready");
}

export function syncNativeWindowTheme(dark: boolean): Promise<void> {
  return invoke("sync_native_window_theme", { dark });
}

export function probe(path: string): Promise<ProbeData> {
  return invoke<ProbeData>("probe", { path });
}

export function getLosslessTrimInfo(path: string, requestId?: number): Promise<LosslessTrimInfo> {
  return invoke<LosslessTrimInfo>("get_lossless_trim_info", { path, requestId });
}

export function cancelLosslessTrimProbe(requestId: number): Promise<void> {
  return invoke("cancel_lossless_trim_probe", { requestId });
}

export function getPreviewFrame(
  path: string,
  timeSec: number,
  previewWidth?: number,
  previewHeight?: number
): Promise<Uint8Array> {
  return invoke<Uint8Array>("get_preview_frame", {
    path,
    timeSec,
    previewWidth,
    previewHeight,
  });
}

export function getPreviewClip(
  path: string,
  startTimeSec: number,
  endTimeSec: number,
  previewWidth?: number,
  previewHeight?: number
): Promise<Uint8Array> {
  return invoke<Uint8Array>("get_preview_clip", {
    path,
    startTimeSec,
    endTimeSec,
    previewWidth,
    previewHeight,
  });
}

export function getFilmstrip(
  path: string,
  durationSec: number,
  maxFrames?: number,
  previewWidth?: number,
  previewHeight?: number
): Promise<Uint8Array> {
  return invoke<Uint8Array>("get_filmstrip", {
    path,
    durationSec,
    maxFrames,
    previewWidth,
    previewHeight,
  });
}

export function cancelPreviewGeneration(): Promise<void> {
  return invoke("cancel_preview_generation");
}

export function cancelPreviewFrameGeneration(): Promise<void> {
  return invoke("cancel_preview_frame_generation");
}

export function detectEncoders(): Promise<Encoder[]> {
  return invoke<Encoder[]>("detect_encoders");
}

export function checkFfmpegAvailable(): Promise<boolean> {
  return invoke<boolean>("check_ffmpeg_available");
}

export function installFfmpegDependency(allowPrivileged: boolean): Promise<FfmpegInstallResult> {
  return invoke<FfmpegInstallResult>("install_ffmpeg_dependency", {
    opts: { allow_privileged: allowPrivileged },
  });
}

export function listFfmpegVideoEncoders(): Promise<string> {
  return invoke<string>("list_ffmpeg_video_encoders");
}

export function compressVideo(opts: CompressOptions): Promise<string> {
  return invoke<string>("compress_video", { opts });
}

export function compressBatch(items: BatchCompressItem[]): Promise<BatchDonePayload> {
  return invoke<BatchDonePayload>("compress_batch", { items });
}

export function cancelCompression(): Promise<boolean> {
  return invoke<boolean>("cancel_compression");
}

export function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates", { currentVersion });
}

export function downloadAndOpenUpdateInstaller(): Promise<UpdateInstallResult> {
  return invoke<UpdateInstallResult>("download_and_open_update_installer");
}

export function showInFileExplorer(path: string): Promise<void> {
  return invoke("show_in_file_explorer", { path });
}

export function copyFileToClipboard(path: string): Promise<void> {
  return invoke("copy_file_to_clipboard", { path });
}

export function copyFilesToClipboard(paths: string[]): Promise<void> {
  return invoke("copy_files_to_clipboard", { paths });
}

export function publishStagedOutput(stagedPath: string, destinationPath: string): Promise<string> {
  return invoke<string>("publish_staged_output", { stagedPath, destinationPath });
}

export function publishBatchStagedOutputs(
  stagedPaths: string[],
  destinationPaths: string[]
): Promise<BatchPublicationPayload> {
  return invoke<BatchPublicationPayload>("publish_batch_staged_outputs", {
    stagedPaths,
    destinationPaths,
  });
}

export function discardStagedOutput(stagedPath: string): Promise<void> {
  return invoke("discard_staged_output", { stagedPath });
}

export function getVaapiDevice(): Promise<string | null> {
  return invoke<string | null>("get_vaapi_device");
}

export function resolveOutputPath(
  inputPath: string,
  outputDirectory?: string,
  useInputDirectory = false,
  outputExtension: OutputExtension = "mp4"
): Promise<string> {
  return invoke<string>("resolve_output_path", {
    inputPath,
    outputDirectory,
    useInputDirectory,
    outputExtension,
  });
}

export function resolveStagingOutputPath(
  inputPath: string,
  outputExtension: OutputExtension = "mp4"
): Promise<string> {
  return invoke<string>("resolve_staging_output_path", { inputPath, outputExtension });
}

export function resolveBatchOutputPaths(
  inputPaths: string[],
  outputDirectory: string | undefined,
  useInputDirectory: boolean,
  staging: boolean
): Promise<string[]> {
  return invoke<string[]>("resolve_batch_output_paths", {
    inputPaths,
    outputDirectory,
    useInputDirectory,
    staging,
    outputExtension: "mp4",
  });
}

export function getOs(): Promise<string> {
  return invoke<string>("get_os");
}

export function sendSystemNotification(title: string, body: string): Promise<boolean> {
  return invoke<boolean>("send_system_notification", { title, body });
}

export function captureSnapshot(
  inputPath: string,
  time: number,
  outputPath: string
): Promise<string> {
  return invoke<string>("capture_snapshot", { inputPath, time, outputPath });
}
