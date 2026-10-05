import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertGifOutput,
  assertLosslessOutput,
  assertPngOutput,
  assertVideoOutput,
} from "../../scripts/e2e/media.mjs";

const sampleA = process.env.VIDCORD_E2E_SAMPLE_A;
const batchInputs = process.env.VIDCORD_E2E_INPUTS;
const outputDirectory = process.env.VIDCORD_E2E_OUTPUTS;
const artifactsDirectory = process.env.VIDCORD_E2E_ARTIFACTS;

describe("vidcord desktop end-to-end workflow", function () {
  it("tests controls, every export mode, batch queue, and real native outputs", async function () {
    this.timeout(12 * 60 * 1000);
    assert.ok(sampleA, "sample video fixture was not configured");
    assert.ok(batchInputs, "batch fixture directory was not configured");
    mkdirSync(outputDirectory, { recursive: true });
    mkdirSync(artifactsDirectory, { recursive: true });

    const compressFromAskPath = path.join(outputDirectory, "desktop-compress-ask.mp4");
    await setTauriDialogMocks(
      [[sampleA], outputDirectory, [batchInputs], [batchInputs]],
      [path.join(outputDirectory, "desktop-snapshot.png"), compressFromAskPath]
    );

    await waitForDisplayed(".drop-zone");
    await browser.$(".drop-zone").click();
    await browser.$(".loaded-file-card").waitForDisplayed({ timeout: 60_000 });
    await browser.waitUntil(async () => await browser.$(".compress-btn").isEnabled(), {
      timeout: 60_000,
      timeoutMsg: "The imported sample video did not finish probing",
    });
    assert.match(await browser.$(".loaded-file-card").getText(), /sample-a\.mp4/);
    console.log("Desktop E2E: sample imported and probed");

    // Every desktop mode selector remains reachable before a file is exported.
    for (const mode of ["Advanced", "Lossless Trim", "GIF", "Compress"]) {
      await clickMode(mode);
      assert.equal(await selectedMode(), mode);
    }
    console.log("Desktop E2E: all desktop modes switch");

    // Exercise all output destination and completion controls. The one native
    // save dialog used below is intercepted by the E2E dialog bridge and still publishes through
    // the actual Rust staged-output path.
    const outputSelect = await browser.$("#output-destination-select");
    console.log("Desktop E2E: output starts at", await outputSelect.getValue());
    await outputSelect.selectByAttribute("value", "custom");
    console.log(
      "Desktop E2E: custom folder chooser returned",
      await browser.execute(() => window.__VIDCORD_E2E_DIALOGS__?.openQueue.length)
    );
    await browser.waitUntil(async () => (await outputSelect.getValue()) === "custom", {
      timeout: 60_000,
      timeoutMsg: "The output destination did not switch to the custom folder option",
    });
    await outputSelect.selectByAttribute("value", "downloads");
    assert.equal(await outputSelect.getValue(), "downloads");
    await outputSelect.selectByAttribute("value", "source");
    assert.equal(await outputSelect.getValue(), "source");
    await outputSelect.selectByAttribute("value", "ask");
    assert.equal(await outputSelect.getValue(), "ask");

    const completionSelect = await browser.$("#completion-action-select");
    for (const action of ["copy", "reveal", "none"]) {
      await completionSelect.selectByAttribute("value", action);
      assert.equal(await completionSelect.getValue(), action);
    }
    const closeAfterExport = await browser.$(".output-close-toggle input");
    await closeAfterExport.click();
    assert.equal(await closeAfterExport.isSelected(), true);
    await closeAfterExport.click();
    assert.equal(await closeAfterExport.isSelected(), false);
    console.log("Desktop E2E: output and completion controls");

    // Named preset save, restore, and delete paths.
    await selectLabel("Crop", "select").then((crop) => crop.selectByAttribute("value", "1:1"));
    const presetSelect = await browser.$('select[aria-label="Settings preset"]');
    await presetSelect.selectByAttribute("value", "save");
    await browser.$('input[aria-label="Preset name"]').setValue("E2E control preset");
    await browser.$("button.preset-save-button").click();
    await browser.waitUntil(async () => {
      const optionTexts = await browser.execute(() =>
        Array.from(document.querySelectorAll('select[aria-label="Settings preset"] option')).map(
          (option) => option.textContent?.trim()
        )
      );
      return optionTexts.includes("E2E control preset");
    });
    await selectLabel("Crop", "select").then((crop) => crop.selectByAttribute("value", "off"));
    await presetSelect.selectByVisibleText("E2E control preset");
    await browser.waitUntil(
      async () => (await (await selectLabel("Crop", "select")).getValue()) === "1:1"
    );
    await browser.$('button[aria-label="Delete preset E2E control preset"]').click();
    console.log("Desktop E2E: settings preset save, restore, and delete");

    // Advanced audio mixer and the live encoder dialog both run against the
    // real desktop backend and system FFmpeg installation.
    await clickMode("Advanced");
    const audioSettingsButton = await browser.$('button[aria-label$="open audio settings"]');
    await audioSettingsButton.click();
    const audioDialog = await browser.$('[role="dialog"][aria-label="Audio settings"]');
    await audioDialog.waitForDisplayed();
    const audioChecks = await audioDialog.$$('input[type="checkbox"]');
    const initialMute = await audioChecks[0].isSelected();
    await audioChecks[0].click();
    assert.equal(await audioChecks[0].isSelected(), !initialMute);
    await audioChecks[0].click();
    assert.equal(await audioChecks[0].isSelected(), initialMute);
    const initialNormalize = await audioChecks[1].isSelected();
    await audioChecks[1].click();
    assert.equal(await audioChecks[1].isSelected(), !initialNormalize);
    await audioChecks[1].click();
    assert.equal(await audioChecks[1].isSelected(), initialNormalize);
    const selectAllLabel = await audioDialog.$(".audio-track-select-all span");
    const initialSelectAllLabel = (await selectAllLabel.getText()).trim();
    await audioChecks[2].click();
    await browser.waitUntil(
      async () => (await selectAllLabel.getText()).trim() !== initialSelectAllLabel,
      { timeout: 10_000, timeoutMsg: "Select all tracks did not toggle its label" }
    );
    const toggledSelectAllLabel = (await selectAllLabel.getText()).trim();
    await audioChecks[2].click();
    await browser.waitUntil(
      async () => (await selectAllLabel.getText()).trim() === initialSelectAllLabel,
      { timeout: 10_000, timeoutMsg: "Select all tracks did not restore its initial state" }
    );
    assert.notEqual(toggledSelectAllLabel, initialSelectAllLabel);
    await browser.$('button[aria-label="Close audio settings"]').click();
    console.log("Desktop E2E: audio track settings");

    await browser.$('button[aria-label="Show FFmpeg encoders"]').click();
    await browser.$('[role="dialog"][aria-labelledby="encoders-dialog-title"]').waitForDisplayed();
    assert.match(
      await browser.$('[aria-label="Available FFmpeg video encoders"]').getText(),
      /libx264/i
    );
    await browser.$('button[aria-label="Close FFmpeg video encoders"]').click();
    console.log("Desktop E2E: encoder dialog");

    // Check the native playback control is available on platforms where the
    // WebKit/GStreamer surface exposes it. Browser playback is exercised above.
    if (process.platform !== "linux") {
      assert.equal(await browser.$('button[aria-label="Play trim segment"]').isEnabled(), true);
    }

    // Exercise the real FFmpeg snapshot action and confirm its PNG signature.
    const pngCountBefore = fileSet(outputDirectory, ".png");
    await browser.$('button[aria-label="Capture frame snapshot to clipboard"]').click();
    const snapshotPath = await waitForNewOutput(outputDirectory, pngCountBefore, ".png");
    assertPngOutput(snapshotPath);
    console.log("Desktop E2E: preview snapshot output");

    // Test the standard Compress mode, crop/FPS/audio toggles, and the native
    // Ask-when-done save/publish flow.
    await clickMode("Compress");
    const quality = await browser.$("label.target-label select");
    await quality.selectByIndex(1);
    await selectLabel("Crop", "select").then((crop) => crop.selectByAttribute("value", "1:1"));
    await selectLabel("FPS", "select").then((fps) => fps.selectByAttribute("value", "24"));
    const mute = await browser.$('button[aria-label="Mute audio"]');
    await mute.click();
    const unmute = await browser.$('button[aria-label="Unmute audio"]');
    assert.match(await unmute.getAttribute("class"), /active/);
    await browser.$('button[aria-label="Unmute audio"]').click();
    const normalize = await browser.$('button[aria-label="Peak-normalize audio to 0 dB"]');
    await normalize.click();
    assert.match(await normalize.getAttribute("class"), /active/);
    await normalize.click();

    const outputBeforeAsk = fileSet(outputDirectory, ".mp4");
    await startExport(outputBeforeAsk, outputDirectory, ".mp4");
    assert.ok(
      statSync(compressFromAskPath).size > 128,
      "Ask when done published its selected MP4 path"
    );
    const compressed = assertVideoOutput(compressFromAskPath, { minDuration: 5, maxDuration: 7 });
    assert.equal(compressed.video.codec_name, "h264");
    assert.equal(compressed.audio?.codec_name, "aac");
    assertRatio(compressed.video, 1);
    assertFrameRate(compressed.video, 24);
    console.log("Desktop E2E: standard compression output verified");

    // Advanced mode writes beside its source, trims to the selected range,
    // and applies its size, resolution, crop, frame-rate, and encoder controls.
    await outputSelect.selectByAttribute("value", "source");
    await clickMode("Advanced");
    await labeledControl("Size (MB)", "input").then((input) => input.setValue("0.5"));
    await selectLabel("Resolution", "select").then((resolution) =>
      resolution.selectByVisibleText("480p")
    );
    await selectLabel("Crop", "select").then((crop) => crop.selectByAttribute("value", "1:1"));
    await labeledControl("FPS", "input").then((fps) => fps.setValue("24"));
    await setTrimRange("1", "4");
    await exerciseTrimToolbar();
    await setTrimRange("1", "4");

    const advancedBefore = fileSet(path.dirname(sampleA), ".mp4");
    await startExport(advancedBefore, path.dirname(sampleA), ".mp4");
    const advancedPath = newestOutput(path.dirname(sampleA), advancedBefore, ".mp4");
    const advanced = assertVideoOutput(advancedPath, { minDuration: 2, maxDuration: 4 });
    assert.equal(advanced.video.codec_name, "h264");
    assertRatio(advanced.video, 1);
    assertFrameRate(advanced.video, 24);
    console.log("Desktop E2E: advanced output verified");

    // Lossless Trim must preserve the compressed source stream and audio.
    await outputSelect.selectByAttribute("value", "custom");
    await clickMode("Lossless Trim");
    const removeAudio = await browser.$('button[aria-label="Remove all audio tracks"]');
    await removeAudio.click();
    assert.equal(
      await browser.$('button[aria-label="Keep audio tracks"]').getAttribute("aria-pressed"),
      "true"
    );
    await browser.$('button[aria-label="Keep audio tracks"]').click();
    const losslessBefore = fileSet(outputDirectory, ".mp4");
    await startExport(losslessBefore, outputDirectory, ".mp4");
    const losslessPath = newestOutput(outputDirectory, losslessBefore, ".mp4");
    const lossless = assertLosslessOutput(losslessPath, { minDuration: 2, maxDuration: 4.5 });
    assert.equal(lossless.audio?.codec_name, "aac");
    console.log("Desktop E2E: lossless output verified");

    // GIF settings and an actual animated GIF, not just a mode-switch check.
    await clickMode("GIF");
    await selectLabel("Target size", "select").then((target) => target.selectByIndex(0));
    await selectLabel("FPS", "select").then((fps) => fps.selectByAttribute("value", "15"));
    await selectLabel("Crop", "select").then((crop) => crop.selectByAttribute("value", "1:1"));
    const gifBefore = fileSet(outputDirectory, ".gif");
    await startExport(gifBefore, outputDirectory, ".gif");
    const gifPath = newestOutput(outputDirectory, gifBefore, ".gif");
    const gif = assertGifOutput(gifPath, { minDuration: 2, maxDuration: 4 });
    assertRatio(gif.video, 1);
    console.log("Desktop E2E: GIF output verified");

    // Folder import, batch trims, queue ordering/removal, real per-file export,
    // and clear-queue control.
    await browser.$('button[aria-label="Import videos from a folder"]').click();
    await waitForDisplayed(".batch-queue");
    await browser.waitUntil(async () => (await browser.$$(".batch-queue-name")).length === 2, {
      timeout: 60_000,
      timeoutMsg: "The batch queue did not list both imported videos",
    });
    const moveSampleBUp = await browser.$('button[aria-label="Move sample-b.mp4 up in queue"]');
    await browser.waitUntil(async () => await moveSampleBUp.isEnabled(), {
      timeout: 60_000,
      timeoutMsg: "The folder scan did not enable batch queue ordering",
    });
    await moveSampleBUp.click();
    await browser.waitUntil(async () => (await queueNames())[0] === "sample-b.mp4", {
      timeout: 60_000,
      timeoutMsg: "The batch queue did not move sample-b.mp4 to the top",
    });
    await browser.$('button[aria-label="Move sample-b.mp4 down in queue"]').click();
    await browser.waitUntil(async () => (await queueNames())[0] === "sample-a.mp4", {
      timeout: 60_000,
      timeoutMsg: "The batch queue did not move sample-a.mp4 back to the top",
    });
    await browser.$('button[aria-label="Remove sample-b.mp4 from queue"]').click();
    await browser.$(".batch-queue").waitForDisplayed({ reverse: true });
    await browser.$('button[aria-label="Import videos from a folder"]').click();
    await waitForDisplayed(".batch-queue");
    await browser.waitUntil(async () => (await browser.$$(".batch-queue-name")).length === 2, {
      timeout: 60_000,
      timeoutMsg: "The batch queue did not list both imported videos",
    });

    await selectLabel("Trim from start (s)", "input").then((input) => input.setValue("0.5"));
    await selectLabel("Trim from end (s)", "input").then((input) => input.setValue("0.5"));
    const batchBefore = fileSet(outputDirectory, ".mp4");
    await startExport(batchBefore, outputDirectory, ".mp4", 2);
    const batchPaths = newOutputs(outputDirectory, batchBefore, ".mp4");
    assert.equal(batchPaths.length, 2, "Batch creates one MP4 for each selected clip");
    for (const batchPath of batchPaths) {
      const batch = assertVideoOutput(batchPath, { minDuration: 4, maxDuration: 6 });
      assert.equal(batch.video.codec_name, "h264");
    }
    console.log("Desktop E2E: batch outputs verified");

    await dismissAllToasts();
    await browser.saveScreenshot(path.join(artifactsDirectory, "desktop-e2e-success.png"));
    await browser.$('button[aria-label="Clear all videos from the queue"]').click();
    await browser.$(".batch-queue").waitForDisplayed({ reverse: true });
  });
});

async function clickMode(name) {
  const buttons = await browser.$$(".workflow-mode-selector button");
  for (const button of buttons) {
    if ((await button.getText()).trim() === name) {
      await button.scrollIntoView();
      await button.click();
      return;
    }
  }
  throw new Error(`Could not find export mode: ${name}`);
}

async function setTauriDialogMocks(openResults, saveResults) {
  await browser.waitUntil(
    async () => await browser.execute(() => typeof window.__VIDCORD_E2E_DIALOGS__ === "object"),
    { timeout: 30_000, timeoutMsg: "The E2E Tauri invoke bridge did not initialize" }
  );
  await browser.execute(
    ({ openResults: opens, saveResults: saves }) => {
      const openQueue = [...opens];
      const saveQueue = [...saves];
      window.__VIDCORD_E2E_DIALOGS__.openQueue = openQueue;
      window.__VIDCORD_E2E_DIALOGS__.saveQueue = saveQueue;
    },
    { openResults, saveResults }
  );
}

async function selectedMode() {
  const active = await browser.$('.workflow-mode-selector button[aria-pressed="true"]');
  return (await active.getText()).trim();
}

async function selectLabel(labelText, selector) {
  return labeledControl(labelText, selector);
}

async function labeledControl(labelText, selector) {
  const labels = await browser.$$("label");
  for (const label of labels) {
    const text = (await label.getText()).replace(/\s+/g, " ").trim();
    if (text === labelText || text.startsWith(labelText)) return label.$(selector);
  }
  throw new Error(`Could not find ${selector} for label ${labelText}`);
}

async function setTrimRange(start, end) {
  const startInput = await browser.$('input[aria-label="Trim start time"]');
  const endInput = await browser.$('input[aria-label="Trim end time"]');
  await commitTrimTime('input[aria-label="Trim start time"]', start);
  await browser.waitUntil(async () => (await startInput.getValue()).includes(`${start}.0`), {
    timeout: 10_000,
    timeoutMsg: `The trim start control did not commit ${start} seconds`,
  });
  await commitTrimTime('input[aria-label="Trim end time"]', end);
  await browser.waitUntil(async () => (await endInput.getValue()).includes(`${end}.0`), {
    timeout: 10_000,
    timeoutMsg: `The trim end control did not commit ${end} seconds`,
  });
  const expectedDuration = (Number(end) - Number(start)).toFixed(1);
  await browser.waitUntil(
    async () => (await browser.$(".trim-selection-meta").getText()).startsWith(expectedDuration),
    {
      timeout: 10_000,
      timeoutMsg: `The trim selection did not update to ${expectedDuration} seconds`,
    }
  );
}

async function commitTrimTime(selector, time) {
  await browser.execute(
    (inputSelector, value) => {
      const input = document.querySelector(inputSelector);
      if (!(input instanceof HTMLInputElement)) {
        throw new Error(`Missing trim time input: ${inputSelector}`);
      }
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    },
    selector,
    String(time)
  );
}

async function exerciseTrimToolbar() {
  const loop = await browser.$('button[aria-label="Loop trim playback"]');
  await loop.click();
  assert.equal(await loop.getAttribute("aria-pressed"), "true");
  await loop.click();
  await browser.$('button[aria-label="Undo trim"]').click();
  await browser.$('button[aria-label="Redo trim"]').click();
  await browser.$('button[aria-label="More trim options"]').click();
  await browser.$('[role="dialog"][aria-label="More trim options"]').waitForDisplayed();
  await (
    await browser.$('select[aria-label="Timeline snap interval"]')
  ).selectByAttribute("value", "0.5");
  await browser.$('button[aria-label="Zoom timeline in"]').click();
  await browser.$('button[aria-label="Reset timeline zoom to 1x"]').click();
  const timeLabels = await browser.$(
    'button[aria-label="Show timeline times as hours, minutes, and seconds"]'
  );
  await timeLabels.click();
  assert.equal(await timeLabels.getAttribute("aria-pressed"), "true");
  await timeLabels.click();
  await browser.$("summary").click();
  await browser.$('button[aria-label="More trim options"]').click();
}

async function startExport(before, directory, extension, expectedNewFiles = 1) {
  const exportButton = await browser.$(".compress-btn");
  await exportButton.scrollIntoView();
  await browser.waitUntil(async () => await exportButton.isEnabled(), {
    timeout: 60_000,
    timeoutMsg: `Export button remained disabled (${await exportButton.getAttribute(
      "data-e2e-disabled-reason"
    )})`,
  });
  console.log(
    "Desktop E2E: export button before click",
    await exportButton.getText(),
    "enabled:",
    await exportButton.isEnabled(),
    "disabled reason:",
    await exportButton.getAttribute("data-e2e-disabled-reason")
  );
  await exportButton.click();
  console.log("Desktop E2E: export button after click", await exportButton.getText());
  const action = await browser.$("button=Compress anyway");
  try {
    await browser.waitUntil(
      async () =>
        (await action.isDisplayed().catch(() => false)) ||
        newOutputs(directory, before, extension).filter((filePath) => statSync(filePath).size > 128)
          .length >= expectedNewFiles,
      { timeout: 20_000, timeoutMsg: "Export did not start or offer the Compress anyway action" }
    );
  } catch (error) {
    console.error(
      `Desktop E2E: files in expected output directory ${directory}:`,
      readdirSync(directory, { withFileTypes: true }).map((entry) => entry.name)
    );
    throw error;
  }
  if (await action.isDisplayed().catch(() => false)) await action.click();
  await browser.waitUntil(
    async () =>
      newOutputs(directory, before, extension).filter((filePath) => statSync(filePath).size > 128)
        .length >= expectedNewFiles,
    {
      timeout: 300_000,
      interval: 300,
      timeoutMsg: `Expected ${expectedNewFiles} finished ${extension} output(s)`,
    }
  );
  await browser.waitUntil(
    async () =>
      !["Cancel", "Saving Output..."].includes((await browser.$(".compress-btn").getText()).trim()),
    { timeout: 30_000, timeoutMsg: "Export UI did not return to its ready state" }
  );
}

async function waitForDisplayed(selector) {
  const element = await browser.$(selector);
  await element.waitForDisplayed({ timeout: 60_000 });
  return element;
}

async function dismissAllToasts() {
  for (let index = 0; index < 50; index += 1) {
    const dismissed = await browser.execute(() => {
      const button = document.querySelector('button[aria-label^="Dismiss "]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    });
    if (!dismissed) return;
  }
  throw new Error("The desktop UI did not dismiss all queued toast notifications");
}

function fileSet(directory, extension) {
  return new Set(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === extension)
      .map((entry) => path.join(directory, entry.name))
  );
}

function newOutputs(directory, before, extension) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === extension)
    .map((entry) => path.join(directory, entry.name))
    .filter((filePath) => !before.has(filePath))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
}

function newestOutput(directory, before, extension) {
  const outputs = newOutputs(directory, before, extension);
  assert.ok(outputs.length > 0, `No new ${extension} outputs appeared in ${directory}`);
  return outputs[outputs.length - 1];
}

async function waitForNewOutput(directory, before, extension) {
  await browser.waitUntil(
    async () =>
      newOutputs(directory, before, extension).some((filePath) => statSync(filePath).size > 128),
    { timeout: 30_000, timeoutMsg: `No new ${extension} output appeared` }
  );
  return newestOutput(directory, before, extension);
}

async function queueNames() {
  const names = await browser.$$(".batch-queue-name");
  return Promise.all(names.map((name) => name.getText()));
}

function assertRatio(video, expectedRatio) {
  const ratio = video.width / video.height;
  assert.ok(
    Math.abs(ratio - expectedRatio) < 0.04,
    `Expected aspect ratio ${expectedRatio}, got ${ratio}`
  );
}

function assertFrameRate(video, expected) {
  const [numerator, denominator = "1"] = video.avg_frame_rate.split("/");
  const frameRate = Number(numerator) / Number(denominator);
  assert.ok(Math.abs(frameRate - expected) < 1, `Expected ${expected} fps, got ${frameRate}`);
}
