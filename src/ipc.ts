import { invoke } from "@tauri-apps/api/core";

export type Settings = Record<string, unknown>;

export type ProbeData = {
  duration: number;
  width: number;
  height: number;
  display_width?: number;
  display_height?: number;
  bitrate: number;
};

export type Encoder = { name: string; label: string; ffmpeg_missing?: boolean };

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
  target_size_mb: number;
  start_time: number;
  end_time: number;
  remove_audio: boolean;
  scale_filter: string | null;
  vaapi_device: string | null;
};

export type UpdateCheckResult = {
  update_available: boolean;
  latest_version?: string;
  release_url?: string;
};

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export function probe(path: string): Promise<ProbeData> {
  return invoke<ProbeData>("probe", { path });
}

export function getPreviewFrame(path: string, timeSec: number): Promise<Uint8Array> {
  return invoke<Uint8Array>("get_preview_frame", { path, timeSec });
}

export function getPreviewClip(
  path: string,
  startTimeSec: number,
  endTimeSec: number
): Promise<Uint8Array> {
  return invoke<Uint8Array>("get_preview_clip", { path, startTimeSec, endTimeSec });
}

export function getFilmstrip(
  path: string,
  durationSec: number,
  maxFrames?: number
): Promise<Uint8Array> {
  return invoke<Uint8Array>("get_filmstrip", { path, durationSec, maxFrames });
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

export function cancelCompression(): Promise<void> {
  return invoke("cancel_compression");
}

export function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates", { currentVersion });
}

export function showInFileExplorer(path: string): Promise<void> {
  return invoke("show_in_file_explorer", { path });
}

export function getVaapiDevice(): Promise<string | null> {
  return invoke<string | null>("get_vaapi_device");
}

export function resolveOutputPath(inputPath: string): Promise<string> {
  return invoke<string>("resolve_output_path", { inputPath });
}

export function getOs(): Promise<string> {
  return invoke<string>("get_os");
}
