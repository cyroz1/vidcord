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
  for (const track of tracks.slice(1)) {
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
  const validIndices = new Set(tracks.map((track) => track.index));
  const source = selection ?? defaultAudioTrackIndices(tracks);
  return tracks
    .map((track) => track.index)
    .filter((index) => validIndices.has(index) && source.includes(index));
}

export function formatAudioTrackSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${mb.toFixed(0)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}
