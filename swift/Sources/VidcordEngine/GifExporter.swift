import AVFoundation
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers
import VidcordCore

public enum GifError: Error, CustomStringConvertible {
    case cancelled
    case readerFailed(String)
    case unsupportedFormat(String)
    case writeFailed(String)
    case noVideoTrack

    public var description: String {
        switch self {
        case .cancelled: return "cancelled"
        case .readerFailed(let why): return "reading the source failed: \(why)"
        case .unsupportedFormat(let why): return why
        case .writeFailed(let why): return "writing the animation failed: \(why)"
        case .noVideoTrack: return "the file has no video track"
        }
    }
}

/// Animated GIF and WebP export, the GIF mode of the desktop app built
/// on ImageIO instead of an FFmpeg palette pass: frames are sampled
/// from an AVAssetReader at the requested rate, scaled on the GPU, and
/// streamed into a CGImageDestination one frame at a time, so memory
/// stays flat. Size targeting reuses the same discipline as the video
/// engine: measure, project, step the plan (frame rate, then width)
/// down on oversize and up on underfill, bounded attempts.
public struct GifExporter {
    public init() {}

    /// Hard frame cap: an animation longer than this is a video
    /// wearing the wrong clothes. At 15 fps the cap is 80 seconds.
    private static let maxFrames = 1200

    public func export(
        request: GifRequest, outputDirectory: URL?,
        token: CancellationToken,
        progress: @escaping @Sendable (ProgressEvent) -> Void
    ) async throws -> CompressResult {
        let started = Date()
        progress(ProgressEvent(phase: .probing, fraction: 0, statusLine: "Probing..."))
        let info = try await VideoProbe.probe(url: request.sourceURL)
        let asset = AVURLAsset(url: request.sourceURL)
        let clipStart = max(0, min(request.rangeStartSeconds, info.durationSeconds))
        let clipDuration = max(
            0.1, min(request.rangeDurationSeconds ?? (info.durationSeconds - clipStart),
                     info.durationSeconds - clipStart))

        let directory = outputDirectory ?? request.sourceURL.deletingLastPathComponent()
        let outputURL = Compressor.reserveOutputURL(
            for: request.sourceURL, in: directory, extension: request.format.fileExtension)
        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vidcord-gif-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workDir) }

        // The plan ladder: start at the requested rate and width cap;
        // each retry scales one or both by the measured size ratio.
        var fps = min(request.fps, 30)
        var widthCap = request.maxWidth > 0 ? request.maxWidth : info.videoWidth
        var attempts: [AttemptRecord] = []
        var best: (url: URL, bytes: UInt64, fits: Bool)?
        var attemptNumber = 0

        while attemptNumber < 4 {
            if token.isCancelled { throw GifError.cancelled }
            attemptNumber += 1
            let labelAttempt = attemptNumber
            progress(ProgressEvent(
                phase: .encoding(attempt: attemptNumber), fraction: 0,
                statusLine:
                    "Rendering \(request.format.displayName) at \(Int(fps)) fps, \(widthCap) px wide..."))
            let attemptURL = workDir.appendingPathComponent("attempt-\(attemptNumber).\(request.format.fileExtension)")
            let bytes = try await renderOnce(
                asset: asset, info: info, rangeStart: clipStart, rangeDuration: clipDuration,
                fps: fps, widthCap: widthCap, format: request.format,
                outputURL: attemptURL, token: token,
                progress: { fraction in
                    progress(ProgressEvent(
                        phase: .encoding(attempt: labelAttempt), fraction: fraction,
                        statusLine:
                            "Rendering \(request.format.displayName) at \(Int(fps)) fps, \(widthCap) px wide..."))
                })

            guard let target = request.targetBytes else {
                attempts.append(AttemptRecord(
                    codec: .h264, videoBitrateKbps: 0, outputBytes: bytes,
                    note: "\(Int(fps)) fps, \(widthCap) px"))
                best = (attemptURL, bytes, true)
                break
            }

            let fits = bytes <= target
            attempts.append(AttemptRecord(
                codec: .h264, videoBitrateKbps: 0, outputBytes: bytes,
                note: "\(Int(fps)) fps, \(widthCap) px\(fits ? "" : ", oversize")"))
            if let current = best {
                if fits, !current.fits || bytes > current.bytes {
                    try? FileManager.default.removeItem(at: current.url)
                    best = (attemptURL, bytes, true)
                } else if !fits, !current.fits, bytes < current.bytes {
                    try? FileManager.default.removeItem(at: current.url)
                    best = (attemptURL, bytes, false)
                } else {
                    try? FileManager.default.removeItem(at: attemptURL)
                }
            } else {
                best = (attemptURL, bytes, fits)
            }

            if fits, SizeTarget.fill(targetBytes: target, outputBytes: bytes)
                >= SizeTarget.underfillRetryThreshold { break }
            if attemptNumber >= 4 { break }

            // Step the plan by the measured ratio, applied to the
            // pixel-throughput (fps times pixel count, so width moves
            // by the square root): oversize steps both down, underfill
            // steps the width back up within the user's caps.
            let ratio = Double(target) / Double(max(bytes, 1))
            if !fits {
                let shrink = (ratio * SizeTarget.safety).squareRoot()
                let newWidth = max(160, Int((Double(widthCap) * shrink).rounded()))
                let newFPS = max(5, (fps * (0.7 + 0.3 * shrink)).rounded())
                if newWidth == widthCap && Int(newFPS) == Int(fps) { break }
                widthCap = newWidth
                fps = newFPS
            } else {
                let grow = min((ratio * SizeTarget.safety).squareRoot(), 1.25)
                let capWidth = request.maxWidth > 0 ? request.maxWidth : info.videoWidth
                let newWidth = min(capWidth, Int((Double(widthCap) * grow).rounded()))
                if newWidth == widthCap { break }
                widthCap = newWidth
            }
        }

        guard let winner = best else { throw GifError.writeFailed("no render ran") }
        try? FileManager.default.removeItem(at: outputURL)
        try FileManager.default.moveItem(at: winner.url, to: outputURL)
        let fill = request.targetBytes.map {
            SizeTarget.fill(targetBytes: $0, outputBytes: winner.bytes)
        }
        progress(ProgressEvent(phase: .finished, fraction: 1, statusLine: "Done"))
        return CompressResult(
            outputURL: outputURL, outputBytes: winner.bytes, fill: fill,
            overTarget: request.targetBytes.map { winner.bytes > $0 } ?? false,
            attempts: attempts, elapsedSeconds: Date().timeIntervalSince(started))
    }

    /// One render: sample frames at `fps`, scale to `widthCap`, write
    /// the animation. Returns the byte count.
    private func renderOnce(
        asset: AVURLAsset, info: SourceInfo, rangeStart: Double, rangeDuration: Double,
        fps: Double, widthCap: Int, format: GifFormat, outputURL: URL,
        token: CancellationToken, progress: @escaping @Sendable (Double) -> Void
    ) async throws -> UInt64 {
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw GifError.noVideoTrack
        }
        let scale = min(1.0, Double(widthCap) / Double(max(info.videoWidth, 1)))
        var outWidth = Int((Double(info.videoWidth) * scale).rounded())
        var outHeight = Int((Double(info.videoHeight) * scale).rounded())
        outWidth -= outWidth % 2
        outHeight -= outHeight % 2
        outWidth = max(outWidth, 2)
        outHeight = max(outHeight, 2)

        let typeIdentifier: String
        let frameProperties: [String: Any]
        let loopProperties: [String: Any]
        switch format {
        case .gif:
            typeIdentifier = UTType.gif.identifier
            frameProperties = [
                kCGImagePropertyGIFDictionary as String: [
                    kCGImagePropertyGIFDelayTime as String: 1.0 / fps,
                    kCGImagePropertyGIFUnclampedDelayTime as String: 1.0 / fps,
                ],
            ]
            loopProperties = [
                kCGImagePropertyGIFDictionary as String: [
                    kCGImagePropertyGIFLoopCount as String: 0,
                ],
            ]
        case .webp:
            let writableTypes = (CGImageDestinationCopyTypeIdentifiers() as NSArray)
                .compactMap { $0 as? String }
            guard writableTypes.contains(UTType.webP.identifier) else {
                throw GifError.unsupportedFormat(
                    "this macOS build's ImageIO cannot write WebP animations")
            }
            typeIdentifier = UTType.webP.identifier
            frameProperties = [
                kCGImagePropertyWebPDictionary as String: [
                    kCGImagePropertyWebPDelayTime as String: 1.0 / fps,
                ],
            ]
            loopProperties = [
                kCGImagePropertyWebPDictionary as String: [
                    kCGImagePropertyWebPLoopCount as String: 0,
                ],
            ]
        }

        try? FileManager.default.removeItem(at: outputURL)
        guard let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL, typeIdentifier as CFString, Self.maxFrames, nil) else {
            throw GifError.writeFailed("could not create the image destination")
        }
        CGImageDestinationSetProperties(destination, loopProperties as CFDictionary)

        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: rangeStart, preferredTimescale: 600),
            duration: CMTime(seconds: rangeDuration, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(
            track: videoTrack,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_32BGRA,
            ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw GifError.readerFailed("could not add the video output")
        }
        reader.add(output)
        guard reader.startReading() else {
            throw GifError.readerFailed(
                reader.error?.localizedDescription ?? "unknown error")
        }

        let context = CIContext()
        let interval = 1.0 / fps
        var nextSlot = rangeStart
        var frames = 0
        var lastFraction = 0.0
        while let sample = output.copyNextSampleBuffer() {
            if token.isCancelled {
                reader.cancelReading()
                throw GifError.cancelled
            }
            let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
            guard pts.isFinite else { continue }
            if pts + 0.0001 < nextSlot { continue }
            nextSlot = pts + interval
            guard frames < Self.maxFrames,
                  let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            var image = CIImage(cvPixelBuffer: buffer)
            if scale < 1.0 {
                image = image.transformed(
                    by: CGAffineTransform(scaleX: scale, y: scale))
            }
            guard let cgImage = context.createCGImage(
                image, from: CGRect(x: 0, y: 0, width: outWidth, height: outHeight))
            else { continue }
            CGImageDestinationAddImage(destination, cgImage, frameProperties as CFDictionary)
            frames += 1
            let fraction = min(max((pts - rangeStart) / rangeDuration, 0), 1)
            if fraction - lastFraction > 0.02 {
                lastFraction = fraction
                progress(fraction)
            }
        }
        if reader.status == .failed {
            throw GifError.readerFailed(
                reader.error?.localizedDescription ?? "unknown error")
        }
        guard frames > 0, CGImageDestinationFinalize(destination) else {
            throw GifError.writeFailed("no frames could be written")
        }
        return (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size]
            as? NSNumber)?.uint64Value ?? 0
    }
}
