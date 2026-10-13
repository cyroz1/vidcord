import fs from "node:fs";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const locked = lock.packages?.["node_modules/@tauri-apps/cli"];
const expectedVersion = "2.11.5";
const ciLock = JSON.parse(fs.readFileSync("tools/tauri-cli/package-lock.json", "utf8"));
const ciManifest = JSON.parse(fs.readFileSync("tools/tauri-cli/package.json", "utf8"));
const ciLocked = ciLock.packages?.["node_modules/@tauri-apps/cli"];

if (locked?.version !== expectedVersion || typeof locked.integrity !== "string") {
  throw new Error(
    `package-lock.json must pin @tauri-apps/cli ${expectedVersion} with an integrity hash`
  );
}

if (
  ciManifest.devDependencies?.["@tauri-apps/cli"] !== locked.version ||
  ciLocked?.version !== locked.version ||
  ciLocked.integrity !== locked.integrity ||
  ciLocked.resolved !== locked.resolved
) {
  throw new Error(
    "tools/tauri-cli must lock the same @tauri-apps/cli package as package-lock.json"
  );
}

for (const name of Object.keys(locked.optionalDependencies ?? {})) {
  const rootEntry = lock.packages?.[`node_modules/${name}`];
  const ciEntry = ciLock.packages?.[`node_modules/${name}`];
  if (
    !rootEntry ||
    ciEntry?.version !== rootEntry.version ||
    ciEntry.integrity !== rootEntry.integrity ||
    ciEntry.resolved !== rootEntry.resolved
  ) {
    throw new Error(`tools/tauri-cli lock is missing the matching optional package ${name}`);
  }
}

const installed = JSON.parse(
  fs.readFileSync("tools/tauri-cli/node_modules/@tauri-apps/cli/package.json", "utf8")
);
if (installed.version !== locked.version) {
  throw new Error(`installed @tauri-apps/cli is ${installed.version}; expected ${locked.version}`);
}

console.log(`locked Tauri CLI verified: ${installed.version} (${locked.integrity})`);
