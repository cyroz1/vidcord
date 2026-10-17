# VidcordSwift

A native Swift port of Vidcord, built as an experiment on the
`swift-port` branch (a checkout of 7.7). It does the Tauri app's core
job, landing a video at a target size (Discord first), without the web
view and without FFmpeg.

## The rules it follows

Borrowed from Sill's playbook, applied the same way:

- **Swift and Apple frameworks only.** AVFoundation and VideoToolbox
  probe, decode and encode; SwiftUI is the interface; Foundation does
  the rest. No third-party dependencies, anywhere.
- **Nothing that needs a server.** Files are read and written locally;
  the app makes no network calls.
- **The OS does the heavy lifting.** Hardware HEVC/H.264 through
  VideoToolbox is why the eventual app can stay a few megabytes: no
  bundled codec stack (the Tauri app shells out to a system FFmpeg
  instead, and carries a web view).
- **A pure policy core with an imperative shell.** `VidcordCore` holds
  every decision that can be a pure function and is unit-tested on its
  own; `VidcordEngine` only does I/O around it; `VidcordApp` only
  presents state.

And from Vidcord's own 7.7 pipeline, ported rather than reinvented:

- **One margin, owned by the engine.** `SizeTarget.safety` (0.95) is
  the only safety factor in the size pipeline; the budget arrives
  unshrunk and projections are margin-free.
- **The 85% accept line.** An attempt filling at least 85% of the
  target is accepted instead of paying for a refinement encode.
- **Mid-clip preflight.** Clips of 8s+ give up a short sample from the
  middle (an eighth of the clip, clamped to 1-4s) whose projection
  sets the first encode's bitrate.
- **Bounded adaptive retries.** Oversize steps the bitrate down by the
  measured ratio, underfill steps it up (1.5x per-pass cap, never
  above the source rate), at most 2 retries per codec, then the other
  codec gets its own phase. The Rust original pairs this with a VBV
  ceiling (maxrate, bufsize 2x); the port maps that to
  VideoToolbox's average bit rate plus a 2x data-rate limit.
- **Output naming and reservation follow the desktop app:**
  `<stem>-vidcord[-N].mp4` beside the source, the name reserved
  create-new before encoding starts.

## Layout

```
Package.swift
Sources/
  VidcordCore/    SizeTarget.swift (the ported size policy), Models.swift,
                  Settings.swift (settings + preset models, Codable)
  VidcordEngine/  VideoProbe.swift (probe), Compressor.swift (transcode),
                  GifExporter.swift (GIF/WebP), LosslessTrim.swift
                  (stream-copy trim, keyframes, snapshots)
  VidcordApp/     VidcordApp.swift (entry, Open With routing),
                  AppModel.swift (queue, runs, completion),
                  SettingsStore.swift (persistence + preset rules),
                  ContentView.swift (the Liquid Glass window),
                  TrimTimelineView.swift (filmstrip trim editor)
Tests/
  VidcordCoreTests/  the policy checks, with the Rust pipeline's numbers
```

## Build and run

Needs a Mac with Xcode 26 (the macOS 26 floor is the Liquid Glass
design language; there is no legacy shell):

```sh
cd swift
swift build            # builds the Vidcord executable and the libraries
swift test             # the VidcordCore policy checks
swift run Vidcord      # launch the app
```

Or open `Package.swift` in Xcode and run the Vidcord scheme.

## The app bundle, and the DMG

```sh
swift/Scripts/make-dmg.sh              # app + DMG
swift/Scripts/make-dmg.sh --app-only   # just the app
```

builds the release executable and assembles `.build/Vidcord.app`
(ad hoc signed, no Developer ID, no notarization). Without
`--app-only` it also packages `.build/Vidcord-Swift.dmg` with an
Applications shortcut and the image's SHA-256 printed. The
`Swift App` GitHub Actions workflow
(`.github/workflows/swift-app.yml`) runs the tests and the
`--app-only` build on macos-15 for pushes to `swift-port` that touch
`swift/**`, and uploads exactly one artifact, the `Vidcord.app`
bundle, kept for 7 days.

## Feature parity with the desktop app

The interface is the current Apple design language (Liquid Glass,
macOS 26 floor) over the desktop app's feature set:

| Desktop app | Swift port |
| --- | --- |
| Size-target compression with the adaptive pipeline | yes, the ported policy (see above) |
| HEVC / H.264 encoders with a fallback phase | yes (VideoToolbox; the other codec is the fallback phase) |
| Trim timeline with zoom | yes (filmstrip, drag handles, zoom + window sliders) |
| Preview with transport and scrubbing | yes (AVKit player, custom transport row) |
| Frame snapshots (1920 px cap) | yes |
| Lossless Trim, keyframe scan + outward snap | yes (AVAssetExportSession passthrough) |
| Lossless fallback to compression on refusal | yes, same flow and target |
| GIF mode, GIF + animated WebP | yes (ImageIO; no palette pass, ImageIO quantizes) |
| Batch queue, per-file failure isolation | yes (one job at a time, the editor's settings for the batch) |
| Output destinations (Downloads / source / ask / custom) | yes, ask stages then publishes like the original |
| Completion actions (copy / reveal / none) | yes (copy falls back to reveal, like the original) |
| System notifications, suppressed while focused | yes, click activates the app |
| Close app after export | yes |
| Named presets (20 max, capture rules, autosave state) | yes, same rules |
| Settings persistence with atomic replace | yes (JSON in Application Support/vidcord-swift) |
| Audio track selection (multi-track) | yes, checkbox list per file |
| Audio normalization | peak normalize (the original measures loudness; peak is the honest AVFoundation equivalent) |
| Crop aspect ratios, fps cap, resolution cap | yes, crop then scale on the GPU |
| Open With / folder import | yes (document types in the bundle; folders scanned recursively) |
| Encoder list dialog (FFmpeg encoders) | n/a: no FFmpeg; the codec picker is the VideoToolbox pair |
| In-app updater (signed installer download) | no: the port ships as CI artifacts, there is no release channel to update from yet |
| Browser edition | no: that is a separate product surface, not part of the desktop parity target |

Deliberate deviations are listed, never hidden: peak instead of
loudness normalization, ImageIO's quantization instead of a palette
pass, and per-batch settings taken from the editor as it stands.

## Status

Uncommitted working tree on the `swift-port` worktree, by design: the
repository's rule is quality gates before every commit, and the full
gates for this package (`swift build`, `swift test` with the Apple
SDKs) can only run on a Mac. What has been verified so far, off a
Linux Swift 6.1.2 toolchain: `VidcordCore` compiles clean and all 22
policy tests pass, and every source file in the package parses. CI
(the Swift App workflow) is the full gate for the engine and app.
Nothing here touches `src/`, `src-tauri/` or `site/`, so the Tauri
app, its CI and its bundle budgets are unaffected.
