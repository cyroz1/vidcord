import AppKit
import SwiftUI
import UserNotifications

/// Vidcord, the Swift port. Same job as the Tauri app (land a video
/// at a target size, Discord first) rebuilt the way Sill is built:
/// native Swift and Apple frameworks only, no web view, no FFmpeg, no
/// third-party code at all, and the interface in the current Apple
/// design language, Liquid Glass included.
@main
struct VidcordApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .frame(minWidth: 500, minHeight: 700)
                .onAppear { delegate.attach(model) }
        }
        .windowResizability(.contentMinSize)
    }
}

/// Open With and file-open routing, with the same race the desktop
/// app's PendingFile handles: an open event can arrive before the
/// window (and its model) exists, so early files are buffered and
/// drained when the model attaches.
final class AppDelegate: NSObject, NSApplicationDelegate,
    UNUserNotificationCenterDelegate {
    private weak var model: AppModel?
    private var pending: [URL] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func attach(_ model: AppModel) {
        self.model = model
        if !pending.isEmpty {
            model.add(urls: pending)
            pending = []
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if let model {
            model.add(urls: urls)
        } else {
            pending += urls
        }
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }

    /// Clicking a completion notification activates the app, like the
    /// desktop app's notification activation path.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first?.makeKeyAndOrderFront(nil)
        }
    }

    /// While the app is frontmost its own toasts carry the news, so
    /// banners stay quiet (the desktop app suppresses on focus too).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        NSApp.isActive ? [] : [.banner]
    }
}
