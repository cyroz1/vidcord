import Foundation

/// The app's editing mode, mirroring the desktop app's three modes.
public enum EditMode: String, CaseIterable, Sendable, Codable {
    case compress
    case losslessTrim
    case gif

    public var displayName: String {
        switch self {
        case .compress: return "Compress"
        case .losslessTrim: return "Lossless Trim"
        case .gif: return "GIF / WebP"
        }
    }
}

/// Where a finished file goes, mirroring `output_destination`.
public enum OutputDestination: String, CaseIterable, Sendable, Codable {
    case downloads
    case source
    case ask
    case custom

    public var displayName: String {
        switch self {
        case .downloads: return "Downloads"
        case .source: return "Next to source"
        case .ask: return "Ask when done"
        case .custom: return "Custom folder"
        }
    }
}

/// What happens after a successful export, mirroring `completion_action`.
public enum CompletionAction: String, CaseIterable, Sendable, Codable {
    case copy
    case reveal
    case none

    public var displayName: String {
        switch self {
        case .copy: return "Copy file"
        case .reveal: return "Reveal in Finder"
        case .none: return "Nothing"
        }
    }
}

/// The persisted settings, stored as JSON under Application Support
/// with the same atomic replace discipline as the desktop app's
/// settings.rs. Every field has a default so older files keep loading.
public struct AppSettings: Codable, Sendable, Equatable {
    public var mode: EditMode = .compress
    public var useTarget: Bool = true
    public var targetMB: Double = 25
    public var codec: CodecChoice = .hevc
    public var maxHeight: Int = 0
    /// 0 means the source frame rate.
    public var fpsCap: Double = 0
    public var cropAspect: CropAspect = .original
    public var removeAudio: Bool = false
    public var normalizeAudio: Bool = false
    public var gifFormat: GifFormat = .gif
    public var gifFPS: Double = 15
    public var gifTargetMB: Double = 10
    public var gifUseTarget: Bool = true
    public var outputDestination: OutputDestination = .downloads
    public var customOutputDirectory: String = ""
    public var completionAction: CompletionAction = .copy
    public var closeAppAfterExport: Bool = false

    public init() {}

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decodeIfPresent(EditMode.self, forKey: .mode) ?? .compress
        useTarget = try container.decodeIfPresent(Bool.self, forKey: .useTarget) ?? true
        targetMB = try container.decodeIfPresent(Double.self, forKey: .targetMB) ?? 25
        codec = try container.decodeIfPresent(CodecChoice.self, forKey: .codec) ?? .hevc
        maxHeight = try container.decodeIfPresent(Int.self, forKey: .maxHeight) ?? 0
        fpsCap = try container.decodeIfPresent(Double.self, forKey: .fpsCap) ?? 0
        cropAspect =
            try container.decodeIfPresent(CropAspect.self, forKey: .cropAspect) ?? .original
        removeAudio = try container.decodeIfPresent(Bool.self, forKey: .removeAudio) ?? false
        normalizeAudio =
            try container.decodeIfPresent(Bool.self, forKey: .normalizeAudio) ?? false
        gifFormat = try container.decodeIfPresent(GifFormat.self, forKey: .gifFormat) ?? .gif
        gifFPS = try container.decodeIfPresent(Double.self, forKey: .gifFPS) ?? 15
        gifTargetMB = try container.decodeIfPresent(Double.self, forKey: .gifTargetMB) ?? 10
        gifUseTarget = try container.decodeIfPresent(Bool.self, forKey: .gifUseTarget) ?? true
        outputDestination =
            try container.decodeIfPresent(OutputDestination.self, forKey: .outputDestination)
            ?? .downloads
        customOutputDirectory =
            try container.decodeIfPresent(String.self, forKey: .customOutputDirectory) ?? ""
        completionAction =
            try container.decodeIfPresent(CompletionAction.self, forKey: .completionAction)
            ?? .copy
        closeAppAfterExport =
            try container.decodeIfPresent(Bool.self, forKey: .closeAppAfterExport) ?? false
    }
}

/// A named preset: the editing settings only. Like the desktop app,
/// presets deliberately do not capture the output destination, custom
/// folder, or completion action.
public struct SettingsPreset: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var settings: AppSettings

    public init(id: String, name: String, settings: AppSettings) {
        self.id = id
        self.name = name
        self.settings = settings
    }

    /// The settings with the machine-level fields (destination, custom
    /// folder, completion action, close-after) stripped back to
    /// defaults, so preset equality ignores them exactly like the
    /// desktop app's capture does.
    public static func captured(_ settings: AppSettings) -> AppSettings {
        var copy = settings
        copy.outputDestination = AppSettings().outputDestination
        copy.customOutputDirectory = ""
        copy.completionAction = AppSettings().completionAction
        copy.closeAppAfterExport = false
        return copy
    }
}
