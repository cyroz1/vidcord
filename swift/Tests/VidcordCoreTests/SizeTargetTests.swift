import XCTest

@testable import VidcordCore

/// The pure policy checks. Expected values are worked from the same
/// formulas as the 7.7 Rust backend's compression tests, so the port
/// can be held to the original's numbers. Run with `swift test`.
final class SizeTargetTests: XCTestCase {
    private let target: UInt64 = 25_000_000

    // MARK: Oversize adaptation

    func testOversizeScalesByMeasuredRatioAndSafety() {
        // 8000 kbps produced 30 MB against a 25 MB target:
        // floor(8000 * 25/30 * 0.95) = 6333.
        XCTAssertEqual(
            SizeTarget.adaptiveBitrateForOversize(
                currentKbps: 8000, targetBytes: target, outputBytes: 30_000_000),
            6333)
    }

    func testOversizeNeverPlansBelowTheFloor() {
        XCTAssertEqual(
            SizeTarget.adaptiveBitrateForOversize(
                currentKbps: 400, targetBytes: target, outputBytes: 250_000_000),
            SizeTarget.minimumBitrateKbps)
    }

    func testOversizeRetryStopsAtTheFloor() {
        // Already at the floor: the computed step cannot go lower, so
        // there is no further retry.
        XCTAssertNil(
            SizeTarget.nextOversizeBitrate(
                currentKbps: SizeTarget.minimumBitrateKbps,
                targetBytes: target, outputBytes: 30_000_000, retriesUsed: 0))
    }

    func testOversizeRetryRespectsThePerCodecLimit() {
        XCTAssertNil(
            SizeTarget.nextOversizeBitrate(
                currentKbps: 8000, targetBytes: target, outputBytes: 30_000_000,
                retriesUsed: SizeTarget.retryLimitPerCodec))
    }

    // MARK: Underfill adaptation

    func testUnderfillStepsUpCappedAtOneAndAHalfTimes() {
        // 4000 kbps produced half the target: the raw step would be
        // 4000 * 2 * 0.95 = 7600, the per-pass cap holds it to 6000.
        XCTAssertEqual(
            SizeTarget.adaptiveBitrateForUnderfill(
                currentKbps: 4000, targetBytes: target, outputBytes: 12_500_000,
                sourceBitrateKbps: nil),
            6000)
    }

    func testUnderfillNeverExceedsTheSourceBitrate() {
        XCTAssertEqual(
            SizeTarget.adaptiveBitrateForUnderfill(
                currentKbps: 4000, targetBytes: target, outputBytes: 12_500_000,
                sourceBitrateKbps: 5000),
            5000)
    }

    func testUnderfillAcceptsAboveTheThresholdLine() {
        // At 86% fill the attempt is accepted, no refinement encode.
        XCTAssertNil(
            SizeTarget.nextUnderfillBitrate(
                currentKbps: 4000, targetBytes: target,
                outputBytes: 21_500_000, retriesUsed: 0,
                sourceBitrateKbps: nil))
    }

    func testUnderfillRetriesBelowTheThresholdLine() {
        XCTAssertEqual(
            SizeTarget.nextUnderfillBitrate(
                currentKbps: 4000, targetBytes: target, outputBytes: 12_500_000,
                retriesUsed: 0, sourceBitrateKbps: nil),
            6000)
    }

    // MARK: Budget

    func testInitialBitrateComesOutOfTheUnshrunkBudget() {
        // 25 MB over 60 s is 3333 kbps total; minus 128 kbps of audio.
        XCTAssertEqual(
            SizeTarget.initialVideoBitrateKbps(
                targetBytes: target, durationSeconds: 60, audioBitrateKbps: 128),
            3205)
    }

    // MARK: Preflight

    func testPreflightSampleIsAnEighthClampedToOneToFourSeconds() {
        XCTAssertEqual(SizeTarget.preflightSampleSeconds(clipDuration: 30), 3.75)
        XCTAssertEqual(SizeTarget.preflightSampleSeconds(clipDuration: 100), 4.0)
        XCTAssertEqual(SizeTarget.preflightSampleSeconds(clipDuration: 4), 1.0)
    }

    func testPreflightSamplesTheMiddleOfTheClip() {
        XCTAssertEqual(
            SizeTarget.preflightSampleStart(
                clipStart: 10, clipDuration: 30, sampleDuration: 4),
            23)
    }

    func testPreflightGating() {
        XCTAssertTrue(SizeTarget.shouldPreflight(hasTarget: true, clipDuration: 30))
        XCTAssertFalse(SizeTarget.shouldPreflight(hasTarget: true, clipDuration: 7))
        XCTAssertFalse(SizeTarget.shouldPreflight(hasTarget: false, clipDuration: 30))
    }

    func testProjectionIsMarginFreeAndLinear() {
        XCTAssertEqual(
            SizeTarget.projectedSize(
                sampleBytes: 1_000_000, sampleDuration: 2, clipDuration: 30),
            15_000_000)
    }

    // MARK: Geometry

    func testScaleToMaxHeightKeepsAspectAndEvenDimensions() {
        let scaled = SizeTarget.scaledSize(
            sourceWidth: 1920, sourceHeight: 1080, maxHeight: 720)
        XCTAssertEqual(scaled.width, 1280)
        XCTAssertEqual(scaled.height, 720)
    }

    func testNoScalingWhenUncappedOrAlreadySmall() {
        let uncapped = SizeTarget.scaledSize(
            sourceWidth: 1920, sourceHeight: 1080, maxHeight: 0)
        XCTAssertEqual(uncapped.width, 1920)
        let small = SizeTarget.scaledSize(
            sourceWidth: 640, sourceHeight: 360, maxHeight: 720)
        XCTAssertEqual(small.height, 360)
    }

    func testFill() {
        XCTAssertEqual(
            SizeTarget.fill(targetBytes: target, outputBytes: 21_250_000), 0.85,
            accuracy: 1e-9)
    }

    // MARK: Crop and output geometry

    func testCropToSquareCentersTheFrame() {
        let rect = SizeTarget.cropRect(
            sourceWidth: 1920, sourceHeight: 1080, aspect: .square)
        XCTAssertEqual(rect.width, 1080)
        XCTAssertEqual(rect.height, 1080)
        XCTAssertEqual(rect.x, 420)
        XCTAssertEqual(rect.y, 0)
    }

    func testCropToVerticalFromLandscape() {
        let rect = SizeTarget.cropRect(
            sourceWidth: 1920, sourceHeight: 1080, aspect: .vertical)
        XCTAssertEqual(rect.height, 1080)
        XCTAssertEqual(rect.width, 608) // 1080 * 9/16 = 607.5, evened
        XCTAssertEqual(rect.x, (1920 - 608) / 2)
    }

    func testOutputSizeCropsThenScales() {
        let size = SizeTarget.outputSize(
            sourceWidth: 1920, sourceHeight: 1080, cropAspect: .square,
            maxHeight: 720)
        XCTAssertEqual(size.width, 720)
        XCTAssertEqual(size.height, 720)
    }

    func testOriginalAspectMeansNoCrop() {
        let rect = SizeTarget.cropRect(
            sourceWidth: 1280, sourceHeight: 720, aspect: .original)
        XCTAssertEqual(rect.width, 1280)
        XCTAssertEqual(rect.height, 720)
    }

    // MARK: Settings

    func testSettingsDecodeFillsDefaultsForMissingFields() throws {
        let data = Data(#"{"targetMB": 50}"#.utf8)
        let decoded = try JSONDecoder().decode(AppSettings.self, from: data)
        XCTAssertEqual(decoded.targetMB, 50)
        XCTAssertEqual(decoded.codec, .hevc)
        XCTAssertEqual(decoded.outputDestination, .downloads)
        XCTAssertEqual(decoded.completionAction, .copy)
    }

    func testPresetCaptureStripsMachineFields() {
        var settings = AppSettings()
        settings.targetMB = 42
        settings.outputDestination = .custom
        settings.customOutputDirectory = "/tmp/somewhere"
        settings.completionAction = .reveal
        settings.closeAppAfterExport = true
        let captured = SettingsPreset.captured(settings)
        XCTAssertEqual(captured.targetMB, 42)
        XCTAssertEqual(captured.outputDestination, .downloads)
        XCTAssertEqual(captured.customOutputDirectory, "")
        XCTAssertEqual(captured.completionAction, .copy)
        XCTAssertFalse(captured.closeAppAfterExport)
    }
}
