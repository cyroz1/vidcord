// swift-tools-version: 5.9
import PackageDescription

// Vidcord, ported to native Swift following the rules Sill works by:
// Swift and Apple frameworks only, no third-party dependencies, nothing
// that needs a server. The package is split the way Sill splits its own:
// a pure policy core (VidcordCore, no I/O, no AVFoundation), an imperative
// engine shell around it (VidcordEngine), and the app (VidcordApp).
// The macOS app is Apple silicon / macOS 14+, matching the floor the
// frameworks used here (AVFoundation, VideoToolbox, SwiftUI) assume.
let package = Package(
    name: "VidcordSwift",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "Vidcord", targets: ["VidcordApp"]),
        .library(name: "VidcordCore", targets: ["VidcordCore"]),
        .library(name: "VidcordEngine", targets: ["VidcordEngine"]),
    ],
    targets: [
        .target(name: "VidcordCore"),
        .target(name: "VidcordEngine", dependencies: ["VidcordCore"]),
        .executableTarget(
            name: "VidcordApp",
            dependencies: ["VidcordCore", "VidcordEngine"]
        ),
        .testTarget(name: "VidcordCoreTests", dependencies: ["VidcordCore"]),
    ]
)
