import AVKit
import Observation
import SwiftUI
import UniformTypeIdentifiers
import VidcordCore
import VidcordEngine

@Observable
final class JobModel {
    var sourceURL: URL?
    var info: SourceInfo?
    var useTarget = true
    var targetMB = 25.0
    var codec: CodecChoice = .hevc
    var keepAudio = true
    var maxHeight = 0

    var running = false
    var progressFraction = 0.0
    var statusLine = "Drop a video here, or choose one."
    var result: CompressResult?
    var errorLine: String?
    var player: AVPlayer?

    private var token: CancellationToken?
    private var task: Task<Void, Never>?

    func load(url: URL) {
        cancel()
        sourceURL = url
        info = nil
        result = nil
        errorLine = nil
        progressFraction = 0
        player = AVPlayer(url: url)
        statusLine = url.lastPathComponent
        Task {
            if let probed = try? await VideoProbe.probe(url: url) {
                info = probed
            } else {
                errorLine = "That file could not be probed as a video."
            }
        }
    }

    func start() {
        guard let sourceURL, !running else { return }
        let token = CancellationToken()
        self.token = token
        running = true
        result = nil
        errorLine = nil
        progressFraction = 0
        let request = CompressRequest(
            sourceURL: sourceURL,
            targetBytes: useTarget ? UInt64(targetMB * 1_000_000) : nil,
            codec: codec, keepAudio: keepAudio, maxHeight: maxHeight)
        task = Task {
            do {
                let outcome = try await Compressor().compress(
                    request: request, token: token,
                    progress: { [weak self] event in
                        Task { @MainActor [weak self] in
                            self?.progressFraction = event.fraction
                            self?.statusLine = event.statusLine
                        }
                    })
                result = outcome
                statusLine = "Done: \(outcome.outputURL.lastPathComponent)"
                player = AVPlayer(url: outcome.outputURL)
            } catch {
                errorLine = String(describing: error)
                statusLine = "Stopped."
            }
            running = false
        }
    }

    func cancel() {
        token?.cancel()
        task?.cancel()
    }
}

struct ContentView: View {
    @State private var model = JobModel()
    @State private var choosing = false

    private let targetPresets = [10.0, 25.0, 50.0, 100.0, 500.0]
    private let heightChoices = [0, 1080, 720, 480]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            preview
            sourceSummary
            targetControls
            codecControls
            Divider()
            progressArea
            if let result = model.result { resultPanel(result) }
            if let errorLine = model.errorLine {
                Text(errorLine).foregroundStyle(.red).font(.callout)
            }
            Spacer()
            actionRow
        }
        .padding(16)
        .fileImporter(
            isPresented: $choosing, allowedContentTypes: [.movie, .video, .mpeg4Movie]
        ) { outcome in
            if case .success(let url) = outcome { model.load(url: url) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            model.load(url: url)
            return true
        }
    }

    private var preview: some View {
        Group {
            if let player = model.player {
                PlayerView(player: player)
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .overlay {
                        Text("Drop a video here")
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .frame(height: 240)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var sourceSummary: some View {
        Group {
            if let info = model.info {
                Text(
                    "\(info.videoWidth)×\(info.videoHeight) · "
                        + "\(String(format: "%.1f", info.durationSeconds))s · "
                        + ByteCountFormatter.string(
                            fromByteCount: Int64(info.fileBytes), countStyle: .file)
                        + (info.hasAudio ? " · audio" : " · no audio")
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            } else {
                Text(model.statusLine).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private var targetControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Fit to a target size", isOn: $model.useTarget)
            if model.useTarget {
                HStack(spacing: 6) {
                    ForEach(targetPresets, id: \.self) { preset in
                        Button("\(Int(preset)) MB") { model.targetMB = preset }
                            .buttonStyle(.bordered)
                            .tint(model.targetMB == preset ? .accentColor : .secondary)
                    }
                    TextField(
                        "MB", value: $model.targetMB,
                        format: .number.precision(.fractionLength(0...1))
                    )
                    .frame(width: 64)
                }
            }
        }
        .disabled(model.running)
    }

    private var codecControls: some View {
        HStack(spacing: 16) {
            Picker("Codec", selection: $model.codec) {
                ForEach(CodecChoice.allCases, id: \.self) { choice in
                    Text(choice.displayName).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 220)
            Picker("Max height", selection: $model.maxHeight) {
                ForEach(heightChoices, id: \.self) { height in
                    Text(height == 0 ? "Original" : "\(height)p").tag(height)
                }
            }
            .pickerStyle(.menu)
            Toggle("Keep audio", isOn: $model.keepAudio)
        }
        .disabled(model.running)
    }

    private var progressArea: some View {
        VStack(alignment: .leading, spacing: 6) {
            ProgressView(value: model.progressFraction)
            Text(model.statusLine).font(.callout).foregroundStyle(.secondary)
        }
    }

    private func resultPanel(_ result: CompressResult) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(
                "Output: \(ByteCountFormatter.string(fromByteCount: Int64(result.outputBytes), countStyle: .file))"
                    + (result.fill.map {
                        " · \(String(format: "%.0f", $0 * 100))% of target"
                    } ?? "")
                    + (result.overTarget ? " · over target, smallest attempt kept" : "")
                    + " · \(String(format: "%.1f", result.elapsedSeconds))s"
            )
            .font(.callout)
            ForEach(Array(result.attempts.enumerated()), id: \.offset) { _, attempt in
                Text(
                    "attempt: \(attempt.codec.displayName) at \(attempt.videoBitrateKbps) kbps → "
                        + ByteCountFormatter.string(
                            fromByteCount: Int64(attempt.outputBytes), countStyle: .file)
                        + " (\(attempt.note))"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            HStack {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([result.outputURL])
                }
                Button("Play output") { model.player = AVPlayer(url: result.outputURL) }
            }
        }
    }

    private var actionRow: some View {
        HStack {
            Button("Choose video...") { choosing = true }
            Spacer()
            if model.running {
                Button("Cancel", role: .cancel) { model.cancel() }
            }
            Button("Compress") { model.start() }
                .buttonStyle(.borderedProminent)
                .disabled(model.sourceURL == nil || model.running)
        }
    }
}

/// The native preview: AVKit's player view, the counterpart of the
/// Tauri app's HTML video element.
struct PlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .inline
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }
}
