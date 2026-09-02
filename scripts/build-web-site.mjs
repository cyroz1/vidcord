import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as prettier from "prettier";

const siteDirectory = path.resolve("site");
const stagingDirectory = path.join(siteDirectory, ".browser-build");
const staleAppDirectory = path.join(siteDirectory, "app");
const viteCommand = process.platform === "win32" ? "vite.cmd" : "vite";
const publishedEntries = ["assets", "icon.png", "index.html"];

function normalizeGeneratedText(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      normalizeGeneratedText(entryPath);
    } else if (/\.(?:css|html|js)$/.test(entry.name)) {
      const source = fs.readFileSync(entryPath, "utf8");
      const normalized = source.replace(/[ \t]+$/gm, "");

      if (normalized !== source) {
        fs.writeFileSync(entryPath, normalized);
      }
    }
  }
}

function compressWasmAssets(directory) {
  let compressedCount = 0;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      compressedCount += compressWasmAssets(entryPath);
    } else if (entry.name.endsWith(".wasm")) {
      const compressedPath = `${entryPath}.gz`;
      const compressed = gzipSync(fs.readFileSync(entryPath), { level: 9, mtime: 0 });
      fs.writeFileSync(compressedPath, compressed);
      fs.rmSync(entryPath);
      compressedCount += 1;
    }
  }

  return compressedCount;
}

async function formatGeneratedIndex(directory) {
  const entryPath = path.join(directory, "index.html");
  const source = fs.readFileSync(entryPath, "utf8");
  const marketingStylesheet =
    '    <link rel="stylesheet" href="/marketing.css" data-vidcord-marketing-styles="true" />';
  const sourceWithMarketingStylesheet = source.includes('href="/marketing.css"')
    ? source
    : source.replace("  </head>", `${marketingStylesheet}\n  </head>`);
  const config = (await prettier.resolveConfig(entryPath)) ?? {};
  const formatted = await prettier.format(sourceWithMarketingStylesheet, {
    ...config,
    filepath: entryPath,
  });

  if (formatted !== sourceWithMarketingStylesheet) {
    fs.writeFileSync(entryPath, formatted);
  }
}

fs.rmSync(stagingDirectory, { recursive: true, force: true });

try {
  execFileSync(
    viteCommand,
    ["build", "--outDir", "site/.browser-build", "--base", "/", "--emptyOutDir"],
    { stdio: "inherit" }
  );
  normalizeGeneratedText(stagingDirectory);
  await formatGeneratedIndex(stagingDirectory);
  if (compressWasmAssets(stagingDirectory) === 0) {
    throw new Error("Browser build did not produce a WebAssembly encoder asset");
  }

  for (const entry of publishedEntries) {
    const source = path.join(stagingDirectory, entry);
    const destination = path.join(siteDirectory, entry);

    if (!fs.existsSync(source)) {
      throw new Error(`Browser build did not produce site/${entry}`);
    }

    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
  }

  fs.rmSync(staleAppDirectory, { recursive: true, force: true });
} finally {
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
}
