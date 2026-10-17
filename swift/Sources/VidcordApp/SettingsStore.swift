import Foundation
import Observation
import VidcordCore

/// Settings and presets, persisted as one JSON file in Application
/// Support under the port's own folder (never the Tauri app's, so the
/// two never fight over a file). Writes follow the desktop app's
/// discipline: debounced 250 ms, flushed through a temporary file and
/// an atomic replace. Preset rules are the desktop app's too: at most
/// 20 presets, names capped at 40 characters, a same-name save
/// (case-insensitive) replaces, and presets capture the editing
/// settings only, never the destination or completion action.
@Observable
final class SettingsStore {
    var settings: AppSettings {
        didSet { scheduleSave() }
    }
    private(set) var presets: [SettingsPreset] = []

    /// The preset the current settings were last applied from or saved
    /// as; nil when the session started freehand.
    var selectedPresetID: String?

    private var saveTask: Task<Void, Never>?
    private let fileURL: URL

    private struct StoreFile: Codable {
        var settings: AppSettings
        var presets: [SettingsPreset]
    }

    init() {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = support.appendingPathComponent("vidcord-swift", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("settings.json")
        settings = AppSettings()
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(StoreFile.self, from: data) {
            settings = decoded.settings
            presets = decoded.presets
        }
    }

    /// "Autosave" state: the live settings differ from the selected
    /// preset's captured settings, exactly the desktop app's footer
    /// rule.
    var selectedPresetIsDirty: Bool {
        guard let id = selectedPresetID,
              let preset = presets.first(where: { $0.id == id }) else { return false }
        return SettingsPreset.captured(settings) != SettingsPreset.captured(preset.settings)
    }

    func applyPreset(_ preset: SettingsPreset) {
        var next = preset.settings
        // Machine-level fields stay with the machine, not the preset.
        next.outputDestination = settings.outputDestination
        next.customOutputDirectory = settings.customOutputDirectory
        next.completionAction = settings.completionAction
        next.closeAppAfterExport = settings.closeAppAfterExport
        settings = next
        selectedPresetID = preset.id
    }

    /// Save the current editing settings as a preset. Returns a problem
    /// string for the UI when the save is refused, nil on success.
    @discardableResult
    func savePreset(named rawName: String) -> String? {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return "A preset needs a name." }
        guard name.count <= 40 else { return "Preset names cap at 40 characters." }
        if let existing = presets.firstIndex(
            where: { $0.name.lowercased() == name.lowercased() }) {
            presets[existing].settings = settings
            selectedPresetID = presets[existing].id
            scheduleSave()
            return nil
        }
        guard presets.count < 20 else { return "Presets cap at 20." }
        let preset = SettingsPreset(
            id: UUID().uuidString, name: name, settings: settings)
        presets.append(preset)
        selectedPresetID = preset.id
        scheduleSave()
        return nil
    }

    func deletePreset(_ preset: SettingsPreset) {
        presets.removeAll { $0.id == preset.id }
        if selectedPresetID == preset.id { selectedPresetID = nil }
        scheduleSave()
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
            self?.writeNow()
        }
    }

    /// Flush immediately (the app calls this before a close-after
    /// export exit, like the desktop app flushes pending settings).
    func flush() {
        saveTask?.cancel()
        writeNow()
    }

    private func writeNow() {
        let payload = StoreFile(settings: settings, presets: presets)
        guard let data = try? JSONEncoder().encode(payload) else { return }
        let temp = fileURL.appendingPathExtension("tmp")
        do {
            try data.write(to: temp, options: .atomic)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: temp)
            } else {
                try FileManager.default.moveItem(at: temp, to: fileURL)
            }
        } catch {
            try? FileManager.default.removeItem(at: temp)
        }
    }
}
