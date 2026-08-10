import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const assetDir = path.join("dist", "assets");
const limits = {
  // Advanced audio-track controls add a compact, user-gesture-only popup.
  javascriptRaw: 250 * 1024,
  javascriptGzip: 81 * 1024,
  // The track popup adds its compact list, checkbox, and light-mode styles.
  cssGzip: 7 * 1024,
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
