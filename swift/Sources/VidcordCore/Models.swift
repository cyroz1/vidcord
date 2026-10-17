import Foundation

/// Output codec for a compression job. Two phases exist because the Rust
/// pipeline gives a job a second phase when the first codec cannot land
/// the size: the Swift port mirrors that with HEVC first (VideoToolbox
/// hardware) and H.264 as the fallback phase, or the reverse when the
/// user picks H.264 first and HEVC declines.
public enum CodecChoice: String, CaseIterable, Sendable {
    case hevc
    case h264

    /// The other codec, used as the fallback phase.
    public var fallback: CodecChoice { self == .hevc ? .h264 : .hevc }

    public var displayName: String { self == .hevc ? "HEVC (H.265)" : "H.264" }
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
    /// The audio track's own average bitrate, when reported.
    public var audioBitrateKbps: Int?

    public init(
        durationSeconds: Double, fileBytes: UInt64, videoWidth: Int, videoHeight: Int,
        frameRate: Double, sourceBitrateKbps: Int?, hasAudio: Bool, audioBitrateKbps: Int?
    ) {
        self.durationSeconds = durationSeconds
        self.fileBytes = fileBytes
        self.videoWidth = videoWidth
        self.videoHeight = videoHeight
        self.frameRate = frameRate
        self.sourceBitrateKbps = sourceBitrateKbps
        self.hasAudio = hasAudio
        self.audioBitrateKbps = audioBitrateKbps
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
    /// Cap on the output height in pixels; 0 keeps the source height.
    public var maxHeight: Int
    /// Seconds into the source to start from. The engine supports a
    /// range because the preflight needs one; the app passes 0/full.
    public var rangeStartSeconds: Double
    public var rangeDurationSeconds: Double?

    public init(
        sourceURL: URL, targetBytes: UInt64?, codec: CodecChoice, keepAudio: Bool,
        maxHeight: Int, rangeStartSeconds: Double = 0, rangeDurationSeconds: Double? = nil
    ) {
        self.sourceURL = sourceURL
        self.targetBytes = targetBytes
        self.codec = codec
        self.keepAudio = keepAudio
        self.maxHeight = maxHeight
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
