import AVKit
import SwiftUI
import UniformTypeIdentifiers
import VidcordCore
import VidcordEngine

/// The whole window, in the current Apple design language: content
/// grouped in Liquid Glass cards inside a GlassEffectContainer, glass
/// and glass-prominent buttons, system segmented controls, and
/// semantic colors throughout. One window, like the desktop app, with
/// the queue on top and the editor below it.
struct ContentView: View {
    @Bindable var model: AppModel
    @State private var choosingFiles = false
    @State private var choosingOutputFolder = false
    @State private var savingPreset = false
    @State private var presetName = ""

    private var store: Bindable<SettingsStore> { Bindable(model.store) }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                GlassEffectContainer(spacing: 14) {
                    VStack(alignment: .leading, spacing: 14) {
                        modePicker
                        queueCard
                        if let item = model.selectedItem {
                            editor(for: item)
                        }
                        outputCard
                        if model.running || model.lastResult != nil {
                            progressCard
                        }
                    }
                    .padding(16)
                }
            }
            actionBar
        }
        .overlay(alignment: .bottomLeading) { toastStack }
        .fileImporter(
            isPresented: $choosingFiles,
            allowedContentTypes: [.movie, .video, .mpeg4Movie, .quickTimeMovie, .folder],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { model.add(urls: urls) }
        }
        .fileImporter(
            isPresented: $choosingOutputFolder, allowedContentTypes: [.folder]
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                model.store.settings.customOutputDirectory = url.path
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            model.add(urls: urls)
            return true
        }
        .alert("Save preset", isPresented: $savingPreset) {
            TextField("Name", text: $presetName)
            Button("Save") {
                if let problem = model.store.savePreset(named: presetName) {
                    model.toast("Preset not saved", problem)
                }
                presetName = ""
            }
            Button("Cancel", role: .cancel) { presetName = "" }
        } message: {
            Text("Presets capture the editing settings, not the destination or completion action.")
        }
    }

    // MARK: - Header and modes

    private var header: some View {
        HStack(spacing: 10) {
            Text("Vidcord")
                .font(.title2.weight(.semibold))
            Text("SWIFT")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .glassEffect(.regular, in: Capsule())
            if model.store.selectedPresetIsDirty {
                Text("Autosave")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            presetMenu
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var presetMenu: some View {
        Menu {
            ForEach(model.store.presets) { preset in
                Button(preset.name) { model.store.applyPreset(preset) }
            }
            if !model.store.presets.isEmpty { Divider() }
            Button("Save current as preset...") { savingPreset = true }
            if let id = model.store.selectedPresetID,
               let preset = model.store.presets.first(where: { $0.id == id }) {
                Button("Delete \(preset.name)", role: .destructive) {
                    model.store.deletePreset(preset)
                }
            }
        } label: {
            Label("Presets", systemImage: "slider.horizontal.3")
        }
        .buttonStyle(.glass)
    }

    private var modePicker: some View {
        Picker("Mode", selection: store.settings.mode) {
            ForEach(EditMode.allCases, id: \.self) { mode in
                Text(mode.displayName).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }

    // MARK: - Queue

    private var queueCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.items.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "film.stack")
                        .font(.system(size: 34))
                        .foregroundStyle(.secondary)
                    Text("Drop videos or folders here")
                        .font(.headline)
                    Text("or choose files to build a batch. Every file gets the settings below.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Choose files...") { choosingFiles = true }
                        .buttonStyle(.glass)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
            } else {
                ForEach(model.items) { item in
                    queueRow(item)
                }
            }
        }
        .glassCard()
    }

    private func queueRow(_ item: QueueItem) -> some View {
        HStack(spacing: 10) {
            Group {
                if let thumb = item.thumbnails.first {
                    Image(nsImage: thumb).resizable().scaledToFill()
                } else {
                    Image(systemName: "film").foregroundStyle(.secondary)
                }
            }
            .frame(width: 52, height: 32)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.url.lastPathComponent)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Text(queueMeta(item))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            statusChip(item)
            Button {
                model.remove(item)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .disabled(model.running)
        }
        .padding(8)
        .background(
            model.selectedID == item.id
                ? AnyShapeStyle(.tint.opacity(0.14)) : AnyShapeStyle(.clear),
            in: RoundedRectangle(cornerRadius: 8)
        )
        .contentShape(Rectangle())
        .onTapGesture { model.select(item) }
    }

    private func queueMeta(_ item: QueueItem) -> String {
        guard let info = item.info else { return "probing..." }
        return "\(info.videoWidth)×\(info.videoHeight) · "
            + "\(TimeFormat.string(info.durationSeconds)) · "
            + ByteCountFormatter.string(
                fromByteCount: Int64(info.fileBytes), countStyle: .file)
    }

    private func statusChip(_ item: QueueItem) -> some View {
        let (text, color): (String, Color) =
            switch item.status {
            case .waiting: ("waiting", .secondary)
            case .running: ("working", .blue)
            case .done: ("done", .green)
            case .failed: ("failed", .red)
            case .cancelled: ("cancelled", .orange)
            }
        return Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .glassEffect(.regular.tint(color.opacity(0.18)), in: Capsule())
    }

    // MARK: - Editor

    @ViewBuilder
    private func editor(for item: QueueItem) -> some View {
        previewCard(item)
        TrimTimelineView(
            item: item, currentTime: model.currentTime,
            snapToKeyframes: model.store.settings.mode == .losslessTrim
                && model.snapToKeyframes,
            onSeek: { model.seek(to: $0) },
            onTrimSettled: { model.refreshThumbnails() }
        )
        .glassCard()
        controlsCard(item)
    }

    private func previewCard(_ item: QueueItem) -> some View {
        VStack(spacing: 8) {
            Group {
                if let player = model.player {
                    PlayerView(player: player)
                } else {
                    Rectangle().fill(.quaternary)
                }
            }
            .frame(height: 235)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 10) {
                Button {
                    model.togglePlay()
                } label: {
                    Image(systemName: model.playerRate > 0 ? "pause.fill" : "play.fill")
                }
                .buttonStyle(.glass)
                Text(TimeFormat.string(model.currentTime))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Slider(
                    value: Binding(
                        get: { model.currentTime },
                        set: { model.seek(to: $0) }
                    ),
                    in: item.trimStart...max(item.effectiveEnd, item.trimStart + 0.1)
                )
                Text(TimeFormat.string(item.effectiveEnd))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Button {
                    model.snapshotCurrentFrame()
                } label: {
                    Image(systemName: "camera")
                }
                .buttonStyle(.glass)
                .help("Save a frame snapshot (capped at 1920 px)")
            }
        }
        .glassCard()
    }

    @ViewBuilder
    private func controlsCard(_ item: QueueItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            switch model.store.settings.mode {
            case .compress: compressControls(item)
            case .gif: gifControls
            case .losslessTrim: losslessControls(item)
            }
        }
        .glassCard()
    }

    @ViewBuilder
    private func compressControls(_ item: QueueItem) -> some View {
        Toggle("Fit to a target size", isOn: store.settings.useTarget)
        if model.store.settings.useTarget {
            HStack(spacing: 6) {
                ForEach([10.0, 25.0, 50.0, 100.0, 500.0], id: \.self) { preset in
                    Button("\(Int(preset)) MB") {
                        model.store.settings.targetMB = preset
                    }
                    .buttonStyle(.glass)
                    .tint(model.store.settings.targetMB == preset ? .accentColor : .primary)
                }
                TextField(
                    "MB", value: store.settings.targetMB,
                    format: .number.precision(.fractionLength(0...1))
                )
                .frame(width: 62)
                Text("MB").foregroundStyle(.secondary)
            }
        }
        HStack(spacing: 14) {
            Picker("Codec", selection: store.settings.codec) {
                ForEach(CodecChoice.allCases, id: \.self) { codec in
                    Text(codec.displayName).tag(codec)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 215)
            Picker("Max height", selection: store.settings.maxHeight) {
                ForEach([0, 1080, 720, 480, 360], id: \.self) { height in
                    Text(height == 0 ? "Original" : "\(height)p").tag(height)
                }
            }
            .pickerStyle(.menu)
        }
        HStack(spacing: 14) {
            Picker("Frame rate", selection: store.settings.fpsCap) {
                Text("Source").tag(0.0)
                ForEach([60.0, 30.0, 24.0, 15.0], id: \.self) { fps in
                    Text("\(Int(fps)) fps").tag(fps)
                }
            }
            .pickerStyle(.menu)
            Picker("Crop", selection: store.settings.cropAspect) {
                ForEach(CropAspect.allCases, id: \.self) { aspect in
                    Text(aspect.displayName).tag(aspect)
                }
            }
            .pickerStyle(.menu)
        }
        Divider()
        Toggle("Remove audio", isOn: store.settings.removeAudio)
        if !model.store.settings.removeAudio {
            if let info = item.info, info.audioTracks.count > 1 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Audio tracks").font(.caption).foregroundStyle(.secondary)
                    ForEach(info.audioTracks, id: \.index) { track in
                        Toggle(
                            track.label,
                            isOn: Binding(
                                get: { model.selectedAudioTracks.contains(track.index) },
                                set: { on in
                                    if on {
                                        model.selectedAudioTracks.insert(track.index)
                                    } else {
                                        model.selectedAudioTracks.remove(track.index)
                                    }
                                }
                            )
                        )
                        .toggleStyle(.checkbox)
                    }
                }
            }
            Toggle("Normalize audio (peak)", isOn: store.settings.normalizeAudio)
        }
    }

    @ViewBuilder
    private var gifControls: some View {
        Picker("Format", selection: store.settings.gifFormat) {
            ForEach(GifFormat.allCases, id: \.self) { format in
                Text(format.displayName).tag(format)
            }
        }
        .pickerStyle(.segmented)
        .frame(width: 215)
        HStack {
            Text("Frame rate").foregroundStyle(.secondary)
            Slider(value: store.settings.gifFPS, in: 5...30, step: 1)
            Text("\(Int(model.store.settings.gifFPS)) fps")
                .font(.callout.monospacedDigit())
                .frame(width: 52)
        }
        Toggle("Fit to a target size", isOn: store.settings.gifUseTarget)
        if model.store.settings.gifUseTarget {
            HStack(spacing: 6) {
                ForEach([5.0, 10.0, 25.0, 50.0], id: \.self) { preset in
                    Button("\(Int(preset)) MB") {
                        model.store.settings.gifTargetMB = preset
                    }
                    .buttonStyle(.glass)
                }
                TextField(
                    "MB", value: store.settings.gifTargetMB,
                    format: .number.precision(.fractionLength(0...1))
                )
                .frame(width: 62)
                Text("MB").foregroundStyle(.secondary)
            }
        }
        Text("Animations render at up to 720 px wide. On oversize the exporter steps the frame rate and width down, the video engine's discipline in miniature.")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func losslessControls(_ item: QueueItem) -> some View {
        Toggle("Snap trim to keyframes", isOn: $model.snapToKeyframes)
        Text(
            item.keyframes.isEmpty
                ? "No re-encoding: the samples are copied, so cuts land on keyframes. Keyframes are still being scanned for this file."
                : "No re-encoding: the samples are copied, so the range snaps outward to the nearest of this file's \(item.keyframes.count) keyframes. If the container refuses the copy, the same range is compressed instead (with the Compress mode target, when one is set)."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    // MARK: - Output, progress, actions

    private var outputCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Destination", selection: store.settings.outputDestination) {
                ForEach(OutputDestination.allCases, id: \.self) { destination in
                    Text(destination.displayName).tag(destination)
                }
            }
            .pickerStyle(.segmented)
            if model.store.settings.outputDestination == .custom {
                HStack {
                    Text(
                        model.store.settings.customOutputDirectory.isEmpty
                            ? "No folder chosen yet"
                            : model.store.settings.customOutputDirectory
                    )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    Spacer()
                    Button("Choose...") { choosingOutputFolder = true }
                        .buttonStyle(.glass)
                }
            }
            HStack(spacing: 14) {
                Picker("When done", selection: store.settings.completionAction) {
                    ForEach(CompletionAction.allCases, id: \.self) { action in
                        Text(action.displayName).tag(action)
                    }
                }
                .pickerStyle(.menu)
                Toggle("Quit after export", isOn: store.settings.closeAppAfterExport)
            }
        }
        .glassCard()
    }

    private var progressCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView(value: model.progressFraction)
            Text(model.statusLine).font(.callout).foregroundStyle(.secondary)
            if let result = model.lastResult {
                Text(
                    "Last output: \(result.outputURL.lastPathComponent) · "
                        + ByteCountFormatter.string(
                            fromByteCount: Int64(result.outputBytes), countStyle: .file)
                        + (result.fill.map {
                            " · \(String(format: "%.0f", $0 * 100))% of target"
                        } ?? "")
                        + " · \(String(format: "%.1f", result.elapsedSeconds))s"
                )
                .font(.callout)
                ForEach(Array(result.attempts.enumerated()), id: \.offset) { _, attempt in
                    Text(
                        "attempt: \(attempt.note) · "
                            + ByteCountFormatter.string(
                                fromByteCount: Int64(attempt.outputBytes),
                                countStyle: .file)
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([result.outputURL])
                }
                .buttonStyle(.glass)
            }
        }
        .glassCard()
    }

    private var actionBar: some View {
        HStack {
            Button("Choose files...") { choosingFiles = true }
                .buttonStyle(.glass)
            Spacer()
            if model.running {
                Button("Cancel", role: .cancel) { model.cancelRun() }
                    .buttonStyle(.glass)
            }
            Button(startLabel) { model.startQueue() }
                .buttonStyle(.glassProminent)
                .disabled(
                    model.running
                        || !model.items.contains(where: { $0.status == .waiting }))
        }
        .padding(14)
    }

    private var startLabel: String {
        let waiting = model.items.filter { $0.status == .waiting }.count
        switch model.store.settings.mode {
        case .compress: return waiting > 1 ? "Compress \(waiting) files" : "Compress"
        case .gif: return waiting > 1 ? "Export \(waiting) animations" : "Export animation"
        case .losslessTrim: return waiting > 1 ? "Trim \(waiting) files" : "Trim losslessly"
        }
    }

    private var toastStack: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.toasts) { toast in
                VStack(alignment: .leading, spacing: 2) {
                    Text(toast.title).font(.callout.weight(.semibold))
                    Text(toast.body).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(16)
    }
}

/// Cards in the app's glass grouping: padding first, then the glass.
private struct GlassCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
    }
}

extension View {
    func glassCard() -> some View { modifier(GlassCard()) }
}

/// The native preview: AVKit's player view, the counterpart of the
/// desktop app's HTML video element, with the system's own controls
/// replaced by the transport row above it.
struct PlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .none
        view.videoGravity = .resizeAspect
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }
}
