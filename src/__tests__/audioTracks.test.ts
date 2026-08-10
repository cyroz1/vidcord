import { describe, expect, it } from "vitest";
import {
  audioTrackSelectionScore,
  defaultAudioTrackIndices,
  formatAudioTrackSize,
  normalizeAudioTrackIndices,
  type AudioTrack,
} from "../audioTracks";

const tracks: AudioTrack[] = [
  {
    index: 0,
    name: "Mic",
    codec: "aac",
    bitrate_kbps: 128,
    duration: 60,
    size_bytes: 960_000,
    channels: 1,
  },
  {
    index: 1,
    name: "Desktop",
    codec: "aac",
    bitrate_kbps: 192,
    duration: 60,
    size_bytes: 1_440_000,
    channels: 2,
  },
];

describe("audio track selection", () => {
  it("uses the largest track when it is at least 20% larger", () => {
    expect(defaultAudioTrackIndices(tracks)).toEqual([1]);
  });

  it("keeps the first track when the largest track is less than 20% larger", () => {
    const nearTie = tracks.map((track, index) => ({
      ...track,
      bitrate_kbps: index === 0 ? 100 : 119,
    }));
    expect(defaultAudioTrackIndices(nearTie)).toEqual([0]);
  });

  it("switches at exactly a 20% data advantage", () => {
    const threshold = tracks.map((track, index) => ({
      ...track,
      bitrate_kbps: index === 0 ? 100 : 120,
    }));
    expect(defaultAudioTrackIndices(threshold)).toEqual([1]);
  });

  it("uses the first track when fallback scores tie", () => {
    const tied = tracks.map((track) => ({ ...track, bitrate_kbps: 0, channels: 1 }));
    expect(audioTrackSelectionScore(tied[0])).toBe(audioTrackSelectionScore(tied[1]));
    expect(defaultAudioTrackIndices(tied)).toEqual([0]);
  });

  it("normalizes the implicit default and explicit selections to source tracks", () => {
    expect(normalizeAudioTrackIndices(null, tracks)).toEqual([1]);
    expect(normalizeAudioTrackIndices([1, 99, 1], tracks)).toEqual([1]);
    expect(normalizeAudioTrackIndices([], tracks)).toEqual([]);
  });

  it("formats estimated sizes for the popup", () => {
    expect(formatAudioTrackSize(1.5 * 1024 * 1024)).toBe("1.50 MB");
    expect(formatAudioTrackSize(0)).toBe("Size unavailable");
  });
});
