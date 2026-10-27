// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        #[link(name = "X11")]
        unsafe extern "C" {
            fn XInitThreads() -> std::ffi::c_int;
        }
        // GTK and WebKit may access Xlib from different threads. This must
        // run before either library opens an X display.
        unsafe { XInitThreads() };
    }
    vidcord_lib::run();
}
