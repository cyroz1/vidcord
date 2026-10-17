import Foundation

/// The size-target policy, ported from the 7.7 Rust backend
/// (`src-tauri/src/commands/compression.rs`). Pure values and functions:
/// no I/O and no AVFoundation, so the whole policy is testable on its own.
/// That split is deliberate, the same one Sill uses: the engine shell does
/// the encoding, this file decides the numbers.
public enum SizeTarget {
    /// The one safety factor for size-target bitrate decisions, owned here
    /// in the engine. Every adaptive adjustment (the preflight estimate
    /// and the post-encode retries, up or down) scales the measured size
    /// ratio by this factor, so the next encode aims at 95% of the
    /// target: as full as possible without overshooting. Callers send the
    /// unshrunk budget and the preflight projection carries no margin of
    /// its own, so this is the only margin in the size pipeline.
    public static let safety = 0.95

    /// Fill level at which a size-target attempt is accepted as the best
    /// fit instead of paying for a refinement encode. Benchmarking the
    /// Rust pipeline showed first attempts land at 87-88% of the target,
    /// so the accept line sits at 85%: genuine misses still refine, the
    /// usual best fit does not pay for a second encode.
    public static let underfillRetryThreshold = 0.85

    /// Bounded size-correction retries per codec phase.
    public static let retryLimitPerCodec = 2

    /// No encode is ever planned below this video bitrate.
    public static let minimumBitrateKbps = 100

    /// A preflight sample only runs on clips at least this long.
    public static let preflightMinDurationSeconds = 8.0

    /// Longest preflight sample.
    public static let preflightMaxSampleSeconds = 4.0

    /// A preflight sample only pays for itself when it is a small slice
    /// of the clip; at or below this share of the duration it replaces
    /// full re-encodes.
    public static let preflightMaxSampleShare = 0.15

    // MARK: - Adaptive bitrates (ported 1:1 from the Rust)

    /// Next bitrate after an oversize encode:
    /// `floor(current * target/output * safety)`, floored at the minimum.
    public static func adaptiveBitrateForOversize(
        currentKbps: Int, targetBytes: UInt64, outputBytes: UInt64
    ) -> Int {
        if outputBytes == 0 { return max(currentKbps, minimumBitrateKbps) }
        let ratio = Double(targetBytes) / Double(outputBytes)
        let next = (Double(currentKbps) * ratio * safety).rounded(.down)
        return max(Int(next), minimumBitrateKbps)
    }

    /// Next bitrate after an underfilled encode. The measured ratio is
    /// scaled by the same single safety factor, then capped by a 1.5x
    /// per-pass step limit and by the source's own bitrate, and never
    /// steps down.
    public static func adaptiveBitrateForUnderfill(
        currentKbps: Int, targetBytes: UInt64, outputBytes: UInt64,
        sourceBitrateKbps: Int?
    ) -> Int {
        if outputBytes == 0 || targetBytes == 0 {
            return max(currentKbps, minimumBitrateKbps)
        }
        let ratio = Double(targetBytes) / Double(outputBytes)
        let estimated = Int((Double(currentKbps) * ratio * safety).rounded(.down))
        let stepLimit = currentKbps * 3 / 2
        let sourceLimit = sourceBitrateKbps ?? Int.max
        return max(min(estimated, min(stepLimit, sourceLimit)), currentKbps)
    }

    /// The next oversize retry bitrate, or nil when the retry budget for
    /// this codec is spent or the step would not actually go down.
    public static func nextOversizeBitrate(
        currentKbps: Int, targetBytes: UInt64, outputBytes: UInt64,
        retriesUsed: Int
    ) -> Int? {
        let next = adaptiveBitrateForOversize(
            currentKbps: currentKbps, targetBytes: targetBytes, outputBytes: outputBytes)
        guard retriesUsed < retryLimitPerCodec, next < currentKbps else { return nil }
        return next
    }

    /// The next underfill retry bitrate, or nil when the attempt already
    /// fills enough of the target, the retry budget is spent, or the step
    /// would not actually go up.
    public static func nextUnderfillBitrate(
        currentKbps: Int, targetBytes: UInt64, outputBytes: UInt64,
        retriesUsed: Int, sourceBitrateKbps: Int?
    ) -> Int? {
        guard retriesUsed < retryLimitPerCodec, outputBytes != 0,
              Double(outputBytes) < Double(targetBytes) * underfillRetryThreshold
        else { return nil }
        let next = adaptiveBitrateForUnderfill(
            currentKbps: currentKbps, targetBytes: targetBytes,
            outputBytes: outputBytes, sourceBitrateKbps: sourceBitrateKbps)
        return next > currentKbps ? next : nil
    }

    /// Fill of the target an output reached, 1.0 meaning exactly on it.
    public static func fill(targetBytes: UInt64, outputBytes: UInt64) -> Double {
        guard targetBytes > 0 else { return 0 }
        return Double(outputBytes) / Double(targetBytes)
    }

    // MARK: - Budget

    /// Initial video bitrate from the unshrunk budget: total bits the
    /// target allows per second, minus the audio allocation. Margin-free
    /// on purpose. `safety` enters through the preflight decision and the
    /// retries, exactly as in the Rust pipeline.
    public static func initialVideoBitrateKbps(
        targetBytes: UInt64, durationSeconds: Double, audioBitrateKbps: Int
    ) -> Int {
        guard durationSeconds > 0, durationSeconds.isFinite else { return minimumBitrateKbps }
        let totalKbps = Double(targetBytes) * 8.0 / durationSeconds / 1000.0
        let video = (totalKbps - Double(audioBitrateKbps)).rounded(.down)
        return max(Int(video), minimumBitrateKbps)
    }

    // MARK: - Preflight sampling (ported 1:1 from the Rust)

    /// Sample length for a size preflight: an eighth of the clip, clamped
    /// to 1-4 s, so short clips get a proportionally short sample instead
    /// of skipping the preflight entirely.
    public static func preflightSampleSeconds(clipDuration: Double) -> Double {
        guard clipDuration.isFinite, clipDuration > 0 else { return 0 }
        return min(max(clipDuration * 0.125, 1.0), preflightMaxSampleSeconds)
    }

    /// Start of a preflight sample: the middle of the clip, where the
    /// content is closest to the full-clip average. A head-of-file sample
    /// over-projects whenever the opening seconds encode hotter than the
    /// clip as a whole.
    public static func preflightSampleStart(
        clipStart: Double, clipDuration: Double, sampleDuration: Double
    ) -> Double {
        clipStart + max((clipDuration - sampleDuration) * 0.5, 0)
    }

    /// Whether a standard (non-GIF) size-target job should preflight.
    public static func shouldPreflight(hasTarget: Bool, clipDuration: Double) -> Bool {
        hasTarget
            && clipDuration >= preflightMinDurationSeconds
            && preflightSampleSeconds(clipDuration: clipDuration)
                <= clipDuration * preflightMaxSampleShare
    }

    /// Project a preflight sample's size to the full clip. Deliberately
    /// margin-free: `safety` is applied once, when the projection is
    /// turned into a bitrate decision.
    public static func projectedSize(
        sampleBytes: UInt64, sampleDuration: Double, clipDuration: Double
    ) -> UInt64 {
        guard sampleDuration > 0, sampleDuration.isFinite, clipDuration.isFinite else {
            return sampleBytes
        }
        let projected = (Double(sampleBytes) * clipDuration / sampleDuration).rounded(.up)
        return UInt64(min(projected, Double(UInt64.max)))
    }

    /// Turn a margin-free projection into the first encode's bitrate
    /// when the projection says the trial bitrate would overshoot: the
    /// one place `safety` is applied before a full encode runs.
    public static func bitrateForOversizeProjection(
        currentKbps: Int, targetBytes: UInt64, projectedBytes: UInt64
    ) -> Int {
        adaptiveBitrateForOversize(
            currentKbps: currentKbps, targetBytes: targetBytes, outputBytes: projectedBytes)
    }

    /// Turn a margin-free projection into the first encode's bitrate when
    /// the projection says the trial bitrate would leave the target
    /// mostly empty: same step caps as a post-encode underfill retry.
    public static func bitrateForUnderfillProjection(
        currentKbps: Int, targetBytes: UInt64, projectedBytes: UInt64,
        sourceBitrateKbps: Int?
    ) -> Int {
        adaptiveBitrateForUnderfill(
            currentKbps: currentKbps, targetBytes: targetBytes,
            outputBytes: projectedBytes, sourceBitrateKbps: sourceBitrateKbps)
    }

    // MARK: - Geometry

    /// Aspect-fit a source into a maximum height, with encoder-friendly
    /// even dimensions. Returns the source size unchanged when no cap
    /// applies or the source is already under it.
    public static func scaledSize(
        sourceWidth: Int, sourceHeight: Int, maxHeight: Int
    ) -> (width: Int, height: Int) {
        guard maxHeight > 0, sourceWidth > 0, sourceHeight > maxHeight else {
            return (sourceWidth, sourceHeight)
        }
        let scale = Double(maxHeight) / Double(sourceHeight)
        let width = Int((Double(sourceWidth) * scale).rounded())
        let evenWidth = width - width % 2
        let evenHeight = maxHeight - maxHeight % 2
        return (max(evenWidth, 2), max(evenHeight, 2))
    }
}
