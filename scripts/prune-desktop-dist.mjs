import fs from "node:fs";
import path from "node:path";

// The desktop app never loads the browser edition's FFmpeg WebAssembly
// encoder: it uses the system FFmpeg binary, and src/main.tsx only mounts
// the browser app outside Tauri. The hosted browser bundle is built
// separately by scripts/build-web-site.mjs, which invokes Vite directly
// (not `npm run build`), so pruning here cannot affect it: that build
// still emits the uncompressed .wasm, gzips it for publishing, and the
// browser engine keeps its uncompressed fallback for non-hosted use.
// This step runs after `vite build` as part of `npm run build`, which is
// also what the Tauri beforeBuildCommand and the CI frontend job run, so
// the dist/ that gets embedded never carries the encoder assets. The
// same applies to the browser-route chunks listed below, which the
// desktop entry never imports at runtime.
const assetDir = path.join("dist", "assets");
if (!fs.existsSync(assetDir)) {
  throw new Error("dist/assets is missing; run vite build before pruning the desktop dist");
}

const encoderAsset = /^(?:ffmpeg-core-.+|worker-.+)\.js$/;
// Browser-route-only chunks: src/main.tsx mounts WebApp only when
// __TAURI_INTERNALS__ is absent, so the desktop webview never loads the
// WebApp/WebEditor route or its browser export/progress helpers. The
// hosted browser bundle stages separately (scripts/build-web-site.mjs)
// and keeps all of them.
const browserChunk = /^(?:WebApp|WebEditor|browserExport|browserProgress)-.+\.(?:js|css)$/;
let removedBytes = 0;
let removedCount = 0;
for (const name of fs.readdirSync(assetDir)) {
  if (
    name.endsWith(".wasm") ||
    name.endsWith(".wasm.gz") ||
    encoderAsset.test(name) ||
    browserChunk.test(name)
  ) {
    removedBytes += fs.statSync(path.join(assetDir, name)).size;
    fs.rmSync(path.join(assetDir, name));
    removedCount += 1;
  }
}

// The desktop webview has no use for the entry document's SEO payload:
// strip the JSON-LD block and the crawler/social/manifest tags from the
// desktop copy only. The source index.html (and therefore the hosted
// site build, which re-runs Vite itself) keeps them untouched.
const indexPath = path.join("dist", "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const beforeBytes = Buffer.byteLength(html);
html = html
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/g, "")
  .replace(/<link[^>]+rel="(?:canonical|sitemap|alternate|manifest)"[^>]*>\s*/g, "")
  .replace(
    /<meta[^>]+(?:name="(?:robots|googlebot|description|application-name|apple-mobile-web-app-title)"|property="og:[^"]+"|name="twitter:[^"]+")[^>]*>\s*/g,
    ""
  );
fs.writeFileSync(indexPath, html);

console.log(
  `desktop dist pruned: removed ${removedCount} browser-only asset(s) (${(
    removedBytes /
    1024 /
    1024
  ).toFixed(1)} MiB) and ${((beforeBytes - Buffer.byteLength(html)) / 1024).toFixed(
    1
  )} KiB of SEO markup from dist/index.html`
);
