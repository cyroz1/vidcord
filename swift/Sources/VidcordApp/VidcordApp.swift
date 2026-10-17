import SwiftUI

/// Vidcord, the Swift port. Same job as the Tauri app (land a video at
/// a target size, Discord first) rebuilt the way Sill is built: native
/// Swift and Apple frameworks only, no web view, no FFmpeg, no
/// third-party code at all.
@main
struct VidcordApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 460, minHeight: 620)
        }
        .windowResizability(.contentMinSize)
    }
}
