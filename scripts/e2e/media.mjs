import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

export function generateFixtures(directory) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  mkdirSync(directory, { recursive: true });
  const fixtures = [
    {
      path: path.join(directory, "sample-a.mp4"),
      video: "testsrc2=duration=6:size=320x180:rate=30",
      audio: "sine=frequency=440:sample_rate=44100:duration=6",
    },
    {
      path: path.join(directory, "sample-b.mp4"),
      video: "color=c=blue:s=320x180:r=30:d=6",
      audio: "sine=frequency=660:sample_rate=44100:duration=6",
    },
  ];

  for (const fixture of fixtures) {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        fixture.video,
        "-f",
        "lavfi",
        "-i",
        fixture.audio,
        "-t",
        "6",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        fixture.path,
      ],
      { stdio: "inherit" }
    );
  }

  return fixtures.map((fixture) => fixture.path);
}

export function probeMedia(filePath) {
  assert.ok(existsSync(filePath), `Expected output file to exist: ${filePath}`);
  assert.ok(statSync(filePath).size > 128, `Output is unexpectedly small: ${filePath}`);
  const output = execFileSync(
    process.env.FFPROBE_PATH || "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  const streams = result.streams || [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    path: filePath,
    bytes: statSync(filePath).size,
    format: result.format?.format_name ?? "",
    duration: Number(result.format?.duration ?? 0),
    video,
    audio,
  };
}

export function assertVideoOutput(filePath, { minDuration = 0.5, maxDuration = 7 } = {}) {
  const media = probeMedia(filePath);
  assert.ok(media.video, `Expected a video stream in ${filePath}`);
  assert.ok(media.video.width >= 16 && media.video.height >= 16, "Video dimensions are valid");
  assert.ok(
    media.duration >= minDuration,
    `Expected duration >= ${minDuration}s, got ${media.duration}s`
  );
  assert.ok(
    media.duration <= maxDuration,
    `Expected duration <= ${maxDuration}s, got ${media.duration}s`
  );
  return media;
}

export function assertGifOutput(filePath, { minDuration = 0.5, maxDuration = 7 } = {}) {
  const media = assertVideoOutput(filePath, { minDuration, maxDuration });
  assert.match(media.format, /gif/i, `Expected GIF container, got ${media.format}`);
  assert.equal(media.video.codec_name, "gif");
  return media;
}

export function assertLosslessOutput(
  filePath,
  { minDuration = 0.5, maxDuration = 7, audio = true } = {}
) {
  const media = assertVideoOutput(filePath, { minDuration, maxDuration });
  assert.equal(media.video.codec_name, "h264", "Lossless Trim should copy the H.264 video stream");
  assert.equal(
    Boolean(media.audio),
    audio,
    "Lossless Trim audio stream matches the selected audio setting"
  );
  return media;
}

export function assertPngOutput(filePath) {
  assert.ok(existsSync(filePath), `Expected snapshot file to exist: ${filePath}`);
  const signature = Buffer.alloc(8);
  const handle = openSync(filePath, "r");
  readSync(handle, signature, 0, signature.length, 0);
  closeSync(handle);
  assert.equal(signature.toString("hex"), "89504e470d0a1a0a", "Snapshot is a PNG image");
}

export function findOutputs(directory, { extension, since = 0 } = {}) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
    .filter(
      (filePath) =>
        (!extension || path.extname(filePath).toLowerCase() === extension) &&
        statSync(filePath).mtimeMs >= since
    )
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
  return files;
}
