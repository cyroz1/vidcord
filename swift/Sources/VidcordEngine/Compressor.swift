import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
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
/// `SizeTarget` policy, the same layering Sill uses. AVAssetReader
/// feeds decoded frames into an AVAssetWriter (VideoToolbox encodes in
/// hardware); frames are cropped and scaled on the GPU through
/// CoreImage into the writer's own buffers, so nothing is held in
/// memory beyond the frame in flight. No FFmpeg, no third-party code.
///
/// The job loop mirrors the 7.7 Rust pipeline: an optional mid-clip
/// preflight sample turns into the first bitrate, each encode is
/// judged against the target, oversize retries step the bitrate down
/// and underfill retries step it up (bounded per codec), and when a
/// codec phase cannot land the size the other codec gets its phase.
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

        // Which audio tracks ride along: the request's selection, or
        // the first track by default, or none.
        let selectedTracks: [AudioTrackInfo]
        if !request.keepAudio {
            selectedTracks = []
        } else if let indices = request.audioTrackIndices {
            selectedTracks = info.audioTracks.filter { indices.contains($0.index) }
        } else {
            selectedTracks = Array(info.audioTracks.prefix(1))
        }

        // Audio allocation: each track at its own rate when known,
        // capped at 160 kbps. On a tight budget the per-track rate steps
        // down (128, 96, 64, 48), and audio is dropped entirely before
        // the video is allowed to hit the bitrate floor.
        var perTrackKbps = selectedTracks.map { min(max($0.bitrateKbps ?? 128, 32), 160) }
        func totalAudioKbps() -> Int { perTrackKbps.reduce(0, +) }
        var firstBitrate: Int
        if let target = request.targetBytes {
            firstBitrate = SizeTarget.initialVideoBitrateKbps(
                targetBytes: target, durationSeconds: clipDuration,
                audioBitrateKbps: totalAudioKbps())
            for fallback in [128, 96, 64, 48]
            where firstBitrate <= SizeTarget.minimumBitrateKbps && !perTrackKbps.isEmpty {
                perTrackKbps = perTrackKbps.map { min($0, fallback) }
                firstBitrate = SizeTarget.initialVideoBitrateKbps(
                    targetBytes: target, durationSeconds: clipDuration,
                    audioBitrateKbps: totalAudioKbps())
            }
            if firstBitrate <= SizeTarget.minimumBitrateKbps, !perTrackKbps.isEmpty {
                perTrackKbps = []
                firstBitrate = SizeTarget.initialVideoBitrateKbps(
                    targetBytes: target, durationSeconds: clipDuration, audioBitrateKbps: 0)
            }
        } else {
            let sourceVideo = (info.sourceBitrateKbps ?? 8000) - (info.audioBitrateKbps ?? 0)
            firstBitrate = min(max(sourceVideo, 500), 12000)
        }
        let audioPlan: [(trackIndex: Int, kbps: Int)] =
            zip(selectedTracks, perTrackKbps).map { (trackIndex: $0.index, kbps: $1) }

        // Audio gain: the user's gain, and when normalizing, a measured
        // peak scale on top (peak to full scale, capped at +12 dB).
        var gain = request.audioGain
        if request.normalizeAudio, let first = audioPlan.first {
            progress(ProgressEvent(
                phase: .probing, fraction: 0, statusLine: "Measuring audio peak..."))
            if let peak = try? await AudioLevels.peak(
                asset: asset, trackIndex: first.trackIndex,
                rangeStart: clipStart, rangeDuration: clipDuration),
               peak > 0.0001 {
                gain *= min(1.0 / peak, 4.0)
            }
        }

        let crop = SizeTarget.cropRect(
            sourceWidth: info.videoWidth, sourceHeight: info.videoHeight,
            aspect: request.cropAspect)
        let outputSize = SizeTarget.outputSize(
            sourceWidth: info.videoWidth, sourceHeight: info.videoHeight,
            cropAspect: request.cropAspect, maxHeight: request.maxHeight)

        // Preflight: encode a short mid-clip sample at the trial
        // bitrate and let its margin-free projection set the first
        // real bitrate. Video only; the audio share is added back
        // arithmetically, as bytes.
        if let target = request.targetBytes,
           SizeTarget.shouldPreflight(hasTarget: true, clipDuration: clipDuration) {
            progress(ProgressEvent(
                phase: .preflight, fraction: 0,
                statusLine: "Sampling the middle of the clip..."))
            let sampleSeconds = SizeTarget.preflightSampleSeconds(clipDuration: clipDuration)
            let sampleStart = SizeTarget.preflightSampleStart(
                clipStart: clipStart, clipDuration: clipDuration, sampleDuration: sampleSeconds)
            let sampleURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("vidcord-preflight-\(UUID().uuidString).mp4")
            if let sampleBytes = try? await encodeOnce(
                asset: asset, info: info, rangeStart: sampleStart, rangeDuration: sampleSeconds,
                videoKbps: firstBitrate, codec: request.codec, audioPlan: [],
                gain: 1, crop: crop, outputSize: outputSize,
                outputFPS: request.outputFPS, outputURL: sampleURL, token: token,
                progress: { _ in })
            {
                let projectedVideo = SizeTarget.projectedSize(
                    sampleBytes: sampleBytes, sampleDuration: sampleSeconds,
                    clipDuration: clipDuration)
                let audioBytes =
                    UInt64(Double(totalAudioKbps()) * 1000.0 / 8.0 * clipDuration)
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
        // in the destination directory.
        let outputDirectory = request.outputDirectory
            ?? request.sourceURL.deletingLastPathComponent()
        let outputURL = Self.reserveOutputURL(
            for: request.sourceURL, in: outputDirectory, extension: "mp4")
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
                // A second codec phase only runs when the first could
                // not land the size at all. It inherits the last bitrate.
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
                let labelBitrate = bitrate
                let labelAttempt = attemptNumber
                let bytes = try await encodeOnce(
                    asset: asset, info: info, rangeStart: clipStart,
                    rangeDuration: clipDuration, videoKbps: bitrate, codec: codec,
                    audioPlan: audioPlan, gain: gain, crop: crop, outputSize: outputSize,
                    outputFPS: request.outputFPS, outputURL: attemptURL,
                    token: token,
                    progress: { fraction in
                        progress(ProgressEvent(
                            phase: .encoding(attempt: labelAttempt), fraction: fraction,
                            statusLine:
                                "Compressing at \(labelBitrate) kbps (\(codec.displayName))..."))
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

                // Best so far: the fullest fit wins; while nothing
                // fits, the smallest oversize wins.
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

    /// First free `<stem>-vidcord.<ext>`, `<stem>-vidcord-2.<ext>`, ...
    /// in the directory, created empty so the name is held for the job.
    public static func reserveOutputURL(
        for source: URL, in directory: URL, extension ext: String
    ) -> URL {
        let stem = source.deletingPathExtension().lastPathComponent
        var candidate = directory.appendingPathComponent("\(stem)-vidcord.\(ext)")
        var suffix = 2
        while !FileManager.default.createFile(atPath: candidate.path, contents: nil),
              suffix <= 999 {
            candidate = directory.appendingPathComponent("\(stem)-vidcord-\(suffix).\(ext)")
            suffix += 1
        }
        return candidate
    }

    // MARK: - One encode

    /// A single reader-to-writer transcode of one range of the source.
    /// Returns the output's byte count. Frames stream through: the
    /// reader decodes, CoreImage crops/scales into the writer's pool
    /// buffers when the geometry changes (the source buffers pass
    /// straight through when it does not), and VideoToolbox encodes.
    private func encodeOnce(
        asset: AVURLAsset, info: SourceInfo, rangeStart: Double, rangeDuration: Double,
        videoKbps: Int, codec: CodecChoice,
        audioPlan: [(trackIndex: Int, kbps: Int)], gain: Double,
        crop: (x: Int, y: Int, width: Int, height: Int),
        outputSize: (width: Int, height: Int), outputFPS: Double?,
        outputURL: URL, token: CancellationToken,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> UInt64 {
        let allTracks = try await asset.loadTracks(withMediaType: .video)
        guard let videoTrack = allTracks.first else { throw CompressError.noVideoTrack }
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

        // One reader output per selected audio track.
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        var audioPairs: [(output: AVAssetReaderTrackOutput, kbps: Int,
                          sampleRate: Double, channels: Int)] = []
        for plan in audioPlan {
            guard audioTracks.indices.contains(plan.trackIndex) else { continue }
            let track = audioTracks[plan.trackIndex]
            var sampleRate = 48000.0
            var channels = 2
            if let description = try await track.load(.formatDescriptions).first,
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description) {
                sampleRate = asbd.pointee.mSampleRate
                channels = Int(asbd.pointee.mChannelsPerFrame)
            }
            let output = AVAssetReaderTrackOutput(
                track: track,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false,
                    AVLinearPCMIsNonInterleaved: false,
                ])
            output.alwaysCopiesSampleData = gain != 1.0
            if reader.canAdd(output) {
                reader.add(output)
                audioPairs.append((output, plan.kbps, sampleRate, channels))
            }
        }

        try? FileManager.default.removeItem(at: outputURL)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true

        // Rate control mirrors the Rust VBV pairing: an average rate at
        // the planned bitrate, with VideoToolbox's data-rate limit set
        // to twice that (bits per second, averaged over a one-second
        // window) standing in for -maxrate/-bufsize 2x.
        var compressionProperties: [String: Any] = [
            AVVideoAverageBitRateKey: videoKbps * 1000,
            kVTCompressionPropertyKey_DataRateLimits as String: [
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
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            ])
        guard writer.canAdd(videoInput) else {
            throw CompressError.writerFailed("could not add the video input")
        }
        writer.add(videoInput)

        var audioInputs: [AVAssetWriterInput] = []
        for pair in audioPairs {
            let input = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: pair.sampleRate,
                    AVNumberOfChannelsKey: max(1, pair.channels),
                    AVEncoderBitRateKey: pair.kbps * 1000,
                ])
            input.expectsMediaDataInRealTime = false
            if writer.canAdd(input) {
                writer.add(input)
                audioInputs.append(input)
            }
        }
        // A pair whose input was refused is not pumped; drop it so the
        // finish condition only waits on inputs that exist.
        if audioInputs.count != audioPairs.count {
            audioPairs = Array(audioPairs.prefix(audioInputs.count))
        }

        let needsGeometryPass =
            crop.width != info.videoWidth || crop.height != info.videoHeight
            || crop.x != 0 || crop.y != 0
            || outputSize.width != crop.width || outputSize.height != crop.height
        let ciContext = needsGeometryPass ? CIContext() : nil

        return try await withCheckedThrowingContinuation { continuation in
            let pump = PumpState(audioCount: audioInputs.count)
            guard reader.startReading() else {
                continuation.resume(
                    throwing: CompressError.readerFailed(
                        reader.error?.localizedDescription ?? "unknown error"))
                return
            }
            writer.startWriting()
            writer.startSession(atSourceTime: .zero)
            let offset = CMTimeSubtract(.zero, start)
            let frameGate = FrameGate(
                outputFPS: outputFPS, sourceFPS: info.frameRate)

            func finishIfReady() {
                pump.lock.lock()
                let ready = pump.videoFinished && pump.audioFinished >= pump.audioCount
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
                    let rawPTS = CMSampleBufferGetPresentationTimeStamp(sample)
                    if !frameGate.shouldWrite(sourcePTS: rawPTS) { continue }
                    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
                    let pts = CMTimeAdd(rawPTS, offset)
                    let appended: Bool
                    if let ciContext, let pool = adaptor.pixelBufferPool {
                        appended = Self.renderFrame(
                            buffer, context: ciContext, pool: pool,
                            crop: crop, sourceHeight: info.videoHeight,
                            outputSize: outputSize, adaptor: adaptor, pts: pts)
                    } else {
                        appended = adaptor.append(buffer, withPresentationTime: pts)
                    }
                    if !appended, writer.status == .failed {
                        reader.cancelReading()
                        videoInput.markAsFinished()
                        pump.lock.lock(); pump.videoFinished = true; pump.lock.unlock()
                        finishIfReady()
                        return
                    }
                    let seconds = CMTimeGetSeconds(pts)
                    if seconds.isFinite, rangeDuration > 0 {
                        progress(min(max(seconds / rangeDuration, 0), 1))
                    }
                }
            }

            for (pairIndex, pair) in audioPairs.enumerated() {
                let input = audioInputs[pairIndex]
                let output = pair.output
                input.requestMediaDataWhenReady(
                    on: DispatchQueue(label: "vidcord.swift.audio.\(pairIndex)"))
                {
                    while input.isReadyForMoreMediaData {
                        if token.isCancelled {
                            reader.cancelReading()
                            input.markAsFinished()
                            pump.lock.lock(); pump.audioFinished += 1; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                        guard let sample = output.copyNextSampleBuffer() else {
                            input.markAsFinished()
                            pump.lock.lock(); pump.audioFinished += 1; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                        if gain != 1.0 { Self.applyGain(to: sample, gain: gain) }
                        let shifted = Self.shiftedSample(sample, by: offset) ?? sample
                        if !input.append(shifted), writer.status == .failed {
                            reader.cancelReading()
                            input.markAsFinished()
                            pump.lock.lock(); pump.audioFinished += 1; pump.lock.unlock()
                            finishIfReady()
                            return
                        }
                    }
                }
            }
        }
    }

    /// Crop and scale one frame into a writer pool buffer and append
    /// it. CoreImage coordinates are bottom-up, so the crop's y is
    /// flipped against the source height.
    private static func renderFrame(
        _ source: CVPixelBuffer, context: CIContext, pool: CVPixelBufferPool,
        crop: (x: Int, y: Int, width: Int, height: Int), sourceHeight: Int,
        outputSize: (width: Int, height: Int),
        adaptor: AVAssetWriterInputPixelBufferAdaptor, pts: CMTime
    ) -> Bool {
        var pooled: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pooled) == kCVReturnSuccess,
              let target = pooled else { return false }
        var image = CIImage(cvPixelBuffer: source)
        let cropRect = CGRect(
            x: crop.x, y: sourceHeight - crop.y - crop.height,
            width: crop.width, height: crop.height)
        image = image.cropped(to: cropRect)
        let scaleX = Double(outputSize.width) / Double(crop.width)
        let scaleY = Double(outputSize.height) / Double(crop.height)
        image = image.transformed(
            by: CGAffineTransform(translationX: -cropRect.origin.x, y: -cropRect.origin.y)
                .concatenating(CGAffineTransform(scaleX: scaleX, y: scaleY)))
        context.render(image, to: target)
        return adaptor.append(target, withPresentationTime: pts)
    }

    /// Scale 16-bit interleaved PCM samples in place, clamped to full
    /// scale. Non-contiguous buffers are passed through untouched.
    private static func applyGain(to sample: CMSampleBuffer, gain: Double) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block, atOffset: 0, lengthAtOffsetOut: &length,
            totalLengthOut: nil, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let pointer, length >= 2 else { return }
        let count = length / 2
        pointer.withMemoryRebound(to: Int16.self, capacity: count) { samples in
            for index in 0..<count {
                let scaled = Double(samples[index]) * gain
                samples[index] = Int16(max(-32768.0, min(32767.0, scaled)))
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

/// Frame thinning for an output fps cap: a frame is written only when
/// its timestamp crosses the next slot boundary, so the delivered rate
/// hugs the cap without resampling timestamps.
private final class FrameGate: @unchecked Sendable {
    private let interval: Double
    private var nextSlot = -Double.infinity

    init(outputFPS: Double?, sourceFPS: Double) {
        if let outputFPS, outputFPS > 0, sourceFPS <= 0 || outputFPS < sourceFPS {
            interval = 1.0 / outputFPS
        } else {
            interval = 0
        }
    }

    func shouldWrite(sourcePTS: CMTime) -> Bool {
        if interval == 0 { return true }
        let seconds = CMTimeGetSeconds(sourcePTS)
        guard seconds.isFinite else { return true }
        if seconds + 0.0001 >= nextSlot {
            nextSlot = max(nextSlot + interval, seconds + interval)
            return true
        }
        return false
    }
}

/// Mutable state shared by one encode's pump closures.
private final class PumpState: @unchecked Sendable {
    let lock = NSLock()
    let audioCount: Int
    var videoFinished = false
    var audioFinished = 0
    var completed = false

    init(audioCount: Int) { self.audioCount = audioCount }
}

/// Peak measurement for normalize: decode the range's audio once and
/// remember the loudest sample, as a 0...1 fraction of full scale.
public enum AudioLevels {
    public static func peak(
        asset: AVURLAsset, trackIndex: Int, rangeStart: Double, rangeDuration: Double
    ) async throws -> Double? {
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard tracks.indices.contains(trackIndex) else { return nil }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: rangeStart, preferredTimescale: 600),
            duration: CMTime(seconds: rangeDuration, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(
            track: tracks[trackIndex],
            outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }
        var peak: Int32 = 0
        while let sample = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(
                block, atOffset: 0, lengthAtOffsetOut: &length,
                totalLengthOut: nil, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
                  let pointer else { continue }
            let count = length / 2
            pointer.withMemoryRebound(to: Int16.self, capacity: count) { samples in
                for index in 0..<count {
                    let value = abs(Int32(samples[index]))
                    if value > peak { peak = value }
                }
            }
        }
        return Double(peak) / 32768.0
    }
}
