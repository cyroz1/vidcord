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
  let sourceWithMarketingStylesheet = source.includes('href="/marketing.css"')
    ? source
    : source.replace("  </head>", `${marketingStylesheet}\n  </head>`);
  // The browser root is lazy in the shared desktop entry. Discover its static
  // dependencies from Vite so the hosted page can request them alongside the
  // entry script, without preloading the on-demand encoder or desktop app.
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, ".vite/manifest.json"), "utf8"));
  const hints = [];
  const visited = new Set();
  const hinted = new Set();
  const addHint = (file, rel) => {
    const href = `/${file}`;
    if (
      !hinted.has(href) &&
      !sourceWithMarketingStylesheet.includes(`href="${href}"`) &&
      !sourceWithMarketingStylesheet.includes(`src="${href}"`)
    ) {
      hinted.add(href);
      hints.push(`    <link rel="${rel}" href="${href}" crossorigin />`);
    }
  };
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing browser manifest entry: ${key}`);
    addHint(chunk.file, "modulepreload");
    for (const css of chunk.css ?? []) addHint(css, "stylesheet");
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  visit("src/web/WebApp.tsx");
  hints.push(`    <link rel="preload" as="image" type="image/webp" fetchpriority="high"
    imagesrcset="/marketing-assets/window-480.webp 480w, /marketing-assets/window-720.webp 720w, /marketing-assets/window-960.webp 960w, /marketing-assets/window-1144.webp 1144w"
    imagesizes="(max-width: 760px) calc(100vw - 36px), (max-width: 1040px) 560px, 500px" />`);
  sourceWithMarketingStylesheet = sourceWithMarketingStylesheet.replace(
    "  </head>",
    `${hints.join("\n")}\n  </head>`
  );
  // A tab icon should not fetch the 80 KiB social/app logo. Keep the shared
  // desktop entry and social metadata intact; the hosted site has a 32px icon.
  sourceWithMarketingStylesheet = sourceWithMarketingStylesheet.replace(
    'href="/icon.png"',
    'href="/marketing-assets/icon-32.png" sizes="32x32"'
  );
  const config = (await prettier.resolveConfig(entryPath)) ?? {};
  const formatted = await prettier.format(sourceWithMarketingStylesheet, {
    ...config,
    filepath: entryPath,
  });

  if (formatted !== source) {
    fs.writeFileSync(entryPath, formatted);
  }
}

fs.rmSync(stagingDirectory, { recursive: true, force: true });

try {
  execFileSync(
    viteCommand,
    ["build", "--outDir", "site/.browser-build", "--base", "/", "--emptyOutDir", "--manifest"],
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
