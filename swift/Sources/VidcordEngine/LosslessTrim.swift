import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers
import VidcordCore

public enum TrimError: Error, CustomStringConvertible {
    case cancelled
    case exportFailed(String)
    case incompatible

    public var description: String {
        switch self {
        case .cancelled: return "cancelled"
        case .exportFailed(let why): return "the lossless export failed: \(why)"
        case .incompatible: return "this source cannot be stream-copied"
        }
    }
}

/// Lossless Trim, the desktop app's stream-copy mode: no re-encode,
/// the samples pass through AVAssetExportSession's passthrough preset
/// over the chosen range. Boundaries snap outward to keyframes (start
/// back, end forward) like the original, which is why the mode asks
/// for the keyframe list first. When the container refuses the copy,
/// the caller falls back to a normal compression of the same range,
/// again like the original (its fallback path with its own target).
public enum LosslessTrim {
    /// Keyframe timestamps in the range, seconds from the source's
    /// start, read from the compressed samples' sync flags. Bounded
    /// like the original's FFprobe pass: scanning stops after 100,000
    /// samples or when the range is exhausted.
    public static func keyframes(
        asset: AVURLAsset, rangeStart: Double, rangeDuration: Double
    ) async throws -> [Double] {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            return []
        }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: rangeStart, preferredTimescale: 600),
            duration: CMTime(seconds: rangeDuration, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return [] }
        reader.add(output)
        guard reader.startReading() else { return [] }
        var times: [Double] = []
        var scanned = 0
        while let sample = output.copyNextSampleBuffer(), scanned < 100_000 {
            scanned += 1
            if isSync(sample) {
                let pts = CMTimeGetSeconds(
                    CMSampleBufferGetPresentationTimeStamp(sample))
                if pts.isFinite { times.append(pts) }
            }
        }
        reader.cancelReading()
        return times
    }

    private static func isSync(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sample, createIfNecessary: false) as? [NSDictionary],
              let first = attachments.first else {
            // No attachment array means every sample is a sync sample
            // (some containers mark them that way).
            return true
        }
        if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            return !notSync
        }
        return true
    }

    /// Snap a range outward to the keyframe grid: the start moves back
    /// to the keyframe at or before it, the end forward to the first
    /// keyframe at or after it. Pure, so it is testable in VidcordCore's
    /// spirit; kept here beside its only caller.
    public static func snappedRange(
        start: Double, end: Double, keyframes: [Double], sourceDuration: Double
    ) -> (start: Double, end: Double) {
        let snappedStart = keyframes.last(where: { $0 <= start }) ?? 0
        let snappedEnd = keyframes.first(where: { $0 >= end }) ?? sourceDuration
        return (snappedStart, max(snappedEnd, snappedStart + 0.1))
    }

    /// Stream-copy the range into `outputURL`. Throws `.incompatible`
    /// when the passthrough refuses, so the caller can fall back.
    public static func export(
        asset: AVURLAsset, rangeStart: Double, rangeDuration: Double,
        outputURL: URL, token: CancellationToken,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        guard let session = AVAssetExportSession(
            asset: asset, presetName: AVAssetExportPresetPassthrough) else {
            throw TrimError.incompatible
        }
        // Prefer MP4; keep the source's own container when MP4 is not
        // among the compatible types, like the original's order.
        let types = await session.supportedFileTypes
        let fileType: AVFileType
        if types.contains(.mp4) {
            fileType = .mp4
        } else if let first = types.first(where: { $0 == .mov || $0 == .m4v }) ?? types.first {
            fileType = first
        } else {
            throw TrimError.incompatible
        }
        session.timeRange = CMTimeRange(
            start: CMTime(seconds: rangeStart, preferredTimescale: 600),
            duration: CMTime(seconds: rangeDuration, preferredTimescale: 600))
        try? FileManager.default.removeItem(at: outputURL)
        let ticker = Task {
            while !Task.isCancelled {
                progress(session.progress)
                if token.isCancelled { session.cancelExport() }
                try? await Task.sleep(for: .milliseconds(120))
            }
        }
        defer { ticker.cancel() }
        do {
            try await session.export(to: outputURL, as: fileType)
        } catch let error as NSError {
            if token.isCancelled { throw TrimError.cancelled }
            if error.domain == AVFoundationErrorDomain {
                throw TrimError.incompatible
            }
            throw TrimError.exportFailed(error.localizedDescription)
        }
        if token.isCancelled { throw TrimError.cancelled }
    }
}

/// Frame snapshots and timeline thumbnails through
/// AVAssetImageGenerator: the desktop app captures from its HTML
/// player; the port reads the frames from the asset directly, which
/// is sharper and works before any playback. Snapshots are capped at
/// 1920 px on the long edge, the cap the desktop app restored in 7.7.
public enum Snapshots {
    public static let maxDimension = 1920

    public static func frame(
        asset: AVURLAsset, atSeconds seconds: Double
    ) async throws -> CGImage {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxDimension, height: maxDimension)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let (image, _) = try await generator.image(
            at: CMTime(seconds: seconds, preferredTimescale: 600))
        return image
    }

    /// `count` frames spread evenly over the range, for the trim
    /// timeline's filmstrip. Tolerances are loose on purpose: a
    /// filmstrip wants speed, not frame accuracy.
    public static func thumbnails(
        asset: AVURLAsset, rangeStart: Double, rangeDuration: Double, count: Int
    ) async -> [CGImage] {
        guard count > 0, rangeDuration > 0 else { return [] }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 320, height: 320)
        generator.requestedTimeToleranceBefore = CMTime(
            seconds: rangeDuration / Double(count) / 2, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = generator.requestedTimeToleranceBefore
        var images: [CGImage] = []
        for index in 0..<count {
            let at = rangeStart + rangeDuration * (Double(index) + 0.5) / Double(count)
            if let (image, _) = try? await generator.image(
                at: CMTime(seconds: at, preferredTimescale: 600)) {
                images.append(image)
            }
        }
        return images
    }

    /// Save an image as a PNG next to the source or in the destination
    /// directory, with the desktop app's naming: `<stem>-snapshot[-N].png`.
    public static func savePNG(_ image: CGImage, source: URL, in directory: URL) throws -> URL {
        let url = Compressor.reserveOutputURL(for: source, in: directory, extension: "png")
        // reserveOutputURL gives a -vidcord name; snapshots carry their
        // own suffix, so swap it before writing.
        let snapshotURL = url.deletingLastPathComponent()
            .appendingPathComponent(
                url.lastPathComponent.replacingOccurrences(
                    of: "-vidcord", with: "-snapshot"))
        if snapshotURL != url {
            try? FileManager.default.removeItem(at: url)
        }
        guard let destination = CGImageDestinationCreateWithURL(
            snapshotURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return snapshotURL
    }
}
