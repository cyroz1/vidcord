import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  assertGifOutput,
  assertLosslessOutput,
  assertPngOutput,
  assertVideoOutput,
} from "../../scripts/e2e/media.mjs";

const root = process.env.VIDCORD_E2E_ROOT;
const sampleA = process.env.VIDCORD_E2E_SAMPLE_A;
const sampleB = process.env.VIDCORD_E2E_SAMPLE_B;
const outputDirectory = process.env.VIDCORD_E2E_OUTPUTS;
const artifactsDirectory = process.env.VIDCORD_E2E_ARTIFACTS;

test("browser demo controls, all export modes, batch, and real output files", async ({ page }) => {
  test.setTimeout(12 * 60 * 1000);
  expect(root).toBeTruthy();
  expect(sampleA).toBeTruthy();
  expect(sampleB).toBeTruthy();
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(artifactsDirectory, { recursive: true });

  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route(/https:\/\/(api\.github\.com|img\.shields\.io)\/.*/, (route) => route.abort());
  await page.goto("/");
  await expect(page).toHaveTitle(/vidcord/i);
  await expect(page.getByRole("heading", { name: "vidcord", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Web Demo", exact: true }).click();
  await expect(page).toHaveURL(/#web-editor$/);
  await expect(
    page.getByRole("heading", { name: "Compress a file quickly in your browser." })
  ).toBeVisible();

  const input = page.locator('input[type="file"]');
  await input.setInputFiles(sampleA);
  await expect(
    page.getByRole("button", { name: "Change selected video, sample-a.mp4" })
  ).toBeVisible();
  await expect
    .poll(() => page.locator("video").evaluate((video) => video.readyState))
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator(".web-preview-time-overlay")).toContainText("6.0s");

  // Exercise the preview and snapshot actions against a real decoded frame.
  const playButton = page.getByRole("button", { name: "Play trim segment" });
  const previewFrame = page.locator(".web-preview-frame");
  await previewFrame.scrollIntoViewIfNeeded();
  await previewFrame.hover({ position: { x: 24, y: 24 } });
  await playButton.click();
  await expect(page.getByRole("button", { name: "Stop preview" })).toBeVisible();
  await page.getByRole("button", { name: "Stop preview" }).click();
  const snapshotDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download a PNG snapshot of the current frame" }).click();
  const snapshotDownload = await snapshotDownloadPromise;
  const snapshotPath = path.join(outputDirectory, "browser-snapshot.png");
  await snapshotDownload.saveAs(snapshotPath);
  assertPngOutput(snapshotPath);

  // Standard Compress controls, including reversible audio toggles.
  await page.getByLabel("Discord target").selectOption({ index: 1 });
  await page.getByLabel("Crop").first().selectOption({ index: 1 });
  await page.getByLabel("FPS").first().selectOption("off");
  const mute = page.getByRole("button", { name: "Mute audio" });
  await mute.click();
  await expect(page.getByRole("button", { name: "Unmute audio" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.getByRole("button", { name: "Unmute audio" }).click();
  const normalize = page.getByRole("button", { name: "Peak-normalize audio to 0 dB" });
  await normalize.click();
  await expect(normalize).toHaveAttribute("aria-pressed", "true");
  await normalize.click();
  const compressPath = path.join(outputDirectory, "browser-compress.mp4");
  await exportAndSave(page, compressPath, { pageErrors, consoleErrors });
  const compressed = assertVideoOutput(compressPath, { minDuration: 5, maxDuration: 7 });
  expect(compressed.video.codec_name).toBe("h264");
  expect(compressed.audio?.codec_name).toBe("aac");

  // Advanced settings and the timeline history/precision controls.
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel("Size (MB)").fill("0.5");
  await page.getByLabel("Resolution").selectOption("480p");
  await page.getByLabel("Crop").selectOption({ index: 1 });
  await page.getByLabel("FPS").fill("24");
  await page.getByLabel("FPS").press("Tab");
  await page.getByLabel("Trim start time").fill("1");
  await page.getByLabel("Trim start time").press("Enter");
  await page.getByLabel("Trim end time").fill("4");
  await page.getByLabel("Trim end time").press("Enter");
  await expect(page.getByRole("button", { name: "Undo trim" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo trim" }).click();
  await expect(page.getByRole("button", { name: "Redo trim" })).toBeEnabled();
  await page.getByRole("button", { name: "Redo trim" }).click();

  const seekTimeline = page.getByRole("button", { name: "Seek video timeline" });
  const timelineBounds = await seekTimeline.boundingBox();
  expect(timelineBounds).not.toBeNull();
  const startHandle = page.getByRole("slider", { name: "Trim start" });
  const endHandle = page.getByRole("slider", { name: "Trim end" });
  await seekTimeline.click({
    position: { x: timelineBounds.width * 0.55, y: timelineBounds.height / 2 },
  });
  await page.getByRole("button", { name: "In", exact: true }).click();
  await expect.poll(async () => Number(await startHandle.inputValue())).toBeGreaterThan(3);
  await seekTimeline.click({
    position: { x: timelineBounds.width * 0.75, y: timelineBounds.height / 2 },
  });
  await page.getByRole("button", { name: "Out", exact: true }).click();
  await expect.poll(async () => Number(await endHandle.inputValue())).toBeGreaterThan(4);
  await page.getByLabel("Trim start time").fill("1");
  await page.getByLabel("Trim start time").press("Enter");
  await page.getByLabel("Trim end time").fill("4");
  await page.getByLabel("Trim end time").press("Enter");

  const loop = page.getByRole("button", { name: "Loop trim playback" });
  await loop.click();
  await expect(loop).toHaveAttribute("aria-pressed", "true");
  await loop.click();
  await page.getByRole("button", { name: "More trim options" }).click();
  const timelineOptions = page.getByRole("dialog", { name: "More trim options" });
  await expect(timelineOptions).toBeVisible();
  const timeFormat = page.getByRole("button", {
    name: "Show timeline times as hours, minutes, and seconds",
  });
  await expect(timeFormat).toBeVisible();
  await timeFormat.click();
  await expect(timeFormat).toHaveAttribute("aria-pressed", "true");
  await timeFormat.click();
  await expect(timeFormat).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("Timeline snap interval").selectOption("0.5");
  await page.getByRole("button", { name: "Zoom timeline in" }).click();
  await page.getByRole("button", { name: "Zoom timeline in" }).click();
  await page.getByRole("button", { name: "Zoom timeline out" }).click();
  await page.getByRole("button", { name: "Reset timeline zoom to 1x" }).click();
  const optionsButton = page.getByRole("button", { name: "More trim options" });
  await page.keyboard.press("Escape");
  await expect(optionsButton).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("?");
  await expect(optionsButton).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(optionsButton).toHaveAttribute("aria-expanded", "false");

  const advancedPath = path.join(outputDirectory, "browser-advanced.mp4");
  await exportAndSave(page, advancedPath, { pageErrors, consoleErrors });
  const advanced = assertVideoOutput(advancedPath, { minDuration: 2, maxDuration: 4 });
  expect(advanced.video.codec_name).toBe("h264");
  expect(advanced.audio?.codec_name).toBe("aac");
  expect(advanced.duration).toBeLessThan(compressed.duration);

  // Lossless Trim must preserve the source codec, copy audio, and honor keyframes.
  await page.getByRole("button", { name: "Lossless Trim", exact: true }).click();
  const removeLosslessAudio = page.getByRole("button", { name: "Remove audio tracks" });
  await removeLosslessAudio.click();
  await expect(page.getByRole("button", { name: "Keep audio" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.getByRole("button", { name: "Keep audio" }).click();
  const losslessPath = path.join(outputDirectory, "browser-lossless.mp4");
  await exportAndSave(page, losslessPath, { pageErrors, consoleErrors });
  const lossless = assertLosslessOutput(losslessPath, { minDuration: 2, maxDuration: 4.5 });
  expect(lossless.audio?.codec_name).toBe("aac");

  // GIF target, frame-rate, crop selectors, and actual animated output.
  await page.getByRole("button", { name: "GIF", exact: true }).click();
  await page.getByLabel("Target size").selectOption("5");
  await page.getByLabel("FPS").selectOption("15");
  await page.getByLabel("Crop").selectOption({ index: 0 });
  const gifPath = path.join(outputDirectory, "browser-gif.gif");
  await exportAndSave(page, gifPath, { pageErrors, consoleErrors, timeoutMs: 45_000 });
  assertGifOutput(gifPath, { minDuration: 2, maxDuration: 4 });

  // Batch queue selection, ordering, removal, import, and exports for both clips.
  await input.setInputFiles([sampleA, sampleB]);
  await expect(page.getByRole("button", { name: "Move sample-a.mp4 down in queue" })).toBeVisible();
  await page.getByRole("button", { name: "Move sample-b.mp4 up in queue" }).click();
  await expect(page.locator(".web-queue-name")).toHaveText(["sample-b.mp4", "sample-a.mp4"]);
  await page.getByRole("button", { name: "Move sample-b.mp4 down in queue" }).click();
  await page.getByRole("button", { name: "Remove sample-b.mp4 from queue" }).click();
  await expect(page.locator(".web-queue-name")).toHaveCount(0);
  await input.setInputFiles([sampleA, sampleB]);
  await expect(page.getByRole("button", { name: "Export 2 videos" })).toBeVisible();
  const batchDownloads = Promise.all([
    page.waitForEvent("download", { timeout: 240_000 }),
    page.waitForEvent("download", { timeout: 240_000 }),
  ]);
  await page.getByRole("button", { name: "Export 2 videos" }).click();
  const [batchDownloadA, batchDownloadB] = await batchDownloads;
  const batchPaths = [
    path.join(outputDirectory, "browser-batch-a.mp4"),
    path.join(outputDirectory, "browser-batch-b.mp4"),
  ];
  await Promise.all([batchDownloadA.saveAs(batchPaths[0]), batchDownloadB.saveAs(batchPaths[1])]);
  for (const batchPath of batchPaths) {
    const batchOutput = assertVideoOutput(batchPath, { minDuration: 5, maxDuration: 7 });
    expect(batchOutput.video.codec_name).toBe("h264");
  }
  await expect(page.locator(".web-export-button")).toHaveText("Export 2 videos", {
    timeout: 60_000,
  });

  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter((message) => !message.startsWith("Failed to load resource:"))
  ).toEqual([]);
  await page.screenshot({
    path: path.join(artifactsDirectory, "web-demo-success.png"),
    fullPage: true,
  });
});

async function exportAndSave(
  page,
  outputPath,
  { pageErrors = [], consoleErrors = [], timeoutMs = 240_000 } = {}
) {
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
  await page.locator(".web-export-button").click();
  let download;
  try {
    download = await Promise.race([
      downloadPromise,
      page
        .waitForFunction(
          () =>
            document.querySelector(".web-progress-line")?.textContent?.includes("Export failed"),
          null,
          { timeout: timeoutMs }
        )
        .then(async () => {
          const notice = await page
            .locator(".web-notice")
            .textContent()
            .catch(() => "<none>");
          throw new Error(`The UI reported an export failure before the download: ${notice}`);
        }),
    ]);
  } catch (error) {
    const diagnostics = {
      progress: await page
        .locator(".web-progress-line")
        .innerText()
        .catch(() => "<unavailable>"),
      exportButton: await page
        .locator(".web-export-button")
        .innerText()
        .catch(() => "<unavailable>"),
      notice: await page
        .locator(".web-notice")
        .innerText()
        .catch(() => "<none>"),
      pageErrors,
      consoleErrors,
    };
    throw new Error(
      `${error.message}\nBrowser export diagnostics: ${JSON.stringify(diagnostics, null, 2)}`
    );
  }
  await download.saveAs(outputPath);
  await expect(page.locator(".web-export-button")).toBeVisible();
}
