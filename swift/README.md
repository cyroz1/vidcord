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
  VidcordCore/    SizeTarget.swift (the ported size policy), Models.swift
  VidcordEngine/  VideoProbe.swift (AVFoundation probe), Compressor.swift
  VidcordApp/     VidcordApp.swift, ContentView.swift (SwiftUI, AVKit preview)
Tests/
  VidcordCoreTests/  the policy checks, with the Rust pipeline's numbers
```

## Build and run

Needs a Mac with Xcode (developed against the macOS 14 floor):

```sh
cd swift
swift build            # builds the Vidcord executable and the libraries
swift test             # the VidcordCore policy checks
swift run Vidcord      # launch the app
```

Or open `Package.swift` in Xcode and run the Vidcord scheme.

## The DMG

```sh
swift/Scripts/make-dmg.sh
```

builds the release executable, assembles `.build/Vidcord.app`
(ad hoc signed, no Developer ID, no notarization) and packages
`.build/Vidcord-Swift.dmg` with an Applications shortcut and the
image's SHA-256 printed. The `Swift DMG` GitHub Actions workflow
(`.github/workflows/swift-dmg.yml`) runs the tests and this script
on macos-15 for pushes to `swift-port` that touch `swift/**`, and
uploads the DMG as a build artifact kept for 7 days.

## Scope of this first cut

In: size-target MP4 (HEVC or H.264, the other codec as fallback phase),
quality-only encode when the target is off, audio kept as AAC at the
source rate capped to 160 kbps (stepped down, then dropped, on very
tight budgets), max-height downscale, drag-and-drop or picker import,
AVKit preview, progress with cancel, attempt history on the result.

Not yet (the Tauri app has them, a later cut can): trim UI (the engine
already accepts a range; the preflight uses it), GIF/WebP output,
batch, presets, snapshots, completion actions (copy to clipboard,
close after export), and the lossless stream-copy trim path.

## Status

Uncommitted working tree on the `swift-port` worktree, by design: the
repository's rule is quality gates before every commit, and the full
gates for this package (`swift build`, `swift test` with the Apple
SDKs) can only run on a Mac. What has been verified so far, off a
Linux Swift 6.1.2 toolchain: `VidcordCore` compiles clean and all 16
policy tests pass, and every source file in the package parses. The
engine and app still need their first real build in Xcode.
Nothing here touches `src/`, `src-tauri/` or `site/`, so the Tauri
app, its CI and its bundle budgets are unaffected.
