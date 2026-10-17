import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VidcordCore

public enum CompressError: Error, CustomStringConvertible {
    case cancelled
    case readerFailed(String)
    case writerFailed(String)
    case noVideoTrack

    public var description: String {
        switch self {
        case .cancelled: return "cancelled"
        case .readerFailed(let why): return "reading the source failed: \(why)"
        case .writerFailed(let why): return "writing the output failed: \(why)"
        case .noVideoTrack: return "the file has no video track"
        }
    }
}

/// Cooperative cancellation for a running job, safe to poke from any
/// thread while the encode pumps run on their own queues.
public final class CancellationToken: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    public init() {}

    public func cancel() {
        lock.lock()
        flag = true
        lock.unlock()
    }

    public var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }
}

/// The compression engine: an imperative shell around the pure
/// `SizeTarget` policy, the same layering Sill uses. AVAssetReader feeds
/// decoded frames straight into an AVAssetWriter (VideoToolbox does the
/// encode in hardware); nothing is held in memory beyond the frame in
/// flight, and no FFmpeg or other third-party code is involved.
///
/// The job loop mirrors the 7.7 Rust pipeline: an optional mid-clip
/// preflight sample turns into the first bitrate, each encode is judged
/// against the target, oversize retries step the bitrate down and
/// underfill retries step it up (bounded per codec), and when a codec
/// phase cannot land the size the other codec gets its own phase.
public struct Compressor {
    public init() {}

    public func compress(
        request: CompressRequest,
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

        // Audio allocation: the source's own rate when known, capped at
        // 160 kbps, stepping down (and finally off) when the budget is so
        // tight the video would fall to the bitrate floor.
        var audioKbps: Int? =
            (request.keepAudio && info.hasAudio)
            ? min(max(info.audioBitrateKbps ?? 128, 32), 160) : nil
        var firstBitrate: Int
        if let target = request.targetBytes {
            firstBitrate = SizeTarget.initialVideoBitrateKbps(
                targetBytes: target, durationSeconds: clipDuration,
                audioBitrateKbps: audioKbps ?? 0)
            for fallbackAudio in [96, 64, 48] where firstBitrate <= SizeTarget.minimumBitrateKbps
                && (audioKbps ?? 0) > fallbackAudio {
                audioKbps = fallbackAudio
                firstBitrate = SizeTarget.initialVideoBitrateKbps(
                    targetBytes: target, durationSeconds: clipDuration,
                    audioBitrateKbps: fallbackAudio)
            }
            if firstBitrate <= SizeTarget.minimumBitrateKbps, audioKbps != nil {
                audioKbps = nil
                firstBitrate = SizeTarget.initialVideoBitrateKbps(
                    targetBytes: target, durationSeconds: clipDuration, audioBitrateKbps: 0)
            }
        } else {
            // Quality-only encode: hold roughly the source's video rate.
            let sourceVideo = (info.sourceBitrateKbps ?? 8000) - (info.audioBitrateKbps ?? 0)
            firstBitrate = min(max(sourceVideo, 500), 12000)
        }

        let outputSize = SizeTarget.scaledSize(
            sourceWidth: info.videoWidth, sourceHeight: info.videoHeight,
            maxHeight: request.maxHeight)

        // Preflight: encode a short mid-clip sample at the trial bitrate
        // and let its margin-free projection set the first real bitrate.
        if let target = request.targetBytes,
           SizeTarget.shouldPreflight(hasTarget: true, clipDuration: clipDuration) {
            progress(ProgressEvent(phase: .preflight, fraction: 0, statusLine: "Sampling the middle of the clip..."))
            let sampleSeconds = SizeTarget.preflightSampleSeconds(clipDuration: clipDuration)
            let sampleStart = SizeTarget.preflightSampleStart(
                clipStart: clipStart, clipDuration: clipDuration, sampleDuration: sampleSeconds)
            let sampleURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("vidcord-preflight-\(UUID().uuidString).mp4")
            if let sampleBytes = try? await encodeOnce(
                asset: asset, info: info, rangeStart: sampleStart, rangeDuration: sampleSeconds,
                videoKbps: firstBitrate, codec: request.codec, audioKbps: nil,
                outputSize: outputSize, outputURL: sampleURL, token: token,
                progress: { _ in })
            {
                let projectedVideo = SizeTarget.projectedSize(
                    sampleBytes: sampleBytes, sampleDuration: sampleSeconds,
                    clipDuration: clipDuration)
                let audioBytes =
                    UInt64(Double(audioKbps ?? 0) * 1000.0 / 8.0 * clipDuration)
                let projectedTotal = projectedVideo + audioBytes
                if projectedTotal > target {
                    firstBitrate = SizeTarget.bitrateForOversizeProjection(
                        currentKbps: firstBitrate, targetBytes: target,
                        projectedBytes: projectedTotal)
                } else if SizeTarget.fill(targetBytes: target, outputBytes: projectedTotal)
                    < SizeTarget.underfillRetryThreshold {
                    firstBitrate = SizeTarget.bitrateForUnderfillProjection(
                        currentKbps: firstBitrate, targetBytes: target,
                        projectedBytes: projectedTotal,
                        sourceBitrateKbps: info.sourceBitrateKbps)
                }
            }
            try? FileManager.default.removeItem(at: sampleURL)
        }

        // Reserve the output path up front (the Rust pipeline's
        // create-new reservation): collision-free `<stem>-vidcord[-N].mp4`
        // next to the source.
        let outputURL = Self.reserveOutputURL(for: request.sourceURL)
        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vidcord-swift-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workDir) }

        var attempts: [AttemptRecord] = []
        var best: (url: URL, bytes: UInt64, fits: Bool)?
        var bitrate = firstBitrate
        var attemptNumber = 0
        var accepted = false

        for (phaseIndex, codec) in [request.codec, request.codec.fallback].enumerated() {
            if phaseIndex > 0 {
                // A second codec phase only runs when the first could not
                // land the size at all. It inherits the last bitrate.
                guard let current = best, !current.fits, request.targetBytes != nil else { break }
                _ = current
            }
            var retries = 0
            while true {
                if token.isCancelled { throw CompressError.cancelled }
                attemptNumber += 1
                progress(ProgressEvent(
                    phase: .encoding(attempt: attemptNumber), fraction: 0,
                    statusLine: "Compressing at \(bitrate) kbps (\(codec.displayName))..."))
                let attemptURL = workDir.appendingPathComponent("attempt-\(attemptNumber).mp4")
                let bytes = try await encodeOnce(
                    asset: asset, info: info, rangeStart: clipStart,
                    rangeDuration: clipDuration, videoKbps: bitrate, codec: codec,
                    audioKbps: audioKbps, outputSize: outputSize, outputURL: attemptURL,
                    token: token,
                    progress: { fraction in
                        progress(ProgressEvent(
                            phase: .encoding(attempt: attemptNumber), fraction: fraction,
                            statusLine: "Compressing at \(bitrate) kbps (\(codec.displayName))..."))
                    })

                guard let target = request.targetBytes else {
                    attempts.append(AttemptRecord(
                        codec: codec, videoBitrateKbps: bitrate, outputBytes: bytes,
                        note: "quality encode"))
                    best = (attemptURL, bytes, true)
                    accepted = true
                    break
                }

                let fits = bytes <= target
                let note: String
                if !fits { note = "oversize" }
                else if SizeTarget.fill(targetBytes: target, outputBytes: bytes)
                    >= SizeTarget.underfillRetryThreshold { note = "accepted" }
                else { note = "underfilled" }
                attempts.append(AttemptRecord(
                    codec: codec, videoBitrateKbps: bitrate, outputBytes: bytes, note: note))

                // Best so far: the fullest fit wins; while nothing fits,
                // the smallest oversize wins.
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

                if !fits {
                    if let next = SizeTarget.nextOversizeBitrate(
                        currentKbps: bitrate, targetBytes: target, outputBytes: bytes,
                        retriesUsed: retries) {
                        bitrate = next
                        retries += 1
                        continue
                    }
                    break // this codec's retries are spent; maybe a fallback phase
                }
                if SizeTarget.fill(targetBytes: target, outputBytes: bytes)
                    < SizeTarget.underfillRetryThreshold,
                   let next = SizeTarget.nextUnderfillBitrate(
                       currentKbps: bitrate, targetBytes: target, outputBytes: bytes,
                       retriesUsed: retries, sourceBitrateKbps: info.sourceBitrateKbps) {
                    bitrate = next
                    retries += 1
                    continue
                }
                accepted = true
                break
            }
            if accepted { break }
        }

        guard let winner = best else { throw CompressError.writerFailed("no encode ran") }
        // Publish: the reservation placeholder gives way to the winner.
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

    /// First free `<stem>-vidcord.mp4`, `<stem>-vidcord-2.mp4`, ... next
    /// to the source, created empty so the name is held for the job.
    private static func reserveOutputURL(for source: URL) -> URL {
        let directory = source.deletingLastPathComponent()
        let stem = source.deletingPathExtension().lastPathComponent
        var candidate = directory.appendingPathComponent("\(stem)-vidcord.mp4")
        var suffix = 2
        while !FileManager.default.createFile(atPath: candidate.path, contents: nil),
              suffix <= 999 {
            candidate = directory.appendingPathComponent("\(stem)-vidcord-\(suffix).mp4")
            suffix += 1
        }
        return candidate
    }

    // MARK: - One encode

    /// A single reader-to-writer transcode of one range of the source.
    /// Returns the output's byte count. Frames stream through: the
    /// reader decodes, the writer's VideoToolbox session encodes, and
    /// progress follows the video timestamps.
    private func encodeOnce(
        asset: AVURLAsset, info: SourceInfo, rangeStart: Double, rangeDuration: Double,
        videoKbps: Int, codec: CodecChoice, audioKbps: Int?,
        outputSize: (width: Int, height: Int), outputURL: URL,
        token: CancellationToken, progress: @escaping @Sendable (Double) -> Void
    ) async throws -> UInt64 {
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw CompressError.noVideoTrack
        }
        let transform = try await videoTrack.load(.preferredTransform)

        let reader = try AVAssetReader(asset: asset)
        let start = CMTime(seconds: rangeStart, preferredTimescale: 600)
        let duration = CMTime(seconds: rangeDuration, preferredTimescale: 600)
        reader.timeRange = CMTimeRange(start: start, duration: duration)

        let videoOutput = AVAssetReaderTrackOutput(
            track: videoTrack,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            ])
        videoOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOutput) else {
            throw CompressError.readerFailed("could not add the video output")
        }
        reader.add(videoOutput)

        var audioOutput: AVAssetReaderTrackOutput?
        var audioSampleRate = 48000.0
        var audioChannels = 2
        if audioKbps != nil,
           let audioTrack = try await asset.loadTracks(withMediaType: .audio).first {
            if let description = try await audioTrack.load(.formatDescriptions).first,
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description) {
                audioSampleRate = asbd.pointee.mSampleRate
                audioChannels = Int(asbd.pointee.mChannelsPerFrame)
            }
            let output = AVAssetReaderTrackOutput(
                track: audioTrack,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false,
                    AVLinearPCMIsNonInterleaved: false,
                ])
            output.alwaysCopiesSampleData = false
            if reader.canAdd(output) {
                reader.add(output)
                audioOutput = output
            }
        }

        try? FileManager.default.removeItem(at: outputURL)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true

        // Rate control mirrors the Rust VBV pairing: an average rate at
        // the planned bitrate, with a data-rate limit of twice that over
        // a one-second window standing in for -maxrate/-bufsize 2x.
        var compressionProperties: [String: Any] = [
            AVVideoAverageBitRateKey: videoKbps * 1000,
            AVVideoDataRateLimitsKey: [
                NSNumber(value: videoKbps * 2000), NSNumber(value: 1.0),
            ],
        ]
        if info.frameRate > 0 {
            compressionProperties[AVVideoExpectedSourceFrameRateKey] =
                Int(info.frameRate.rounded())
            compressionProperties[AVVideoMaxKeyFrameIntervalKey] =
                Int((info.frameRate * 2).rounded())
        }
        let videoInput = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
                AVVideoWidthKey: outputSize.width,
                AVVideoHeightKey: outputSize.height,
                AVVideoCompressionPropertiesKey: compressionProperties,
            ])
        videoInput.transform = transform
        videoInput.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey as String: outputSize.width,
                kCVPixelBufferHeightKey as String: outputSize.height,
            ])
        guard writer.canAdd(videoInput) else {
            throw CompressError.writerFailed("could not add the video input")
        }
        writer.add(videoInput)

        var audioInput: AVAssetWriterInput?
        if let audioKbps, audioOutput != nil {
            let input = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: audioSampleRate,
                    AVNumberOfChannelsKey: max(1, audioChannels),
                    AVEncoderBitRateKey: audioKbps * 1000,
                ])
            input.expectsMediaDataInRealTime = false
            if writer.canAdd(input) {
                writer.add(input)
                audioInput = input
            }
        }

        return try await withCheckedThrowingContinuation { continuation in
            let pump = PumpState()
            guard reader.startReading() else {
                continuation.resume(
                    throwing: CompressError.readerFailed(
                        reader.error?.localizedDescription ?? "unknown error"))
                return
            }
            writer.startWriting()
            writer.startSession(atSourceTime: .zero)
            let offset = CMTimeSubtract(.zero, start)

            func finishIfReady() {
                pump.lock.lock()
                let ready = pump.videoFinished && (audioInput == nil || pump.audioFinished)
                let already = pump.completed
                if ready && !already { pump.completed = true }
                pump.lock.unlock()
                guard ready && !already else { return }
                if token.isCancelled {
                    writer.cancelWriting()
                    continuation.resume(throwing: CompressError.cancelled)
                    return
                }
                if reader.status == .failed {
                    writer.cancelWriting()
                    continuation.resume(
                        throwing: CompressError.readerFailed(
                            reader.error?.localizedDescription ?? "unknown error"))
                    return
                }
                writer.finishWriting {
                    if writer.status == .completed {
                        let bytes =
                            (try? FileManager.default.attributesOfItem(
                                atPath: outputURL.path)[.size] as? NSNumber)?
                            .uint64Value ?? 0
                        continuation.resume(returning: bytes)
                    } else {
                        continuation.resume(
                            throwing: CompressError.writerFailed(
                                writer.error?.localizedDescription ?? "unknown error"))
                    }
                }
            }

            videoInput.requestMediaDataWhenReady(
                on: DispatchQueue(label: "vidcord.swift.video"))
            {
                while videoInput.isReadyForMoreMediaData {
                    if token.isCancelled {
                        reader.cancelReading()
                        videoInput.markAsFinished()
                        pump.lock.lock(); pump.videoFinished = true; pump.lock.unlock()
                        finishIfReady()
                        return
                    }
                    guard let sample = videoOutput.copyNextSampleBuffer() else {
                        videoInput.markAsFinished()
                        pump.lock.lock(); pump.videoFinished = true; pump.lock.unlock()
                        finishIfReady()
                        return
                    }
                    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
                    let pts = CMTimeAdd(
                        CMSampleBufferGetPresentationTimeStamp(sample), offset)
                    if !adaptor.append(buffer, withPresentationTime: pts) {
                        if writer.status == .failed {
                            reader.cancelReading()
                            videoInput.markAsFinished()
                            pump.lock.lock(); pump.videoFinished = true; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                    }
                    let seconds = CMTimeGetSeconds(pts)
                    if seconds.isFinite, rangeDuration > 0 {
                        progress(min(max(seconds / rangeDuration, 0), 1))
                    }
                }
            }

            if let audioInput, let audioOutput {
                audioInput.requestMediaDataWhenReady(
                    on: DispatchQueue(label: "vidcord.swift.audio"))
                {
                    while audioInput.isReadyForMoreMediaData {
                        if token.isCancelled {
                            reader.cancelReading()
                            audioInput.markAsFinished()
                            pump.lock.lock(); pump.audioFinished = true; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                        guard let sample = audioOutput.copyNextSampleBuffer() else {
                            audioInput.markAsFinished()
                            pump.lock.lock(); pump.audioFinished = true; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                        let shifted =
                            Self.shiftedSample(sample, by: offset) ?? sample
                        if !audioInput.append(shifted), writer.status == .failed {
                            reader.cancelReading()
                            audioInput.markAsFinished()
                            pump.lock.lock(); pump.audioFinished = true; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                    }
                }
            }
        }
    }

    /// A copy of a sample buffer with its timing shifted by `offset`
    /// (used to rebase a mid-clip range to zero). Returns nil when the
    /// copy cannot be made, so the caller can fall back to the original.
    private static func shiftedSample(
        _ sample: CMSampleBuffer, by offset: CMTime
    ) -> CMSampleBuffer? {
        if CMTimeCompare(offset, .zero) == 0 { return sample }
        var count: CMItemCount = 0
        guard CMSampleBufferGetSampleTimingInfoArray(
            sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr,
              count > 0 else { return nil }
        var timings = [CMSampleTimingInfo](
            repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(
            sample, entryCount: count, arrayToFill: &timings,
            entriesNeededOut: &count) == noErr else { return nil }
        for index in timings.indices {
            timings[index].presentationTimeStamp = CMTimeAdd(
                timings[index].presentationTimeStamp, offset)
            if timings[index].decodeTimeStamp.isValid {
                timings[index].decodeTimeStamp = CMTimeAdd(
                    timings[index].decodeTimeStamp, offset)
            }
        }
        var shifted: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(
            allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: count,
            sampleTimingArray: &timings, sampleBufferOut: &shifted) == noErr
        else { return nil }
        return shifted
    }
}

/// Mutable state shared by one encode's two pump closures.
private final class PumpState: @unchecked Sendable {
    let lock = NSLock()
    var videoFinished = false
    var audioFinished = false
    var completed = false
}
