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
        var trackInfos: [AudioTrackInfo] = []
        for (index, audio) in audioTracks.enumerated() {
            let rate = try await audio.load(.estimatedDataRate)
            let kbps = rate > 0 ? Int(rate / 1000) : nil
            if index == 0 { audioKbps = kbps }
            var label = "Track \(index + 1)"
            var parts: [String] = []
            let language = (try? await audio.load(.languageCode)) ?? nil
            if let language { parts.append(language) }
            if let description = try await audio.load(.formatDescriptions).first {
                let subtype = CMFormatDescriptionGetMediaSubType(description)
                let fourCC = Self.fourCC(subtype)
                if !fourCC.isEmpty { parts.append(fourCC) }
            }
            if !parts.isEmpty { label += " (" + parts.joined(separator: ", ") + ")" }
            if let kbps { label += " · \(kbps) kbps" }
            trackInfos.append(AudioTrackInfo(index: index, label: label, bitrateKbps: kbps))
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
            audioBitrateKbps: audioKbps,
            audioTracks: trackInfos
        )
    }

    /// A FourCC media subtype as text ("aac ", "mp4a" and friends are
    /// not all printable, so non-printable bytes are dropped).
    private static func fourCC(_ subtype: FourCharCode) -> String {
        let bytes: [UInt8] = [
            UInt8((subtype >> 24) & 0xFF), UInt8((subtype >> 16) & 0xFF),
            UInt8((subtype >> 8) & 0xFF), UInt8(subtype & 0xFF),
        ]
        let printable = bytes.filter { $0 >= 0x20 && $0 < 0x7F }
        return String(bytes: printable, encoding: .ascii)?.trimmingCharacters(
            in: .whitespaces) ?? ""
    }
}
