#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
