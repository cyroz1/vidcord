#!/usr/bin/env node
// Prunes the GStreamer payload that Tauri's `bundleMediaFramework` sweeps
// into the Linux AppImage. The bundled closure is the whole distro GStreamer
// installation (every plugin the build machine happens to have, plus their
// private libraries), but the WebView only needs media *playback*: demuxers,
// parsers, decoders, converters, and sinks. This script keeps a fixed
// playback plugin set, computes the shared-library closure those plugins and
// the rest of the payload actually reference, and deletes everything else
// from the two directories it owns: the top-level library pool in usr/lib and
// the plugin directory usr/lib/gstreamer-1.0. Nothing is modified in place —
// files are only deleted — so every surviving byte is the distro's own.
//
// The deletion is verified before the script exits: the closure is recomputed
// on the pruned tree and the script fails (so CI fails instead of shipping a
// broken bundle) if any library reference that resolved before pruning no
// longer resolves, or if anything prunable survived.
//
// Usage: node scripts/prune-appimage.mjs <extracted-appdir>

import { lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: prune-appimage.mjs <extracted-appdir>");
  process.exit(2);
}
const absRoot = realpathSync(root);
const POOL_DIR = path.join(absRoot, "usr", "lib");
const PLUGIN_DIR = path.join(POOL_DIR, "gstreamer-1.0");

// GStreamer plugins WebKitGTK playback can use: pipeline plumbing, demuxers,
// parsers, and decoders for the formats browsers play (MP4/H.264+AAC,
// WebM/VP8/VP9/Opus, Ogg/Theora/Vorbis, MP3, FLAC, WAV, AVI, FLV, MPEG-TS/PS),
// plus the libav bridge (FFmpeg decoders) and hardware decode via VA-API.
// Encoding, capture, visualisation, network streaming servers, and niche
// codec plugins stay out.
const KEEP_PLUGINS = new Set(
  `libgstcoreelements.so libgstplayback.so libgsttypefindfunctions.so
   libgstapp.so libgstautodetect.so libgstgio.so libgstpbtypes.so
   libgstaudioconvert.so libgstaudiorate.so libgstaudioresample.so
   libgstaudiomixer.so libgstadder.so libgstvolume.so
   libgstvideoconvert.so libgstvideoscale.so libgstvideorate.so
   libgstvideofilter.so
   libgstisomp4.so libgstmatroska.so libgstogg.so libgstavi.so libgstflv.so
   libgstmpegpsdemux.so libgstmpegtsdemux.so libgstwavparse.so
   libgsticydemux.so libgstid3demux.so libgstauparse.so libgstapetag.so
   libgstalaw.so libgstmulaw.so
   libgstvideoparsersbad.so libgstaudioparsers.so libgstivfparse.so
   libgstlibav.so libgstvpx.so libgstopus.so libgstvorbis.so libgsttheora.so
   libgstflac.so libgstjpeg.so libgstpng.so libgstpulseaudio.so libgstsoup.so
   libgstva.so`
    .split(/\s+/)
    .filter(Boolean)
);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// Minimal ELF dynamic-section reader: returns { needed, soname } for ELF
// files, null for anything else. Little-endian 32/64-bit only, which covers
// every payload this project ships (x86_64 and aarch64 AppImages).
function elfDynamicInfo(file) {
  const buf = readFileSync(file);
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    return null;
  }
  const is64 = buf[4] === 2;
  if (buf[5] !== 1) return null; // not little-endian
  const phoff = is64 ? Number(buf.readBigUInt64LE(0x20)) : buf.readUInt32LE(0x14);
  const phentsize = buf.readUInt16LE(is64 ? 0x36 : 0x2a);
  const phnum = buf.readUInt16LE(is64 ? 0x38 : 0x2c);
  const loads = [];
  let dynOff = -1;
  let dynSize = 0;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const type = buf.readUInt32LE(o);
    if (type === 1) {
      loads.push({
        off: is64 ? Number(buf.readBigUInt64LE(o + 8)) : buf.readUInt32LE(o + 4),
        vaddr: is64 ? Number(buf.readBigUInt64LE(o + 16)) : buf.readUInt32LE(o + 8),
        filesz: is64 ? Number(buf.readBigUInt64LE(o + 32)) : buf.readUInt32LE(o + 16),
      });
    } else if (type === 2) {
      dynOff = is64 ? Number(buf.readBigUInt64LE(o + 8)) : buf.readUInt32LE(o + 4);
      dynSize = is64 ? Number(buf.readBigUInt64LE(o + 32)) : buf.readUInt32LE(o + 16);
    }
  }
  if (dynOff < 0) return { needed: [], soname: null };
  const vaddrToOff = (addr) => {
    for (const seg of loads) {
      if (addr >= seg.vaddr && addr < seg.vaddr + seg.filesz) return seg.off + (addr - seg.vaddr);
    }
    return -1;
  };
  let strtabAddr = -1;
  const neededOffs = [];
  let sonameOff = -1;
  const stride = is64 ? 16 : 8;
  for (let o = dynOff; o < dynOff + dynSize; o += stride) {
    const tag = is64 ? Number(buf.readBigInt64LE(o)) : buf.readInt32LE(o);
    const val = is64 ? Number(buf.readBigUInt64LE(o + 8)) : buf.readUInt32LE(o + 4);
    if (tag === 0) break;
    if (tag === 5) strtabAddr = val;
    else if (tag === 1) neededOffs.push(val);
    else if (tag === 14) sonameOff = val;
  }
  if (strtabAddr < 0) return { needed: [], soname: null };
  const strtabOff = vaddrToOff(strtabAddr);
  if (strtabOff < 0) return { needed: [], soname: null };
  const readStr = (off) => {
    const start = strtabOff + off;
    const end = buf.indexOf(0, start);
    return buf.toString("utf8", start, end < 0 ? buf.length : end);
  };
  return {
    needed: neededOffs.map(readStr),
    soname: sonameOff >= 0 ? readStr(sonameOff) : null,
  };
}

function computeClosure() {
  const files = listFiles(absRoot);
  const infos = new Map();
  const sonameMap = new Map();
  const linkTargetByName = new Map();
  for (const p of files) {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      try {
        linkTargetByName.set(path.basename(p), realpathSync(p));
      } catch {
        // Dangling symlink: nothing to resolve to.
      }
      continue;
    }
    if (!st.isFile()) continue;
    const info = elfDynamicInfo(p);
    if (!info) continue;
    infos.set(p, info);
    if (info.soname) {
      if (!sonameMap.has(info.soname)) sonameMap.set(info.soname, []);
      sonameMap.get(info.soname).push(p);
    }
  }
  const roots = new Set();
  for (const p of infos.keys()) {
    const dir = path.dirname(p);
    const rel = path.relative(absRoot, p);
    if (dir === absRoot || rel.startsWith(`usr${path.sep}bin${path.sep}`)) {
      roots.add(p);
    } else if (dir === PLUGIN_DIR) {
      if (KEEP_PLUGINS.has(path.basename(p))) roots.add(p);
    } else if (dir !== POOL_DIR && rel.startsWith(`usr${path.sep}lib${path.sep}`)) {
      roots.add(p); // Module subdirectories (GTK, WebKit, GIO, ...) stay whole.
    }
  }
  const closure = new Set(roots);
  const missing = new Set();
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop();
    for (const need of infos.get(cur).needed) {
      const targets = [...(sonameMap.get(need) ?? [])];
      const viaLink = linkTargetByName.get(need);
      if (viaLink) targets.push(viaLink);
      if (!targets.length) {
        // Resolved by the host system at runtime (libc, libGL, ...). The
        // pre/post comparison below is what keeps this honest: pruning must
        // never add to this set.
        missing.add(need);
        continue;
      }
      for (const t of targets) {
        if (infos.has(t) && !closure.has(t)) {
          closure.add(t);
          stack.push(t);
        }
      }
    }
  }
  return { closure, missing, infos };
}

const before = computeClosure();
let removed = 0;
let removedBytes = 0;
for (const p of before.infos.keys()) {
  const dir = path.dirname(p);
  if ((dir === POOL_DIR || dir === PLUGIN_DIR) && !before.closure.has(p)) {
    removedBytes += lstatSync(p).size;
    unlinkSync(p);
    removed++;
  }
}
// Drop symlinks in the pruned directories whose targets were just deleted.
for (const dir of [POOL_DIR, PLUGIN_DIR]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const p = path.join(dir, entry.name);
    try {
      realpathSync(p);
    } catch {
      unlinkSync(p);
    }
  }
}

const after = computeClosure();
const newlyMissing = [...after.missing].filter((s) => !before.missing.has(s));
if (newlyMissing.length) {
  console.error(`prune failed: references no longer resolve: ${newlyMissing.join(", ")}`);
  process.exit(1);
}
const leftovers = [...after.infos.keys()].filter((p) => {
  const dir = path.dirname(p);
  return (dir === POOL_DIR || dir === PLUGIN_DIR) && !after.closure.has(p);
});
if (leftovers.length) {
  console.error(`prune failed: ${leftovers.length} prunable files survived`);
  process.exit(1);
}
console.log(
  `AppImage payload pruned: removed ${removed} unused GStreamer libraries/plugins ` +
    `(${(removedBytes / 1e6).toFixed(1)} MB of file data).`
);
