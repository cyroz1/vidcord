import AVFoundation
import CoreMedia
import Foundation
import VidcordCore

public enum ProbeError: Error, CustomStringConvertible {
    case noVideoTrack
    case unreadableDuration

    public var description: String {
        switch self {
        case .noVideoTrack: return "the file has no video track"
        case .unreadableDuration: return "the file's duration could not be read"
        }
    }
}

/// Probing, the AVFoundation counterpart of the Rust backend's FFprobe
/// pass: duration, encode dimensions (natural size, rotation carried
/// separately as the track transform), frame rate, average bitrates,
/// audio presence.
public enum VideoProbe {
    public static func probe(url: URL) async throws -> SourceInfo {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let durationSeconds = CMTimeGetSeconds(duration)
        guard durationSeconds.isFinite, durationSeconds > 0 else {
            throw ProbeError.unreadableDuration
        }

        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let video = videoTracks.first else { throw ProbeError.noVideoTrack }
        // Encode geometry is the track's natural size: the preferred
        // transform is passed through to the writer separately, so
        // rotation is applied once, as metadata, never baked twice.
        let naturalSize = try await video.load(.naturalSize)
        let frameRate = Double(try await video.load(.nominalFrameRate))

        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        var audioKbps: Int?
        if let audio = audioTracks.first {
            let rate = try await audio.load(.estimatedDataRate)
            if rate > 0 { audioKbps = Int(rate / 1000) }
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let fileBytes = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        let averageKbps =
            fileBytes > 0 ? Int(Double(fileBytes) * 8.0 / durationSeconds / 1000.0) : nil

        return SourceInfo(
            durationSeconds: durationSeconds,
            fileBytes: fileBytes,
            videoWidth: Int(abs(naturalSize.width).rounded()),
            videoHeight: Int(abs(naturalSize.height).rounded()),
            frameRate: frameRate,
            sourceBitrateKbps: averageKbps,
            hasAudio: !audioTracks.isEmpty,
            audioBitrateKbps: audioKbps
        )
    }
}
