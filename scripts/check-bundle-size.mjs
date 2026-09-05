import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const assetDir = path.join("dist", "assets");
const limits = {
  // The browser edition adds the local FFmpeg WebAssembly loader and a separate
  // export UI while keeping the desktop app in lazy chunks.
  // The hosted editor mirrors the native trim controls, including editable time labels,
  // history, loop playback, and the lossless-trim status affordance.
  // The root page includes the complete desktop story below the browser editor,
  // so its copy and comparison details are intentionally part of the hosted bundle.
  // 7.4 adds browser GIF parity, semantic settings migration, and snap/zoom/pan trim controls;
  // keep a small explicit allowance for those user-visible capabilities and the deferred
  // browser-export module boundary.
  // Abortable loading, read-only file mounts, separate GIF palette passes, and
  // batch failure recovery add a small amount of code while bounding runtime memory/work.
  javascriptRaw: 488 * 1024,
  // gzip output varies slightly between the supported Node/zlib versions used locally and in CI.
  // Keep a small cross-runtime margin while retaining the tight raw-byte guard above.
  javascriptGzip: 152 * 1024,
  // The browser editor also carries the integrated desktop feature story, responsive layout,
  // and the platform-aware download/architecture-choice surfaces.
  cssGzip: 18.5 * 1024,
};

if (!fs.existsSync(assetDir)) {
  throw new Error("dist/assets is missing; run npm run build before bundle:check");
}

const files = fs
  .readdirSync(assetDir)
  .filter((name) => name.endsWith(".js") || name.endsWith(".css"));

const browserEntry = files.find((name) => /^WebApp-.*\.js$/.test(name));
if (!browserEntry) throw new Error("the browser editor chunk is missing");
const browserEntrySource = fs.readFileSync(path.join(assetDir, browserEntry), "utf8");
if (/@ffmpeg\/|ffmpeg-core|\.wasm/.test(browserEntrySource)) {
  throw new Error("the initial browser editor chunk contains deferred FFmpeg/WASM assets");
}

function totalSize(extension, gzip) {
  return files
    .filter((name) => name.endsWith(extension))
    .reduce((total, name) => {
      const bytes = fs.readFileSync(path.join(assetDir, name));
      return total + (gzip ? zlib.gzipSync(bytes).length : bytes.length);
    }, 0);
}

const sizes = {
  javascriptRaw: totalSize(".js", false),
  javascriptGzip: totalSize(".js", true),
  cssGzip: totalSize(".css", true),
};

for (const [name, value] of Object.entries(sizes)) {
  if (value > limits[name]) {
    throw new Error(
      `${name} is ${(value / 1024).toFixed(1)} KiB; budget is ${(limits[name] / 1024).toFixed(1)} KiB`
    );
  }
}

console.log(
  `bundle sizes ok: JS ${(sizes.javascriptRaw / 1024).toFixed(1)} KiB raw / ${(
    sizes.javascriptGzip / 1024
  ).toFixed(1)} KiB gzip; CSS ${(sizes.cssGzip / 1024).toFixed(1)} KiB gzip`
);
