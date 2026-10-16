import type { AudioTrack } from "./ipc";

export type { AudioTrack } from "./ipc";

export const AUDIO_TRACK_BITRATE_KBPS = 128;
const AUTOMATIC_TRACK_SWITCH_RATIO = 1.2;

export function audioTrackSelectionScore(track: AudioTrack): number {
  if (track.bitrate_kbps > 0 && track.duration > 0) {
    return track.bitrate_kbps * track.duration;
  }
  return track.channels * 1000;
}

export function defaultAudioTrackIndices(tracks: AudioTrack[]): number[] {
  if (tracks.length === 0) return [];

  const firstTrack = tracks[0];
  const firstScore = audioTrackSelectionScore(firstTrack);
  let largestTrack = firstTrack;
  let largestScore = firstScore;
  for (let index = 1; index < tracks.length; index += 1) {
    const track = tracks[index];
    const score = audioTrackSelectionScore(track);
    if (score > largestScore) {
      largestTrack = track;
      largestScore = score;
    }
  }

  const largestIsSignificantlyLarger =
    largestTrack.index !== firstTrack.index &&
    largestScore >= firstScore * AUTOMATIC_TRACK_SWITCH_RATIO;
  return [largestIsSignificantlyLarger ? largestTrack.index : firstTrack.index];
}

export function normalizeAudioTrackIndices(
  selection: number[] | null,
  tracks: AudioTrack[]
): number[] {
  const source = selection ?? defaultAudioTrackIndices(tracks);
  const sourceSet = new Set(source);
  return tracks.map((track) => track.index).filter((index) => sourceSet.has(index));
}

export function audioTrackOrdinals(indices: readonly number[], tracks: AudioTrack[]): number[] {
  return normalizeAudioTrackIndices([...indices], tracks)
    .map((index) => tracks.findIndex((track) => track.index === index))
    .filter((ordinal) => ordinal >= 0);
}

export function applyPreviewAudioTrackSelection(
  media: HTMLMediaElement | null,
  selectedOrdinals: readonly number[]
): void {
  if (!media) return;
  const trackList = (
    media as unknown as {
      audioTracks?: { length: number; [index: number]: { enabled: boolean } };
    }
  ).audioTracks;
  if (!trackList || !Number.isInteger(trackList.length) || trackList.length < 0) return;

  const firstSelected = selectedOrdinals.find(
    (ordinal) => Number.isInteger(ordinal) && ordinal >= 0 && ordinal < trackList.length
  );
  const selectedOrdinal = firstSelected ?? -1;
  for (let index = 0; index < trackList.length; index += 1) {
    const track = trackList[index];
    if (track) track.enabled = index === selectedOrdinal;
  }
}

export function formatAudioTrackSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${mb.toFixed(0)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}
