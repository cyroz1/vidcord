import fs from "node:fs";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function expectMatch(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} is ${actual || "<missing>"}; expected ${expected}`);
  }
}

function matchFile(path, pattern, label) {
  const text = fs.readFileSync(path, "utf8");
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not find ${label} in ${path}`);
  return match[1];
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const expected = packageJson.version;

expectMatch("package-lock.json root version", packageLock.version, expected);
expectMatch("package-lock.json package version", packageLock.packages?.[""]?.version, expected);
expectMatch(
  "src-tauri/Cargo.toml version",
  matchFile("src-tauri/Cargo.toml", /^version = "([^"]+)"/m, "Cargo.toml package version"),
  expected
);
expectMatch(
  "src-tauri/Cargo.lock vidcord version",
  matchFile(
    "src-tauri/Cargo.lock",
    /\[\[package\]\]\r?\nname = "vidcord"\r?\nversion = "([^"]+)"/,
    "Cargo.lock vidcord version"
  ),
  expected
);
expectMatch(
  "src-tauri/tauri.conf.json version",
  readJson("src-tauri/tauri.conf.json").version,
  expected
);

const html = fs.readFileSync("site/index.html", "utf8");
const jsonLdBlocks = [
  ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
].map((match) => JSON.parse(match[1]));
const software = jsonLdBlocks
  .flatMap((block) => (Array.isArray(block["@graph"]) ? block["@graph"] : [block]))
  .find((node) => node["@type"] === "SoftwareApplication");
expectMatch("site JSON-LD softwareVersion", software?.softwareVersion, expected);

const llmsVersion = matchFile(
  "site/llms-full.txt",
  /Current website-referenced app version: ([^\n]+)/,
  "llms-full version"
).trim();
expectMatch("site/llms-full.txt version", llmsVersion, expected);

console.log(`version alignment ok: ${expected}`);
