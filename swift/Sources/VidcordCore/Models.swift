import Foundation

/// Output codec for a compression job. Two phases exist because the Rust
/// pipeline gives a job a second phase when the first codec cannot land
/// the size: the Swift port mirrors that with HEVC first (VideoToolbox
/// hardware) and H.264 as the fallback phase, or the reverse when the
/// user picks H.264 first and HEVC declines.
public enum CodecChoice: String, CaseIterable, Sendable, Codable {
    case hevc
    case h264

    /// The other codec, used as the fallback phase.
    public var fallback: CodecChoice { self == .hevc ? .h264 : .hevc }

    public var displayName: String { self == .hevc ? "HEVC (H.265)" : "H.264" }
}

/// One audio track in a source file, for the track picker.
public struct AudioTrackInfo: Sendable, Equatable {
    /// Position among the file's audio tracks, 0-based.
    public var index: Int
    /// Human label: language and codec when the container offers them.
    public var label: String
    public var bitrateKbps: Int?

    public init(index: Int, label: String, bitrateKbps: Int?) {
        self.index = index
        self.label = label
        self.bitrateKbps = bitrateKbps
    }
}

/// What the probe learned about a source file. Pure data: the engine
/// fills it from AVFoundation, the app only reads it.
public struct SourceInfo: Sendable, Equatable {
    public var durationSeconds: Double
    public var fileBytes: UInt64
    public var videoWidth: Int
    public var videoHeight: Int
    public var frameRate: Double
    /// Combined average bitrate of the file, when the container reports one.
    public var sourceBitrateKbps: Int?
    public var hasAudio: Bool
    /// The first audio track's own average bitrate, when reported.
    public var audioBitrateKbps: Int?
    /// Every audio track, in file order.
    public var audioTracks: [AudioTrackInfo]

    public init(
        durationSeconds: Double, fileBytes: UInt64, videoWidth: Int, videoHeight: Int,
        frameRate: Double, sourceBitrateKbps: Int?, hasAudio: Bool, audioBitrateKbps: Int?,
        audioTracks: [AudioTrackInfo] = []
    ) {
        self.durationSeconds = durationSeconds
        self.fileBytes = fileBytes
        self.videoWidth = videoWidth
        self.videoHeight = videoHeight
        self.frameRate = frameRate
        self.sourceBitrateKbps = sourceBitrateKbps
        self.hasAudio = hasAudio
        self.audioBitrateKbps = audioBitrateKbps
        self.audioTracks = audioTracks
    }
}

/// Crop shapes offered beside the source's own aspect. Raw values match
/// the desktop app's `crop_aspect_ratio` strings.
public enum CropAspect: String, CaseIterable, Sendable, Codable {
    case original = ""
    case square = "1:1"
    case portrait = "4:5"
    case vertical = "9:16"
    case wide = "16:9"
    case classic = "4:3"

    public var displayName: String {
        switch self {
        case .original: return "Original"
        default: return rawValue
        }
    }

    /// Width over height for the shape, nil for the source's own aspect.
    public var ratio: Double? {
        switch self {
        case .original: return nil
        case .square: return 1.0
        case .portrait: return 4.0 / 5.0
        case .vertical: return 9.0 / 16.0
        case .wide: return 16.0 / 9.0
        case .classic: return 4.0 / 3.0
        }
    }
}

/// One compression job, as the app describes it. The budget is the
/// unshrunk target: the engine owns every margin (see `SizeTarget`).
public struct CompressRequest: Sendable {
    public var sourceURL: URL
    /// Byte budget for the output, or nil for a quality-only encode.
    public var targetBytes: UInt64?
    public var codec: CodecChoice
    public var keepAudio: Bool
    /// Which audio tracks to carry, by their probe index. nil keeps the
    /// first track; an empty array (or keepAudio false) drops audio.
    public var audioTrackIndices: [Int]?
    /// Peak-normalize the audio before the gain stage (engine measures
    /// the selected range's peak and scales to full scale, capped).
    public var normalizeAudio: Bool
    /// Linear gain applied to the audio samples after any normalize.
    public var audioGain: Double
    /// Cap on the output height in pixels; 0 keeps the source height.
    public var maxHeight: Int
    /// Frame-rate cap for the output; nil keeps the source rate.
    public var outputFPS: Double?
    /// Crop applied before any scaling.
    public var cropAspect: CropAspect
    /// Seconds into the source to start from.
    public var rangeStartSeconds: Double
    public var rangeDurationSeconds: Double?
    /// Where the output lands; nil means beside the source.
    public var outputDirectory: URL?

    public init(
        sourceURL: URL, targetBytes: UInt64?, codec: CodecChoice, keepAudio: Bool,
        maxHeight: Int, audioTrackIndices: [Int]? = nil, normalizeAudio: Bool = false,
        audioGain: Double = 1.0, outputFPS: Double? = nil, cropAspect: CropAspect = .original,
        rangeStartSeconds: Double = 0, rangeDurationSeconds: Double? = nil,
        outputDirectory: URL? = nil
    ) {
        self.sourceURL = sourceURL
        self.targetBytes = targetBytes
        self.codec = codec
        self.keepAudio = keepAudio
        self.maxHeight = maxHeight
        self.audioTrackIndices = audioTrackIndices
        self.normalizeAudio = normalizeAudio
        self.audioGain = audioGain
        self.outputFPS = outputFPS
        self.cropAspect = cropAspect
        self.rangeStartSeconds = rangeStartSeconds
        self.rangeDurationSeconds = rangeDurationSeconds
        self.outputDirectory = outputDirectory
    }
}

/// Animated-image output format, the desktop app's two GIF-mode formats.
public enum GifFormat: String, CaseIterable, Sendable, Codable {
    case gif
    case webp

    public var displayName: String { self == .gif ? "GIF" : "WebP" }
    public var fileExtension: String { rawValue }
}

/// One animated-image export job.
public struct GifRequest: Sendable {
    public var sourceURL: URL
    public var format: GifFormat
    /// Byte budget, or nil for best quality at the chosen settings.
    public var targetBytes: UInt64?
    /// Frames per second to sample at.
    public var fps: Double
    /// Cap on the output width in pixels; 0 keeps the source width.
    public var maxWidth: Int
    public var rangeStartSeconds: Double
    public var rangeDurationSeconds: Double?

    public init(
        sourceURL: URL, format: GifFormat, targetBytes: UInt64?, fps: Double,
        maxWidth: Int, rangeStartSeconds: Double = 0, rangeDurationSeconds: Double? = nil
    ) {
        self.sourceURL = sourceURL
        self.format = format
        self.targetBytes = targetBytes
        self.fps = fps
        self.maxWidth = maxWidth
        self.rangeStartSeconds = rangeStartSeconds
        self.rangeDurationSeconds = rangeDurationSeconds
    }
}

/// One encode the engine actually ran, kept for the result report.
public struct AttemptRecord: Sendable, Equatable {
    public var codec: CodecChoice
    public var videoBitrateKbps: Int
    public var outputBytes: UInt64
    public var note: String

    public init(codec: CodecChoice, videoBitrateKbps: Int, outputBytes: UInt64, note: String) {
        self.codec = codec
        self.videoBitrateKbps = videoBitrateKbps
        self.outputBytes = outputBytes
        self.note = note
    }
}

/// The outcome of a job: where the best attempt landed, and the trail.
public struct CompressResult: Sendable {
    public var outputURL: URL
    public var outputBytes: UInt64
    /// Fill of the target, or nil for a quality-only encode.
    public var fill: Double?
    /// True when no attempt landed at or under the target and the
    /// smallest oversize attempt is what was delivered.
    public var overTarget: Bool
    public var attempts: [AttemptRecord]
    public var elapsedSeconds: Double

    public init(
        outputURL: URL, outputBytes: UInt64, fill: Double?, overTarget: Bool,
        attempts: [AttemptRecord], elapsedSeconds: Double
    ) {
        self.outputURL = outputURL
        self.outputBytes = outputBytes
        self.fill = fill
        self.overTarget = overTarget
        self.attempts = attempts
        self.elapsedSeconds = elapsedSeconds
    }
}

/// Progress the engine reports while a job runs. `fraction` is the
/// share of the current encode's timeline consumed, 0...1.
public struct ProgressEvent: Sendable {
    public enum Phase: Sendable {
        case probing
        case preflight
        case encoding(attempt: Int)
        case finished
    }

    public var phase: Phase
    public var fraction: Double
    public var statusLine: String

    public init(phase: Phase, fraction: Double, statusLine: String) {
        self.phase = phase
        self.fraction = fraction
        self.statusLine = statusLine
    }
}
