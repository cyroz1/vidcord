import { useEffect, useMemo, useRef, useState, memo } from "react";
import {
  AUDIO_TRACK_BITRATE_KBPS,
  formatAudioTrackSize,
  normalizeAudioTrackIndices,
} from "../audioTracks";
import type { AudioTrack } from "../ipc";

type Props = {
  tracks: AudioTrack[];
  selection: number[] | null;
  removeAudio: boolean;
  audioNormalize: boolean;
  disabled?: boolean;
  onChange: (selection: number[]) => void;
  onRemoveAudioChange: (removeAudio: boolean) => void;
  onAudioNormalizeChange: (audioNormalize: boolean) => void;
};

const MIXER_ICON = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="4" y1="5" x2="4" y2="19" />
    <line x1="12" y1="3" x2="12" y2="21" />
    <line x1="20" y1="7" x2="20" y2="17" />
    <line x1="2" y1="9" x2="6" y2="9" />
    <line x1="10" y1="15" x2="14" y2="15" />
    <line x1="18" y1="11" x2="22" y2="11" />
  </svg>
);

export default memo(function AudioTrackPicker({
  tracks,
  selection,
  removeAudio,
  audioNormalize,
  disabled = false,
  onChange,
  onRemoveAudioChange,
  onAudioNormalizeChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectedIndices = useMemo(
    () => normalizeAudioTrackIndices(selection, tracks),
    [selection, tracks]
  );
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);
  const allSelected = tracks.length > 0 && selectedIndices.length === tracks.length;
  const partiallySelected = selectedIndices.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selectionLabel =
    tracks.length === 0 ? "No audio tracks" : `${selectedIndices.length} selected`;
  const buttonLabel = removeAudio ? "Audio muted" : selectionLabel;

  return (
    <div className="audio-track-control" ref={rootRef}>
      <button
        type="button"
        className={`audio-settings-btn${
          removeAudio || audioNormalize || selection !== null ? " active" : ""
        }`}
        title={`${buttonLabel}; open audio settings`}
        aria-label={`${buttonLabel}; open audio settings`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {MIXER_ICON}
      </button>
      {open && (
        <div className="audio-track-popup" role="dialog" aria-label="Audio settings">
          <div className="audio-track-popup-heading">
            <div>
              <strong>Audio settings</strong>
              <span>{AUDIO_TRACK_BITRATE_KBPS} kbps AAC per track</span>
            </div>
            <button
              type="button"
              className="audio-track-close"
              aria-label="Close audio settings"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="audio-settings-toggles">
            <label className="audio-settings-toggle">
              <input
                type="checkbox"
                checked={removeAudio}
                onChange={(event) => onRemoveAudioChange(event.target.checked)}
              />
              <span>Mute audio</span>
            </label>
            <label className="audio-settings-toggle">
              <input
                type="checkbox"
                checked={audioNormalize && !removeAudio}
                disabled={removeAudio}
                onChange={(event) => onAudioNormalizeChange(event.target.checked)}
              />
              <span>Peak normalize to 0 dB</span>
            </label>
          </div>
          <div className="audio-track-popup-mode">
            Track selection ·
            {selection === null
              ? " Default: first track unless another is 20% larger"
              : " Custom selection"}
          </div>
          <label className="audio-track-select-all">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              disabled={tracks.length === 0}
              onChange={() => onChange(allSelected ? [] : tracks.map((track) => track.index))}
            />
            <span>{allSelected ? "Deselect all tracks" : "Select all tracks"}</span>
          </label>
          <div className="audio-track-list" role="group" aria-label="Available audio tracks">
            {tracks.length === 0 ? (
              <p className="audio-track-empty">This video has no audio tracks.</p>
            ) : (
              tracks.map((track) => (
                <label className="audio-track-option" key={track.index}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(track.index)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selectedIndices, track.index]
                        : selectedIndices.filter((index) => index !== track.index);
                      onChange(normalizeAudioTrackIndices(next, tracks));
                    }}
                  />
                  <span className="audio-track-copy">
                    <span className="audio-track-name" title={track.name}>
                      {track.name}
                    </span>
                    <span className="audio-track-meta">
                      {formatAudioTrackSize(track.size_bytes)}
                      {track.codec ? ` · ${track.codec}` : ""}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="audio-track-popup-footer">
            {removeAudio
              ? "Audio muted · video bitrate reserves 0 kbps"
              : `${selectionLabel} · video bitrate reserves ${AUDIO_TRACK_BITRATE_KBPS * selectedIndices.length} kbps`}
          </div>
        </div>
      )}
    </div>
  );
});
