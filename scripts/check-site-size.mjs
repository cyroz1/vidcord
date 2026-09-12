import fs from "node:fs";
import path from "node:path";

const siteDirectory = path.resolve("site");
const maximumAssetBytes = 25 * 1024 * 1024;
const oversizedFiles = [];

function inspectDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      inspectDirectory(entryPath);
      continue;
    }

    const size = fs.statSync(entryPath).size;
    if (size > maximumAssetBytes) {
      oversizedFiles.push({ path: path.relative(process.cwd(), entryPath), size });
    }
  }
}

if (!fs.existsSync(siteDirectory)) {
  throw new Error("site/ is missing; run npm run web:build before site:check");
}

inspectDirectory(siteDirectory);

if (oversizedFiles.length > 0) {
  const details = oversizedFiles
    .map(({ path: filePath, size }) => `${filePath} is ${(size / 1024 / 1024).toFixed(1)} MiB`)
    .join(", ");
  throw new Error(`Site assets exceed Cloudflare's 25 MiB per-file limit: ${details}`);
}

console.log("site asset sizes ok: every file is at most 25 MiB");
