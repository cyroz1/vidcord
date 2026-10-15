import fs from "node:fs";

// The desktop video-extension set is declared in several places that must
// agree, or a file the picker offers can fail preview/import (and vice
// versa). This check compares every desktop copy it can read:
//   - src-tauri/tauri.conf.json bundle.fileAssociations ("Video")
//   - src-tauri/tauri.conf.json assetProtocol scope extensions, but only
//     while the static scope is non-empty (the scope is normally empty:
//     preview access is granted per selection at runtime)
//   - src/App.tsx SUPPORTED_VIDEO_EXTENSION regex and every dialog
//     filter list named "Video"
//   - src-tauri/src/commands/files.rs VIDEO_EXTENSIONS
// The browser edition's wider set in src/web/webMedia.ts is intentionally
// out of scope: the browser picker accepts formats the desktop pipeline
// does not promise to preview or encode.
function fail(message) {
  throw new Error(`video extension sets out of sync: ${message}`);
}

function normalize(extensions) {
  return [...new Set(extensions.map((ext) => ext.toLowerCase().replace(/^\./, "")))].sort();
}

function expectSame(label, extensions, referenceLabel, reference) {
  const actual = normalize(extensions);
  if (actual.join(",") !== reference.join(",")) {
    fail(`${label} has [${actual.join(", ")}], but ${referenceLabel} has [${reference.join(", ")}]`);
  }
  return actual;
}

const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const videoAssociation = (config.bundle?.fileAssociations ?? []).find(
  (association) => association.name === "Video"
);
if (!videoAssociation || !Array.isArray(videoAssociation.ext) || videoAssociation.ext.length === 0) {
  fail("tauri.conf.json has no Video fileAssociations extension list to compare against");
}
const referenceLabel = "tauri.conf.json fileAssociations";
const reference = normalize(videoAssociation.ext);

const scope = config.app?.security?.assetProtocol?.scope ?? [];
if (scope.length > 0) {
  const scopeExtensions = scope
    .map((pattern) => pattern.match(/\.([a-z0-9]+)$/i)?.[1])
    .filter(Boolean);
  if (scopeExtensions.length !== scope.length) {
    fail("assetProtocol scope contains a pattern with no video extension to compare");
  }
  expectSame("tauri.conf.json assetProtocol scope", scopeExtensions, referenceLabel, reference);
}

const appSource = fs.readFileSync("src/App.tsx", "utf8");
const supportedRegex = appSource.match(/SUPPORTED_VIDEO_EXTENSION\s*=\s*\/\\\.\(([^)]+)\)\$\/i/);
if (!supportedRegex) {
  fail("src/App.tsx SUPPORTED_VIDEO_EXTENSION regex not found (renamed or reshaped?)");
}
expectSame(
  "src/App.tsx SUPPORTED_VIDEO_EXTENSION",
  supportedRegex[1].split("|"),
  referenceLabel,
  reference
);

// Only the filters named "Video" carry the import/save video set; other
// named filters (PNG snapshots, GIF output) are single-format by design.
const dialogLists = [
  ...appSource.matchAll(/name:\s*"Video",\s*extensions:\s*\[([^\]]+)\]/g),
].map((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
if (dialogLists.length === 0) {
  fail("src/App.tsx has no \"Video\" dialog extensions list to compare");
}
dialogLists.forEach((extensions, index) => {
  expectSame(`src/App.tsx dialog extensions list #${index + 1}`, extensions, referenceLabel, reference);
});

const filesSource = fs.readFileSync("src-tauri/src/commands/files.rs", "utf8");
const rustList = filesSource.match(/VIDEO_EXTENSIONS:\s*&\[&str\]\s*=\s*&\[([^\]]+)\]/);
if (!rustList) {
  fail("src-tauri/src/commands/files.rs VIDEO_EXTENSIONS list not found (renamed or reshaped?)");
}
expectSame(
  "src-tauri/src/commands/files.rs VIDEO_EXTENSIONS",
  [...rustList[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
  referenceLabel,
  reference
);

console.log(
  `video extension sets ok: [${reference.join(", ")}] agree across fileAssociations, ` +
    `${scope.length > 0 ? "assetProtocol scope, " : ""}src/App.tsx, and commands/files.rs`
);
