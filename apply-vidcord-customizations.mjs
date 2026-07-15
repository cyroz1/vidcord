#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());
const file = (...parts) => path.join(root, ...parts);

const files = {
  packageJson: file("package.json"),
  app: file("src", "App.tsx"),
  css: file("src", "App.css"),
  settingsHook: file("src", "hooks", "useSettings.ts"),
  ipc: file("src", "ipc.ts"),
  rustFiles: file("src-tauri", "src", "commands", "files.rs"),
  rustSettings: file("src-tauri", "src", "settings.rs"),
  rustLib: file("src-tauri", "src", "lib.rs"),
};

for (const candidate of Object.values(files)) {
  if (!fs.existsSync(candidate)) {
    throw new Error(`Expected Vidcord source file is missing: ${candidate}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
if (packageJson.version !== "6.7.0") {
  throw new Error(
    `This patch is pinned to Vidcord 6.7.0, but package.json reports ${packageJson.version ?? "unknown"}.`,
  );
}

const read = (filename) =>
  fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n");
const write = (filename, contents) =>
  fs.writeFileSync(filename, contents, "utf8");

function uniqueRegexReplace(text, regex, replacement, label) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matches = [...text.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  }

  const match = matches[0];
  const replacementText =
    typeof replacement === "function"
      ? replacement(match[0], match)
      : replacement;
  return (
    text.slice(0, match.index) +
    replacementText +
    text.slice(match.index + match[0].length)
  );
}

function uniqueStringReplace(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first === -1) throw new Error(`Could not find ${label}.`);
  if (text.indexOf(search, first + search.length) !== -1) {
    throw new Error(`${label} was not unique.`);
  }
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

function patchSettingsHook() {
  let text = read(files.settingsHook);
  if (text.includes("const [outputDirectory, setOutputDirectory]")) return;

  text = uniqueStringReplace(
    text,
    "  const [removeAudio, setRemoveAudio] = useState(false);",
    `  const [removeAudio, setRemoveAudio] = useState(false);\n  const [outputDirectory, setOutputDirectory] = useState("");\n  const [completionAction, setCompletionAction] = useState<\n    "open_folder" | "copy_clipboard"\n  >("open_folder");`,
    "useSettings remove-audio state",
  );

  text = uniqueStringReplace(
    text,
    '      if (typeof s.remove_audio === "boolean") setRemoveAudio(s.remove_audio);',
    `      if (typeof s.remove_audio === "boolean") setRemoveAudio(s.remove_audio);\n      if (typeof s.output_directory === "string") {\n        setOutputDirectory(s.output_directory);\n      }\n      if (s.completion_action === "open_folder" || s.completion_action === "copy_clipboard") {\n        setCompletionAction(s.completion_action);\n      }`,
    "useSettings persisted remove-audio load",
  );

  text = uniqueStringReplace(
    text,
    `    removeAudio,\n    setRemoveAudio,\n    saveSettings,`,
    `    removeAudio,\n    setRemoveAudio,\n    outputDirectory,\n    setOutputDirectory,\n    completionAction,\n    setCompletionAction,\n    saveSettings,`,
    "useSettings return values",
  );

  write(files.settingsHook, text);
}

function patchIpc() {
  let text = read(files.ipc);
  if (text.includes("export function copyFileToClipboard")) return;

  text = uniqueRegexReplace(
    text,
    /export function resolveOutputPath\(inputPath: string\): Promise<string> \{\n\s*return invoke<string>\("resolve_output_path", \{ inputPath \}\);\n\}/,
    `export function resolveOutputPath(\n  inputPath: string,\n  outputDirectory: string | null\n): Promise<string> {\n  return invoke<string>("resolve_output_path", { inputPath, outputDirectory });\n}\n\nexport function copyFileToClipboard(path: string): Promise<void> {\n  return invoke("copy_file_to_clipboard", { path });\n}`,
    "resolveOutputPath IPC wrapper",
  );

  write(files.ipc, text);
}

function patchRustSettings() {
  let text = read(files.rustSettings);
  if (text.includes("pub completion_action: Option<String>")) return;

  text = uniqueStringReplace(
    text,
    `    #[serde(skip_serializing_if = "Option::is_none")]\n    pub remove_audio: Option<bool>,`,
    `    #[serde(skip_serializing_if = "Option::is_none")]\n    pub remove_audio: Option<bool>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub output_directory: Option<String>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    pub completion_action: Option<String>,`,
    "Rust persisted remove-audio field",
  );

  write(files.rustSettings, text);
}

function patchRustFiles() {
  let text = read(files.rustFiles);
  if (text.includes("pub async fn copy_file_to_clipboard")) return;

  const replacement = `#[tauri::command]\npub async fn copy_file_to_clipboard(path: String) -> Result<(), String> {\n    tokio::task::spawn_blocking(move || copy_file_to_clipboard_blocking(path))\n        .await\n        .map_err(|error| error.to_string())?\n}\n\nfn copy_file_to_clipboard_blocking(path: String) -> Result<(), String> {\n    let absolute =\n        std::fs::canonicalize(&path).unwrap_or_else(|_| std::path::PathBuf::from(&path));\n    if !absolute.is_file() {\n        return Err("The completed video file could not be found".to_string());\n    }\n\n    #[cfg(target_os = "windows")]\n    {\n        use std::os::windows::process::CommandExt;\n\n        let escaped_path = absolute.to_string_lossy().replace('\\'', "''");\n        let script = format!(\n            "Add-Type -AssemblyName System.Windows.Forms; \\\n             $files = New-Object System.Collections.Specialized.StringCollection; \\\n             [void]$files.Add('{}'); \\\n             [System.Windows.Forms.Clipboard]::SetFileDropList($files)",\n            escaped_path\n        );\n        let status = std::process::Command::new("powershell.exe")\n            .args([\n                "-NoProfile",\n                "-NonInteractive",\n                "-STA",\n                "-Command",\n                script.as_str(),\n            ])\n            .creation_flags(0x08000000)\n            .status()\n            .map_err(|error| error.to_string())?;\n\n        if status.success() {\n            Ok(())\n        } else {\n            Err(format!(\n                "Windows could not copy the video file to the clipboard (exit status {status})"\n            ))\n        }\n    }\n\n    #[cfg(not(target_os = "windows"))]\n    {\n        Err("Copying output files to the clipboard is currently available on Windows only"\n            .to_string())\n    }\n}\n\n#[tauri::command]\npub async fn resolve_output_path(\n    input_path: String,\n    output_directory: Option<String>,\n) -> Result<String, String> {\n    tokio::task::spawn_blocking(move || {\n        resolve_output_path_blocking(input_path, output_directory)\n    })\n    .await\n    .map_err(|error| error.to_string())?\n}\n\nfn resolve_output_path_blocking(\n    input_path: String,\n    output_directory: Option<String>,\n) -> Result<String, String> {\n    let input = std::path::Path::new(&input_path);\n    let stem = input\n        .file_stem()\n        .and_then(|value| value.to_str())\n        .unwrap_or("video");\n\n    let output_directory = output_directory\n        .map(|value| value.trim().to_owned())\n        .filter(|value| !value.is_empty())\n        .map(std::path::PathBuf::from)\n        .or_else(dirs::download_dir)\n        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))\n        .ok_or("Cannot find Downloads folder")?;\n\n    if output_directory.exists() && !output_directory.is_dir() {\n        return Err("The selected output location is not a folder".to_string());\n    }\n\n    std::fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;\n\n    let mut candidate = output_directory.join(format!("{stem}-vidcord.mp4"));\n    let mut counter = 1u32;\n    while candidate.exists() {\n        candidate = output_directory.join(format!("{stem}-vidcord-{counter}.mp4"));\n        counter += 1;\n    }\n\n    Ok(candidate.to_string_lossy().into_owned())\n}`;

  text = uniqueRegexReplace(
    text,
    /#\[tauri::command\]\npub async fn resolve_output_path\(input_path: String\) -> Result<String, String> \{[\s\S]*?\n\}\n\nfn resolve_output_path_blocking\(input_path: String\) -> Result<String, String> \{[\s\S]*?\n\}/,
    replacement,
    "Rust output-path command and helper",
  );

  write(files.rustFiles, text);
}

function patchRustLib() {
  let text = read(files.rustLib);
  if (text.includes("copy_file_to_clipboard, get_os")) return;

  text = uniqueRegexReplace(
    text,
    /use commands::files::\{get_os, resolve_output_path, show_in_file_explorer, PendingFile\};/,
    `use commands::files::{\n    copy_file_to_clipboard, get_os, resolve_output_path, show_in_file_explorer, PendingFile,\n};`,
    "Rust file-command import",
  );

  text = uniqueStringReplace(
    text,
    `        show_in_file_explorer,\n        get_vaapi_device,`,
    `        show_in_file_explorer,\n        copy_file_to_clipboard,\n        get_vaapi_device,`,
    "Tauri command registration",
  );

  write(files.rustLib, text);
}

function patchApp() {
  let text = read(files.app);
  if (text.includes("const chooseOutputDirectory")) return;

  text = uniqueStringReplace(
    text,
    `  resolveOutputPath,\n  showInFileExplorer,`,
    `  resolveOutputPath,\n  showInFileExplorer,\n  copyFileToClipboard,`,
    "App IPC imports",
  );

  text = uniqueStringReplace(
    text,
    `    removeAudio,\n    setRemoveAudio,\n    saveSettings,`,
    `    removeAudio,\n    setRemoveAudio,\n    outputDirectory,\n    setOutputDirectory,\n    completionAction,\n    setCompletionAction,\n    saveSettings,`,
    "App settings destructuring",
  );

  text = uniqueStringReplace(
    text,
    `export default function App() {`,
    `function CompletionActionIcon({ action }: { action: string }) {\n  if (action === "copy_clipboard") {\n    return (\n      <svg viewBox="0 0 24 24" aria-hidden="true">\n        <rect x="8" y="7" width="10" height="12" rx="2" />\n        <path d="M15 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />\n      </svg>\n    );\n  }\n\n  return (\n    <svg viewBox="0 0 24 24" aria-hidden="true">\n      <path d="M3.5 7.5h6l2-2h9v12a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />\n      <path d="M3.5 9.5h17" />\n    </svg>\n  );\n}\n\nexport default function App() {`,
    "App component declaration",
  );

  text = uniqueRegexReplace(
    text,
    /  const browseFile = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[addToast, loadVideo\]\);/,
    (match) =>
      `${match}\n\n  const chooseOutputDirectory = useCallback(async () => {\n    try {\n      const { open } = await import("@tauri-apps/plugin-dialog");\n      const selected = await open({\n        directory: true,\n        multiple: false,\n        defaultPath: outputDirectory || undefined,\n      });\n      if (typeof selected !== "string") return;\n\n      setOutputDirectory(selected);\n      saveSettings({ output_directory: selected });\n    } catch (error) {\n      addToast("error", "Could Not Select Output Folder", String(error));\n    }\n  }, [addToast, outputDirectory, saveSettings, setOutputDirectory]);\n\n  const resetOutputDirectory = useCallback(() => {\n    setOutputDirectory("");\n    saveSettings({ output_directory: "" });\n  }, [saveSettings, setOutputDirectory]);`,
    "Browse File callback",
  );

  text = uniqueStringReplace(
    text,
    `    resolveOutputPath(filePath).catch(() => null),`,
    `    resolveOutputPath(filePath, outputDirectory || null).catch(() => null),`,
    "output-path resolution call",
  );

  text = uniqueStringReplace(
    text,
    `    if (outputPath) {\n      addToast("success", "Success", "Compression complete!");\n      showInFileExplorer(outputPath).catch(() => {});\n    }`,
    `    if (outputPath) {\n      if (completionAction === "copy_clipboard") {\n        try {\n          await copyFileToClipboard(outputPath);\n          addToast(\n            "success",\n            "Copied to Clipboard",\n            "Compression complete — press Ctrl+V in Discord to upload it."\n          );\n        } catch (error) {\n          addToast(\n            "warning",\n            "Could Not Copy File",\n            "The video was saved, but it could not be copied to the clipboard: " + String(error)\n          );\n          showInFileExplorer(outputPath).catch(() => {});\n        }\n      } else {\n        addToast("success", "Success", "Compression complete!");\n        showInFileExplorer(outputPath).catch(() => {});\n      }\n    }`,
    "post-compression behavior",
  );

  text = uniqueStringReplace(
    text,
    `    removeAudio,\n    addToast,`,
    `    removeAudio,\n    outputDirectory,\n    completionAction,\n    addToast,`,
    "compression callback dependencies",
  );

  const outputControls = `      <div className="output-folder-row">\n        <div className="output-folder-copy">\n          <span className="output-folder-label">Output folder</span>\n          <span\n            className="output-folder-path"\n            title={outputDirectory || "Downloads (default)"}\n          >\n            {outputDirectory || "Downloads (default)"}\n          </span>\n        </div>\n\n        <button\n          type="button"\n          className="browse-btn output-folder-button"\n          onClick={chooseOutputDirectory}\n          disabled={compressing || cancelling}\n        >\n          Change\n        </button>\n\n        {outputDirectory && (\n          <button\n            type="button"\n            className="browse-btn output-folder-button"\n            onClick={resetOutputDirectory}\n            disabled={compressing || cancelling}\n          >\n            Reset\n          </button>\n        )}\n\n        <label className="completion-action" title="What to do after compression">\n          <CompletionActionIcon action={completionAction} />\n          <select\n            aria-label="After compression"\n            value={completionAction}\n            disabled={compressing || cancelling}\n            onChange={(event) => {\n              const nextAction = event.target.value as "open_folder" | "copy_clipboard";\n              setCompletionAction(nextAction);\n              saveSettings({ completion_action: nextAction });\n            }}\n          >\n            <option value="open_folder">Open folder</option>\n            <option value="copy_clipboard">Copy file</option>\n          </select>\n        </label>\n      </div>\n\n`;

  text = uniqueRegexReplace(
    text,
    /^(\s*)\{\/\* Compress button \*\/\}/m,
    (match) => outputControls + match,
    "Compress button marker",
  );

  write(files.app, text);
}

function patchCss() {
  let text = read(files.css);
  if (text.includes(".output-folder-row")) return;

  const css = `\n\n/* ── Output destination / completion action ─────────────────────────── */\n.output-folder-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto auto auto;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n  padding: 7px 8px;\n  background: var(--surface);\n  backdrop-filter: var(--blur);\n  -webkit-backdrop-filter: var(--blur);\n  border: 1px solid var(--border-subtle);\n  border-radius: var(--radius-sm);\n  box-shadow: var(--shadow-card), var(--card-top);\n}\n\n.output-folder-copy {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 0;\n}\n\n.output-folder-label {\n  color: var(--text-secondary);\n  font-size: 10px;\n  line-height: 1.2;\n}\n\n.output-folder-path {\n  min-width: 0;\n  overflow: hidden;\n  color: var(--text);\n  font-size: 12px;\n  line-height: 1.25;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.output-folder-row .output-folder-button {\n  min-height: 30px;\n  padding: 5px 9px;\n  font-size: 12px;\n  white-space: nowrap;\n}\n\n.output-folder-row button:disabled,\n.output-folder-row select:disabled {\n  cursor: not-allowed;\n  opacity: 0.55;\n}\n\n.completion-action {\n  position: relative;\n  display: inline-flex;\n  align-items: center;\n  min-width: 0;\n}\n\n.completion-action svg {\n  position: absolute;\n  left: 8px;\n  z-index: 1;\n  width: 14px;\n  height: 14px;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.8;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n  color: var(--text-secondary);\n  pointer-events: none;\n}\n\n.completion-action select {\n  min-width: 118px;\n  height: 30px;\n  appearance: none;\n  -webkit-appearance: none;\n  background-color: var(--surface2);\n  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='rgba(255%2C255%2C255%2C0.50)' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");\n  background-repeat: no-repeat;\n  background-position: right 7px center;\n  border: 1px solid var(--border);\n  border-radius: var(--radius-xs);\n  box-shadow: var(--card-top);\n  color: var(--text);\n  cursor: pointer;\n  font-size: 12px;\n  padding: 5px 23px 5px 27px;\n}\n\n.completion-action select:hover:not(:disabled) {\n  border-color: var(--accent);\n  background-color: var(--surface-subtle);\n}\n\n.completion-action select:focus-visible {\n  outline: none;\n  border-color: var(--border-focus);\n  box-shadow: 0 0 0 3px var(--accent-glow), var(--card-top);\n}\n\n@media (prefers-color-scheme: light) {\n  .completion-action select {\n    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='rgba(0%2C0%2C0%2C0.45)' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");\n  }\n}\n`;

  write(files.css, `${text.trimEnd()}${css}`);
}

function verifyPatch() {
  const expectations = [
    [
      files.settingsHook,
      "const [outputDirectory, setOutputDirectory]",
      "output folder state",
    ],
    [files.settingsHook, "setCompletionAction", "completion action state"],
    [files.ipc, "export function copyFileToClipboard", "clipboard IPC wrapper"],
    [files.app, "const chooseOutputDirectory", "folder picker callback"],
    [
      files.app,
      "<CompletionActionIcon action={completionAction} />",
      "completion action icon",
    ],
    [
      files.app,
      "await copyFileToClipboard(outputPath);",
      "clipboard completion behavior",
    ],
    [files.css, ".output-folder-row", "output controls CSS"],
    [
      files.rustSettings,
      "pub output_directory: Option<String>",
      "Rust output setting",
    ],
    [
      files.rustFiles,
      "pub async fn copy_file_to_clipboard",
      "Rust clipboard command",
    ],
    [
      files.rustFiles,
      "output_directory: Option<String>",
      "custom directory command argument",
    ],
    [files.rustLib, "copy_file_to_clipboard, get_os", "Rust command import"],
    [
      files.rustLib,
      "        copy_file_to_clipboard,",
      "Tauri command registration",
    ],
  ];

  for (const [filename, needle, label] of expectations) {
    if (!read(filename).includes(needle)) {
      throw new Error(`Verification failed: missing ${label} in ${filename}.`);
    }
  }

  if (
    read(files.ipc).includes(
      "resolveOutputPath(inputPath: string): Promise<string>",
    )
  ) {
    throw new Error(
      "Verification failed: the old resolveOutputPath signature is still present.",
    );
  }
}

const backups = new Map(
  Object.values(files)
    .filter((candidate) => candidate !== files.packageJson)
    .map((candidate) => [candidate, fs.readFileSync(candidate)]),
);

try {
  patchSettingsHook();
  patchIpc();
  patchRustSettings();
  patchRustFiles();
  patchRustLib();
  patchApp();
  patchCss();
  verifyPatch();
} catch (error) {
  for (const [filename, contents] of backups) {
    fs.writeFileSync(filename, contents);
  }
  throw error;
}

console.log(
  "Applied and verified Vidcord 6.7 output-folder and completion-action changes.",
);
