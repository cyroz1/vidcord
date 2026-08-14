import fs from "node:fs";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const locked = lock.packages?.["node_modules/@tauri-apps/cli"];
const expectedVersion = "2.10.1";

if (locked?.version !== expectedVersion || typeof locked.integrity !== "string") {
  throw new Error(
    `package-lock.json must pin @tauri-apps/cli ${expectedVersion} with an integrity hash`
  );
}

const installed = JSON.parse(fs.readFileSync("node_modules/@tauri-apps/cli/package.json", "utf8"));
if (installed.version !== locked.version) {
  throw new Error(`installed @tauri-apps/cli is ${installed.version}; expected ${locked.version}`);
}

console.log(`locked Tauri CLI verified: ${installed.version} (${locked.integrity})`);
