import AVFoundation
import AppKit
import Foundation
import Observation
import UserNotifications
import VidcordCore
import VidcordEngine

enum ItemStatus: Equatable {
    case waiting
    case running
    case done(URL)
    case failed(String)
    case cancelled
}

/// One queued file and everything the editor knows about it.
@Observable
final class QueueItem: Identifiable {
    let id = UUID()
    let url: URL
    var info: SourceInfo?
    var status: ItemStatus = .waiting
    var trimStart: Double = 0
    /// Seconds; 0 means "to the end of the file".
    var trimEnd: Double = 0
    var keyframes: [Double] = []
    var thumbnails: [NSImage] = []

    init(url: URL) { self.url = url }

    var duration: Double { info?.durationSeconds ?? 0 }
    var effectiveEnd: Double { trimEnd > 0 ? trimEnd : duration }
    var rangeDuration: Double { max(effectiveEnd - trimStart, 0) }
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var body: String
}

/// The app's working model: the queue, the selection's player, the
/// run, and everything after a run (destinations, the ask-when-done
/// save panel, completion actions, notifications, toasts). Mirrors
/// the desktop app's ownership: one backend job at a time, batch
/// failures isolated per file, cancellation owned by the running job.
@Observable
final class AppModel {
    let store = SettingsStore()
    var items: [QueueItem] = []
    var selectedID: UUID?
    var player: AVPlayer?
    var playerRate: Float = 0
    var currentTime: Double = 0

    var running = false
    var progressFraction: Double = 0
    var statusLine = "Drop videos here, or choose some."
    var lastResult: CompressResult?
    var lastResultItemID: UUID?
    var toasts: [Toast] = []

    /// Audio track selection for the selected item (probe indices).
    var selectedAudioTracks: Set<Int> = [0]
    var snapToKeyframes = true

    private var token: CancellationToken?
    private var queueTask: Task<Void, Never>?
    private var timeObserver: Any?

    var selectedItem: QueueItem? { items.first(where: { $0.id == selectedID }) }

    private static let videoExtensions: Set<String> = [
        "mp4", "mov", "m4v", "mpg", "mpeg", "ts", "mts", "m2ts", "avi", "mkv",
    ]

    // MARK: - Import

    /// Files land directly; folders are scanned recursively (hidden
    /// files skipped, the scan capped, and anything AVFoundation
    /// cannot probe falls out at the probe step with a failure note
    /// on its row, never silently).
    func add(urls: [URL]) {
        var files: [URL] = []
        var scanned = 0
        for url in urls {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
            else { continue }
            if !isDirectory.boolValue {
                files.append(url)
                continue
            }
            guard let enumerator = FileManager.default.enumerator(
                at: url, includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]) else { continue }
            for case let entry as URL in enumerator {
                scanned += 1
                if scanned > 10_000 { break }
                if Self.videoExtensions.contains(entry.pathExtension.lowercased()) {
                    files.append(entry)
                }
            }
        }
        for file in files where !items.contains(where: { $0.url == file }) {
            let item = QueueItem(url: file)
            items.append(item)
            if selectedID == nil { select(item) }
            probe(item)
        }
        if !files.isEmpty {
            toast("Added", "\(files.count) file\(files.count == 1 ? "" : "s") in the queue.")
        }
    }

    func remove(_ item: QueueItem) {
        if selectedID == item.id {
            player?.pause()
            player = nil
            selectedID = nil
        }
        items.removeAll { $0.id == item.id }
        if selectedID == nil, let first = items.first { select(first) }
    }

    func select(_ item: QueueItem) {
        selectedID = item.id
        selectedAudioTracks = [0]
        let avPlayer = AVPlayer(url: item.url)
        player = avPlayer
        currentTime = item.trimStart
        if let observer = timeObserver { /* replaced below */ _ = observer }
        timeObserver = avPlayer.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.1, preferredTimescale: 600),
            queue: .main
        ) { [weak self, weak avPlayer] time in
            guard let self, let avPlayer else { return }
            self.currentTime = CMTimeGetSeconds(time)
            self.playerRate = avPlayer.rate
            if let item = self.selectedItem,
               CMTimeGetSeconds(time) >= item.effectiveEnd, item.effectiveEnd > 0 {
                avPlayer.pause()
            }
        }
        Task { await loadKeyframes(for: item) }
        Task { await loadThumbnails(for: item) }
    }

    private func probe(_ item: QueueItem) {
        Task {
            do {
                let info = try await VideoProbe.probe(url: item.url)
                item.info = info
                if item.trimEnd == 0 { item.trimEnd = info.durationSeconds }
                if selectedID == item.id {
                    await loadKeyframes(for: item)
                    await loadThumbnails(for: item)
                }
            } catch {
                item.status = .failed("could not probe: \(error)")
            }
        }
    }

    private func loadKeyframes(for item: QueueItem) async {
        guard let info = item.info else { return }
        let asset = AVURLAsset(url: item.url)
        let frames = (try? await LosslessTrim.keyframes(
            asset: asset, rangeStart: 0, rangeDuration: info.durationSeconds)) ?? []
        if selectedID == item.id { item.keyframes = frames }
    }

    private func loadThumbnails(for item: QueueItem) async {
        guard let info = item.info else { return }
        let asset = AVURLAsset(url: item.url)
        // The filmstrip always spans the whole file: the trim
        // timeline zooms and pans over it.
        let images = await Snapshots.thumbnails(
            asset: asset, rangeStart: 0,
            rangeDuration: info.durationSeconds, count: 12)
        if selectedID == item.id {
            item.thumbnails = images.map { NSImage(cgImage: $0, size: .zero) }
        }
    }

    func refreshThumbnails() {
        guard let item = selectedItem else { return }
        Task { await loadThumbnails(for: item) }
    }

    // MARK: - The run

    func startQueue() {
        guard !running else { return }
        let pending = items.filter { $0.status == .waiting }
        guard !pending.isEmpty else {
            toast("Nothing to do", "Every queued file is already processed.")
            return
        }
        let token = CancellationToken()
        self.token = token
        running = true
        queueTask = Task { [weak self] in
            guard let self else { return }
            var anySuccess = false
            for item in pending {
                if token.isCancelled {
                    item.status = .cancelled
                    continue
                }
                let ok = await self.runItem(item, token: token)
                anySuccess = anySuccess || ok
            }
            self.running = false
            self.progressFraction = 0
            if anySuccess, self.store.settings.closeAppAfterExport {
                self.store.flush()
                NSApp.terminate(nil)
            }
        }
    }

    func cancelRun() {
        token?.cancel()
    }

    private func runItem(_ item: QueueItem, token: CancellationToken) async -> Bool {
        guard let info = item.info else {
            item.status = .failed("not probed yet")
            return false
        }
        item.status = .running
        select(item)
        let settings = store.settings
        let destination = resolveDestination(settings: settings)
        let start = item.trimStart
        let duration = max(item.rangeDuration, 0.1)
        statusLine = "Working on \(item.url.lastPathComponent)..."
        progressFraction = 0

        let progress: @Sendable (ProgressEvent) -> Void = { [weak self] event in
            Task { @MainActor [weak self] in
                self?.progressFraction = event.fraction
                self?.statusLine = event.statusLine
            }
        }

        do {
            let result: CompressResult
            switch settings.mode {
            case .compress:
                let request = CompressRequest(
                    sourceURL: item.url,
                    targetBytes: settings.useTarget
                        ? UInt64(settings.targetMB * 1_000_000) : nil,
                    codec: settings.codec,
                    keepAudio: !settings.removeAudio,
                    maxHeight: settings.maxHeight,
                    audioTrackIndices: settings.removeAudio
                        ? [] : Array(selectedAudioTracks).sorted(),
                    normalizeAudio: settings.normalizeAudio,
                    outputFPS: settings.fpsCap > 0 ? settings.fpsCap : nil,
                    cropAspect: settings.cropAspect,
                    rangeStartSeconds: start,
                    rangeDurationSeconds: duration,
                    outputDirectory: destination.directory)
                result = try await Compressor().compress(
                    request: request, token: token, progress: progress)
            case .gif:
                let request = GifRequest(
                    sourceURL: item.url, format: settings.gifFormat,
                    targetBytes: settings.gifUseTarget
                        ? UInt64(settings.gifTargetMB * 1_000_000) : nil,
                    fps: settings.gifFPS, maxWidth: 720,
                    rangeStartSeconds: start, rangeDurationSeconds: duration)
                result = try await GifExporter().export(
                    request: request, outputDirectory: destination.directory,
                    token: token, progress: progress)
            case .losslessTrim:
                result = try await runLossless(
                    item: item, info: info, settings: settings,
                    destination: destination, token: token, progress: progress)
            }

            var delivered = result
            if destination.isStaging {
                guard let chosen = await askWhereToSave(suggested: result.outputURL) else {
                    try? FileManager.default.removeItem(at: result.outputURL)
                    item.status = .cancelled
                    toast("Discarded", "The save panel was cancelled; the staged file is gone.")
                    return false
                }
                delivered = CompressResult(
                    outputURL: chosen, outputBytes: result.outputBytes,
                    fill: result.fill, overTarget: result.overTarget,
                    attempts: result.attempts, elapsedSeconds: result.elapsedSeconds)
            }

            item.status = .done(delivered.outputURL)
            lastResult = delivered
            lastResultItemID = item.id
            statusLine = "Done: \(delivered.outputURL.lastPathComponent)"
            await complete(delivered, settings: settings)
            return true
        } catch {
            if token.isCancelled {
                item.status = .cancelled
                statusLine = "Cancelled."
            } else {
                item.status = .failed(String(describing: error))
                toast("Failed", "\(item.url.lastPathComponent): \(error)")
            }
            return false
        }
    }

    /// Lossless mode: snap the range outward to keyframes, stream
    /// copy, and fall back to a normal targeted compression when the
    /// container refuses the copy, the desktop app's own flow.
    private func runLossless(
        item: QueueItem, info: SourceInfo, settings: AppSettings,
        destination: (directory: URL?, isStaging: Bool),
        token: CancellationToken,
        progress: @escaping @Sendable (ProgressEvent) -> Void
    ) async throws -> CompressResult {
        let started = Date()
        var start = item.trimStart
        var end = item.effectiveEnd
        if snapToKeyframes, !item.keyframes.isEmpty {
            let snapped = LosslessTrim.snappedRange(
                start: start, end: end, keyframes: item.keyframes,
                sourceDuration: info.durationSeconds)
            start = snapped.start
            end = snapped.end
        }
        let directory = destination.directory ?? item.url.deletingLastPathComponent()
        let ext = item.url.pathExtension.lowercased() == "mov" ? "mov" : "mp4"
        let outputURL = Compressor.reserveOutputURL(for: item.url, in: directory, extension: ext)
        let asset = AVURLAsset(url: item.url)
        do {
            try await LosslessTrim.export(
                asset: asset, rangeStart: start, rangeDuration: end - start,
                outputURL: outputURL, token: token,
                progress: { fraction in
                    progress(ProgressEvent(
                        phase: .encoding(attempt: 1), fraction: fraction,
                        statusLine: "Copying without re-encoding..."))
                })
            let bytes = (try? FileManager.default.attributesOfItem(
                atPath: outputURL.path)[.size] as? NSNumber)?.uint64Value ?? 0
            return CompressResult(
                outputURL: outputURL, outputBytes: bytes, fill: nil, overTarget: false,
                attempts: [AttemptRecord(
                    codec: settings.codec, videoBitrateKbps: 0, outputBytes: bytes,
                    note: "stream copy, keyframe snapped")],
                elapsedSeconds: Date().timeIntervalSince(started))
        } catch TrimError.incompatible {
            // The desktop app's fallback: compress the same range,
            // with its own target when one is set.
            try? FileManager.default.removeItem(at: outputURL)
            let request = CompressRequest(
                sourceURL: item.url,
                targetBytes: settings.useTarget ? UInt64(settings.targetMB * 1_000_000) : nil,
                codec: settings.codec, keepAudio: !settings.removeAudio,
                maxHeight: settings.maxHeight,
                rangeStartSeconds: start, rangeDurationSeconds: end - start,
                outputDirectory: directory)
            return try await Compressor().compress(
                request: request, token: token, progress: progress)
        }
    }

    // MARK: - Destinations and completion

    /// (directory, staged?) for the current destination setting. Ask
    /// stages into the port's temp folder, like the desktop app stages
    /// into its own, and publishes only on a chosen save.
    private func resolveDestination(
        settings: AppSettings
    ) -> (directory: URL?, isStaging: Bool) {
        switch settings.outputDestination {
        case .downloads:
            return (FileManager.default.urls(
                for: .downloadsDirectory, in: .userDomainMask).first, false)
        case .source:
            return (nil, false)
        case .custom:
            let path = settings.customOutputDirectory
            if !path.isEmpty {
                return (URL(fileURLWithPath: path, isDirectory: true), false)
            }
            return (nil, false)
        case .ask:
            let staging = FileManager.default.temporaryDirectory
                .appendingPathComponent("vidcord-swift/staged-output", isDirectory: true)
            try? FileManager.default.createDirectory(
                at: staging, withIntermediateDirectories: true)
            return (staging, true)
        }
    }

    @MainActor
    private func askWhereToSave(suggested: URL) -> URL? {
        let panel = NSSavePanel()
        panel.directoryURL = FileManager.default.urls(
            for: .downloadsDirectory, in: .userDomainMask).first
        panel.nameFieldStringValue = suggested.lastPathComponent
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let chosen = panel.url else { return nil }
        // Publish: try a link first (same filesystem), fall back to a
        // create-new copy, then drop the staged file. The desktop
        // app's order, minus its sync, which this copy does not need.
        do {
            if FileManager.default.fileExists(atPath: chosen.path) {
                try FileManager.default.removeItem(at: chosen)
            }
            do {
                try FileManager.default.linkItem(at: suggested, to: chosen)
            } catch {
                try FileManager.default.copyItem(at: suggested, to: chosen)
            }
            try? FileManager.default.removeItem(at: suggested)
            return chosen
        } catch {
            toast("Save failed", String(describing: error))
            return nil
        }
    }

    /// The completion action and the notification, respecting the
    /// desktop app's rules: the system notification is suppressed
    /// while the app is focused, and a copy failure falls back to
    /// revealing the file.
    private func complete(_ result: CompressResult, settings: AppSettings) async {
        switch settings.completionAction {
        case .copy:
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            if !pasteboard.writeObjects([result.outputURL as NSURL]) {
                NSWorkspace.shared.activateFileViewerSelecting([result.outputURL])
            }
        case .reveal:
            NSWorkspace.shared.activateFileViewerSelecting([result.outputURL])
        case .none:
            break
        }
        toast(
            "Saved \(result.outputURL.lastPathComponent)",
            ByteCountFormatter.string(
                fromByteCount: Int64(result.outputBytes), countStyle: .file)
                + (result.fill.map {
                    " · \(String(format: "%.0f", $0 * 100))% of target"
                } ?? ""))
        if !NSApp.isActive {
            let content = UNMutableNotificationContent()
            content.title = "Vidcord (Swift)"
            content.body = "Saved \(result.outputURL.lastPathComponent)"
            content.userInfo = ["path": result.outputURL.path]
            let request = UNNotificationRequest(
                identifier: result.outputURL.path + Date().description,
                content: content, trigger: nil)
            let center = UNUserNotificationCenter.current()
            _ = try? await center.requestAuthorization(options: [.alert])
            try? await center.add(request)
        }
    }

    // MARK: - Snapshots and misc

    func snapshotCurrentFrame() {
        guard let item = selectedItem else { return }
        let at = currentTime
        let settings = store.settings
        Task {
            do {
                let asset = AVURLAsset(url: item.url)
                let image = try await Snapshots.frame(asset: asset, atSeconds: at)
                let directory = resolveDestination(settings: settings).directory
                    ?? item.url.deletingLastPathComponent()
                let saved = try Snapshots.savePNG(image, source: item.url, in: directory)
                toast("Snapshot saved", saved.lastPathComponent)
            } catch {
                toast("Snapshot failed", String(describing: error))
            }
        }
    }

    func seek(to seconds: Double) {
        player?.seek(
            to: CMTime(seconds: seconds, preferredTimescale: 600),
            toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func togglePlay() {
        guard let player, let item = selectedItem else { return }
        if player.rate > 0 {
            player.pause()
        } else {
            if currentTime >= item.effectiveEnd - 0.05 {
                seek(to: item.trimStart)
            }
            player.play()
        }
        playerRate = player.rate
    }

    func toast(_ title: String, _ body: String) {
        let toast = Toast(title: title, body: body)
        toasts.append(toast)
        Task {
            try? await Task.sleep(for: .seconds(4))
            toasts.removeAll { $0.id == toast.id }
        }
    }
}
