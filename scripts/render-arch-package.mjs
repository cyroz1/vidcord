import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [version, releaseTag, artifactDirectory, outputDirectory] = process.argv.slice(2);
if (!version || !releaseTag || !artifactDirectory || !outputDirectory) {
  fail(
    "Usage: node scripts/render-arch-package.mjs <app-version> <release-tag> <artifact-dir> <output-dir>"
  );
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`Invalid package version: ${version}`);
}
if (!/^\d+\.\d+(?:\.\d+)?$/.test(releaseTag)) {
  fail(`Invalid release tag version: ${releaseTag}`);
}
const majorMinor = version.split(".").slice(0, 2).join(".");
if (releaseTag !== version && releaseTag !== majorMinor) {
  fail(`Release tag ${releaseTag} does not match app version ${version}`);
}

const readAsset = async (name) => {
  try {
    return await readFile(path.join(artifactDirectory, name));
  } catch {
    fail(`Missing release package: ${name}`);
  }
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const x64Hash = sha256(await readAsset(`vidcord_${version}_amd64.deb`));
const license = await readFile("LICENSE");
const template = await readFile("packaging/arch/PKGBUILD.template", "utf8");
const pkgbuild = template
  .replaceAll("__VERSION__", version)
  .replaceAll("__TAG__", releaseTag)
  .replace("__LICENSE_SHA256__", sha256(license))
  .replace("__AMD64_SHA256__", x64Hash);

if (/__[A-Z0-9_]+__/.test(pkgbuild)) {
  fail("Arch PKGBUILD template contains an unexpanded placeholder");
}

const packageDirectory = outputDirectory;
await mkdir(packageDirectory, { recursive: true });
await writeFile(path.join(packageDirectory, "PKGBUILD"), pkgbuild);
await writeFile(path.join(packageDirectory, "LICENSE"), license);
await cp("packaging/arch/vidcord-bin.install", path.join(packageDirectory, "vidcord-bin.install"));

const sourceRoot = `https://github.com/cyroz1/vidcord/releases/download/v${releaseTag}`;
const dependencies = [
  "cairo",
  "desktop-file-utils",
  "ffmpeg",
  "gdk-pixbuf2",
  "glib2",
  "gtk3",
  "hicolor-icon-theme",
  "libsoup",
  "pango",
  "webkit2gtk-4.1",
  "gst-plugins-base-libs",
  "gst-plugins-base",
  "gst-plugins-good",
  "gst-plugins-bad",
  "gst-libav",
];
const srcinfo = [
  "pkgbase = vidcord-bin",
  "\tpkgdesc = Local video compression app for Discord",
  `\tpkgver = ${version}`,
  "\tpkgrel = 1",
  "\turl = https://vidcord.app/",
  "\tinstall = vidcord-bin.install",
  "\tarch = x86_64",
  "\tlicense = MIT",
  "\toptions = !strip",
  "\toptions = !emptydirs",
  ...dependencies.map((dependency) => `\tdepends = ${dependency}`),
  "\tsource = LICENSE",
  `\tsource_x86_64 = vidcord_${version}_amd64.deb::${sourceRoot}/vidcord_${version}_amd64.deb`,
  `\tsha256sums = ${sha256(license)}`,
  `\tsha256sums_x86_64 = ${x64Hash}`,
  "pkgname = vidcord-bin",
  "",
].join("\n");
await writeFile(path.join(packageDirectory, ".SRCINFO"), srcinfo);
