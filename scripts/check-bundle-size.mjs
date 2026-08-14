import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const assetDir = path.join("dist", "assets");
const limits = {
  // Advanced audio-track controls and the multi-file batch queue add compact
  // user-gesture/event-driven export controls.
  javascriptRaw: 275 * 1024,
  javascriptGzip: 90 * 1024,
  // The track popup and batch queue add compact list and status styles.
  cssGzip: 8 * 1024,
};

if (!fs.existsSync(assetDir)) {
  throw new Error("dist/assets is missing; run npm run build before bundle:check");
}

const files = fs
  .readdirSync(assetDir)
  .filter((name) => name.endsWith(".js") || name.endsWith(".css"));

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
