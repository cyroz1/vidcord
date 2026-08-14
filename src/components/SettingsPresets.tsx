import { memo, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  arePresetSettingsEqual,
  type PresetSettings,
  type SettingsPreset,
} from "../settingsPresets";

type Props = {
  currentSettings: PresetSettings;
  presets: SettingsPreset[];
  onRestore: (preset: SettingsPreset) => void;
  onSave: (name: string) => SettingsPreset | null;
  onDelete: (preset: SettingsPreset) => void;
};

export default memo(function SettingsPresets({
  currentSettings,
  presets,
  onRestore,
  onSave,
  onDelete,
}: Props) {
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("autosave");
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId);

  useEffect(() => {
    if (selectedPreset && !arePresetSettingsEqual(currentSettings, selectedPreset.settings)) {
      setSelectedPresetId("autosave");
    }
  }, [currentSettings, selectedPreset]);

  const submitSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const savedPreset = onSave(name);
    if (savedPreset) {
      setName("");
      setSaveFormOpen(false);
      setSelectedPresetId(savedPreset.id);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    if (value === "save") {
      setSaveFormOpen(true);
      return;
    }
    if (value === "autosave") {
      setSelectedPresetId("autosave");
      return;
    }

    const preset = presets.find((item) => item.id === value);
    if (preset) {
      setSelectedPresetId(preset.id);
      onRestore(preset);
    }
  };

  const handleDelete = () => {
    if (!selectedPreset) return;
    setSelectedPresetId("autosave");
    onDelete(selectedPreset);
  };

  return (
    <div className="settings-presets">
      <span className="preset-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
          <path
            d="M1.5 4h5.25M9.25 4h5.25M1.5 8h1.25M5.25 8h9.25M1.5 12h5.25M9.25 12h5.25"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
          <circle cx="8" cy="4" r="1.5" fill="currentColor" />
          <circle cx="4" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="12" r="1.5" fill="currentColor" />
        </svg>
      </span>
      <select
        className="preset-select"
        aria-label="Settings preset"
        value={selectedPreset?.id ?? "autosave"}
        onChange={handleChange}
      >
        <option value="autosave">Autosave</option>
        {presets.length > 0 && (
          <optgroup label="Saved presets">
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value="save">Save current settings…</option>
      </select>
      {selectedPreset && !saveFormOpen && (
        <button
          type="button"
          className="preset-delete-button"
          aria-label={`Delete preset ${selectedPreset.name}`}
          onClick={handleDelete}
        >
          Delete
        </button>
      )}
      {saveFormOpen && (
        <form className="preset-save-form" onSubmit={submitSave}>
          <input
            className="preset-name-input"
            aria-label="Preset name"
            autoFocus
            maxLength={40}
            placeholder="Preset name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="preset-save-button">
            Save
          </button>
          <button
            type="button"
            className="preset-cancel-button"
            aria-label="Cancel preset save"
            onClick={() => {
              setName("");
              setSaveFormOpen(false);
            }}
          >
            ×
          </button>
        </form>
      )}
    </div>
  );
});
