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
  // Reorderable queues and selective retry controls add a bounded amount of UI/runtime code
  // to both the native and hosted batch workflows.
  // The v7.5 hosted root also carries the explicit mobile/no-install positioning and browser
  // limitation disclosures; keep the raw budget below 0.5 MiB while allowing that public copy.
  // v7.5 also routes H.264/HEVC 4:2:2+ sources through the FFmpeg preview path on macOS
  // (VideoToolbox corrupts those pixel formats instead of erroring); allow 1 KiB for it.
  // The donate footer link and website support section add a shared links module plus
  // small footer/section markup; allow 1 KiB for them.
  // The preview play-button fix (generating spinner, re-entrancy guard, error toast)
  // adds a little more; allow 1 KiB for it.
  // The deferred editor adds a small lazy module-loader boundary; allow 1 KiB for that wrapper.
  // 7.5's editor also keeps its per-pass progress/ETA tracking and the Support section,
  // and the generated preview clips now carry audio; allow 3 KiB for those 7.5-only additions.
  // The 1 GB native-resolution Discord target adds a preset entry, label, and quality-clamp
  // update to both the desktop app and the browser demo; allow 1 KiB for it.
  // v7.6 adds a persisted close-after-export setting and native app-exit wiring; allow 1 KiB for it.
  // Recursive folder imports, skipped-file reporting, and clear-queue controls add a small amount
  // of native app UI and selection logic; allow 4 KiB for those v7.6 additions.
  // Browser encoder warmup, large-export memory confirmation, and import-scan feedback improve
  // long workflows; keep raw JavaScript within the 0.5 MiB ceiling with no additional headroom.
  javascriptRaw: 512 * 1024,
  // gzip output varies slightly between the supported Node/zlib versions used locally and in CI.
  // Keep 1 KiB of cross-runtime margin while retaining the tight raw-byte guard above.
  // The donate footer link and website support section add a shared links module plus
  // small footer/section markup; allow 1 KiB for them.
  // The preview play-button fix adds a little more; allow 1 KiB for it.
  // 7.5's per-pass progress/ETA and preview-clip audio add a little more; allow 1 KiB for them.
  // 7.6 adds recursive folder imports and queue controls; allow 2 KiB for their compressed code.
  javascriptGzip: 161 * 1024,
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
