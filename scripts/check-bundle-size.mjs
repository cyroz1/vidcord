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
  // limitation disclosures; keep the raw budget below 0.52 MiB while allowing that public copy.
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
  // long workflows. Playback time and the trim playhead now update without rerendering the editor;
  // allow 1 KiB for that event path and use the route budgets below to guard initial loads.
  // The target-size accuracy tuning (undersize correction and efficiency-aware bitrate targeting
  // in the web export planner) adds a small amount of export code; allow 1 KiB for it.
  // The target-size refinement (best-fit output tracking, sibling-file refinement passes,
  // and refinement failure fallbacks) adds a little more; allow 1 KiB for it.
  // The in-app bug-report dialog (desktop footer button, accessible dialog, log
  // collection) and the website feedback section (form posting to the same
  // report endpoint) add user-visible reporting UI to both editions; allow
  // 7 KiB for them.
  // The browser encoder stall watchdog (loud failure + worker teardown instead
  // of parking exports at 100% on "Continuing…"), the one automatic stall
  // retry, and the mobile x264 preset add a small amount of export code;
  // allow 2 KiB for them.
  // Complete 7.6 release details on the integrated home page add about 1 KiB of
  // user-facing copy across both desktop and browser workflows.
  // Paused-frame snapshots keep stopped playback visually stable in both previews;
  // allow 1 KiB for the shared capture and overlay path.
  javascriptRaw: 526 * 1024,
  // gzip output varies slightly between the supported Node/zlib versions used locally and in CI.
  // Keep 1 KiB of cross-runtime margin while retaining the tight raw-byte guard above.
  // The donate footer link and website support section add a shared links module plus
  // small footer/section markup; allow 1 KiB for them.
  // The preview play-button fix adds a little more; allow 1 KiB for it.
  // 7.5's per-pass progress/ETA and preview-clip audio add a little more; allow 1 KiB for them.
  // 7.6 adds recursive folder imports and queue controls; allow 2 KiB for their compressed code.
  // The direct playback updates add a small amount of compressed code without per-frame React work.
  // The in-app bug-report dialog and website feedback section add reporting UI
  // to both editions; allow 2 KiB for their compressed code.
  // Complete 7.6 release details add about 0.2 KiB compressed; allow for the copy
  // while keeping 1 KiB of cross-runtime margin.
  javascriptGzip: 165 * 1024,
  // The browser editor also carries the integrated desktop feature story, responsive layout,
  // and the platform-aware download/architecture-choice surfaces.
  cssGzip: 18.5 * 1024,
  // This includes the shared entry shell plus the desktop route loaded
  // immediately on launch. There is no browser-route budget here: the
  // browser chunks are pruned from the desktop dist this checker runs
  // against (and hard-fail above if present); the hosted browser bundle
  // is built and size-checked separately by the site pipeline.
  desktopEntryGzip: 110 * 1024,
};

if (!fs.existsSync(assetDir)) {
  throw new Error("dist/assets is missing; run npm run build before bundle:check");
}

// The 31 MiB FFmpeg WebAssembly binary is browser-edition only and must
// never be part of the desktop dist that Tauri embeds (see
// scripts/prune-desktop-dist.mjs, which `npm run build` runs).
const wasmAssets = fs.readdirSync(assetDir).filter((name) => /\.wasm(?:\.gz)?$/.test(name));
if (wasmAssets.length > 0) {
  throw new Error(
    `desktop dist contains browser-only WebAssembly asset(s): ${wasmAssets.join(", ")}`
  );
}

const files = fs
  .readdirSync(assetDir)
  .filter((name) => name.endsWith(".js") || name.endsWith(".css"));

// The deferred FFmpeg loader and its class worker are browser-only and are
// pruned from the desktop dist. Their presence here means the check is
// running against an unpruned `vite build` output (or the prune regressed),
// so fail hard instead of excluding them from the totals: the budgets below
// cover exactly the JS/CSS the desktop dist ships.
const ffmpegLoaderAssets = files.filter((name) => /^(?:ffmpeg-core|worker)-.*\.js$/.test(name));
if (ffmpegLoaderAssets.length > 0) {
  throw new Error(
    `desktop dist contains browser-only FFmpeg loader asset(s): ${ffmpegLoaderAssets.join(", ")}`
  );
}

// The browser route (WebApp/WebEditor and its export/progress helpers) is
// likewise pruned from the desktop dist: src/main.tsx mounts it only
// outside Tauri. Leftover chunks mean the prune missed them.
const browserChunks = files.filter((name) =>
  /^(?:WebApp|WebEditor|browserExport|browserProgress)-.*\.(?:js|css)$/.test(name)
);
if (browserChunks.length > 0) {
  throw new Error(
    `desktop dist contains browser-route-only chunk(s): ${browserChunks.join(", ")}`
  );
}

const desktopEntry = files.find((name) => /^App-.*\.js$/.test(name));
if (!desktopEntry) throw new Error("the desktop app chunk is missing");
const rootEntry = files.find((name) => /^index-.*\.js$/.test(name));
if (!rootEntry) throw new Error("the root application chunk is missing");

function totalSize(extension, gzip) {
  return files
    .filter((name) => name.endsWith(extension))
    .reduce((total, name) => {
      const bytes = fs.readFileSync(path.join(assetDir, name));
      return total + (gzip ? zlib.gzipSync(bytes).length : bytes.length);
    }, 0);
}

function routeSize(entry, routePrefix, gzip) {
  const visited = new Set();

  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(path.join(assetDir, file), "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      if (!match[1].startsWith(".")) continue;
      const dependency = path.basename(path.resolve(assetDir, path.dirname(file), match[1]));
      if (dependency.endsWith(".js") && fs.existsSync(path.join(assetDir, dependency))) {
        visit(dependency);
      }
    }
  }

  visit(rootEntry);
  visit(entry);

  const cssEntries = files.filter(
    (file) => file.endsWith(".css") && (file.startsWith("index-") || file.startsWith(routePrefix))
  );
  const routeFiles = [...visited, ...cssEntries];

  return routeFiles.reduce((total, file) => {
    const bytes = fs.readFileSync(path.join(assetDir, file));
    return total + (gzip ? zlib.gzipSync(bytes).length : bytes.length);
  }, 0);
}

const sizes = {
  javascriptRaw: totalSize(".js", false),
  javascriptGzip: totalSize(".js", true),
  cssGzip: totalSize(".css", true),
  desktopEntryGzip: routeSize(desktopEntry, "App-", true),
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
  ).toFixed(1)} KiB gzip; CSS ${(sizes.cssGzip / 1024).toFixed(1)} KiB gzip; desktop route ${(
    sizes.desktopEntryGzip / 1024
  ).toFixed(1)} KiB gzip`
);
