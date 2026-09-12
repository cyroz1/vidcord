import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const siteDirectory = path.resolve("site");
const assetsDirectory = path.join(siteDirectory, "assets");
const wasmPattern = /^ffmpeg-core-[^/]+\.wasm\.gz$/;
const generatedAssets = fs.readdirSync(assetsDirectory).filter((name) => wasmPattern.test(name));

if (generatedAssets.length !== 1) {
  throw new Error(
    `expected one generated FFmpeg WebAssembly asset, found ${generatedAssets.length}`
  );
}

const generatedPath = `site/assets/${generatedAssets[0]}`;
const trackedAssets = execFileSync("git", ["ls-files", "--", "site/assets/ffmpeg-core-*.wasm.gz"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

if (trackedAssets.length !== 1 || trackedAssets[0] !== generatedPath) {
  throw new Error(
    `generated FFmpeg WebAssembly asset path is stale: expected ${generatedPath}, tracked ${
      trackedAssets.join(", ") || "none"
    }`
  );
}

const generatedWasm = zlib.gunzipSync(fs.readFileSync(path.join(process.cwd(), generatedPath)));
const committedGzip = execFileSync("git", ["show", `HEAD:${generatedPath}`], {
  maxBuffer: 32 * 1024 * 1024,
});
const committedWasm = zlib.gunzipSync(committedGzip);

if (!generatedWasm.equals(committedWasm)) {
  throw new Error(`generated FFmpeg WebAssembly content differs from ${generatedPath}`);
}

console.log("generated site verified: FFmpeg WebAssembly content is current");
