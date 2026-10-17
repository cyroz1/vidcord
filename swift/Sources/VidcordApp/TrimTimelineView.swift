import SwiftUI
import VidcordCore

/// The trim timeline: a filmstrip of the whole file with a selectable
/// range, drag handles, keyframe snapping (Lossless mode), a playhead,
/// and a zoom slider that pans a window over the strip. The desktop
/// app's timeline does the same work in React; here it is one SwiftUI
/// view over pure coordinate math.
struct TrimTimelineView: View {
    @Bindable var item: QueueItem
    var currentTime: Double
    var snapToKeyframes: Bool
    var onSeek: (Double) -> Void
    var onTrimSettled: () -> Void

    @State private var zoom: Double = 1
    @State private var windowStart: Double = 0

    private var duration: Double { max(item.duration, 0.01) }
    private var windowDuration: Double { duration / zoom }
    private var windowEnd: Double { min(windowStart + windowDuration, duration) }

    private func x(for time: Double, width: CGFloat) -> CGFloat {
        CGFloat((time - windowStart) / windowDuration) * width
    }

    private func time(forX x: CGFloat, width: CGFloat) -> Double {
        windowStart + Double(x / width) * windowDuration
    }

    private func snapped(_ time: Double) -> Double {
        guard snapToKeyframes, !item.keyframes.isEmpty else { return time }
        let nearest = item.keyframes.min(by: {
            abs($0 - time) < abs($1 - time)
        })
        if let nearest, abs(nearest - time) <= 0.35 { return nearest }
        return time
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { geo in
                let width = geo.size.width
                ZStack(alignment: .leading) {
                    filmstrip(width: width)
                    // Dimmed regions outside the selection.
                    Rectangle()
                        .fill(.black.opacity(0.45))
                        .frame(width: max(x(for: item.trimStart, width: width), 0))
                        .offset(x: 0)
                    Rectangle()
                        .fill(.black.opacity(0.45))
                        .frame(
                            width: max(
                                width - x(for: item.effectiveEnd, width: width), 0)
                        )
                        .offset(x: x(for: item.effectiveEnd, width: width))
                    // Selection frame.
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(.tint, lineWidth: 2)
                        .frame(
                            width: max(
                                x(for: item.effectiveEnd, width: width)
                                    - x(for: item.trimStart, width: width), 4)
                        )
                        .offset(x: x(for: item.trimStart, width: width))
                    // Playhead.
                    if currentTime >= windowStart, currentTime <= windowEnd {
                        Rectangle()
                            .fill(.white)
                            .frame(width: 2)
                            .offset(x: x(for: currentTime, width: width) - 1)
                            .shadow(radius: 2)
                    }
                    handle(isStart: true, width: width)
                    handle(isStart: false, width: width)
                }
                .contentShape(Rectangle())
                .onTapGesture { location in
                    onSeek(time(forX: location.x, width: width))
                }
            }
            .frame(height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 10) {
                timeField(label: "Start", value: item.trimStart) { newValue in
                    item.trimStart = min(max(snapped(newValue), 0), item.effectiveEnd - 0.1)
                }
                timeField(label: "End", value: item.effectiveEnd) { newValue in
                    item.trimEnd = max(
                        min(snapped(newValue), duration), item.trimStart + 0.1)
                }
                Text("\(TimeFormat.Clock.string(item.rangeDuration)) selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if !item.keyframes.isEmpty {
                    Text("\(item.keyframes.count) keyframes")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("Zoom").font(.caption).foregroundStyle(.secondary)
                Slider(value: $zoom, in: 1...8, step: 0.5)
                    .frame(width: 90)
                    .onChange(of: zoom) { _, _ in clampWindow() }
            }
            if zoom > 1 {
                HStack(spacing: 10) {
                    Text("Window").font(.caption).foregroundStyle(.secondary)
                    Slider(
                        value: $windowStart,
                        in: 0...max(duration - windowDuration, 0.01)
                    )
                    Text(
                        "\(TimeFormat.Clock.string(windowStart)) to "
                            + TimeFormat.Clock.string(windowEnd)
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func filmstrip(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(item.thumbnails.enumerated()), id: \.offset) { _, image in
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            }
            if item.thumbnails.isEmpty {
                Rectangle().fill(.quaternary)
            }
        }
        .frame(width: width * CGFloat(zoom))
        .offset(x: -CGFloat(windowStart / duration) * width * CGFloat(zoom))
        .frame(width: width, alignment: .leading)
        .clipped()
    }

    private func handle(isStart: Bool, width: CGFloat) -> some View {
        let time = isStart ? item.trimStart : item.effectiveEnd
        return RoundedRectangle(cornerRadius: 3)
            .fill(.tint)
            .frame(width: 12, height: 54)
            .overlay {
                Image(systemName: isStart ? "chevron.right" : "chevron.left")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.white)
            }
            .offset(x: x(for: time, width: width) - (isStart ? 0 : 12))
            .gesture(
                DragGesture()
                    .onChanged { value in
                        let dragged = time(forX: value.location.x, width: width)
                        if isStart {
                            item.trimStart = min(
                                max(snapped(dragged), 0), item.effectiveEnd - 0.1)
                        } else {
                            item.trimEnd = max(
                                min(snapped(dragged), duration), item.trimStart + 0.1)
                        }
                    }
                    .onEnded { _ in onTrimSettled() }
            )
    }

    private func timeField(
        label: String, value: Double, onCommit: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(
                label, value: Binding(
                    get: { value },
                    set: { onCommit($0) }
                ),
                format: .number.precision(.fractionLength(0...2))
            )
            .frame(width: 58)
            .textFieldStyle(.roundedBorder)
            Text("s").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func clampWindow() {
        windowStart = min(max(windowStart, 0), max(duration - windowDuration, 0))
        // Keep the selection in view when zooming.
        if item.trimStart < windowStart || item.trimStart > windowEnd {
            windowStart = min(max(item.trimStart - windowDuration * 0.25, 0),
                              max(duration - windowDuration, 0))
        }
    }
}

/// mm:ss / h:mm:ss with tenths, the only clock format the app uses.
enum TimeFormat {
    static func string(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%d:%02d", minutes, secs)
    }

    enum Clock {
        static func string(_ seconds: Double) -> String { TimeFormat.string(seconds) }
    }
}
