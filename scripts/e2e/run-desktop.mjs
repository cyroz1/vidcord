import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, Capabilities } from "selenium-webdriver";
import { createSeleniumBrowser } from "./selenium-browser.mjs";
import { generateFixtures } from "./media.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runDirectory = mkdtempSync(path.join(os.tmpdir(), "vidcord-desktop-e2e-"));
const artifactsDirectory =
  process.env.VIDCORD_E2E_ARTIFACTS || path.join(os.tmpdir(), "vidcord-e2e-artifacts", "desktop");
const appDataDirectory = path.join(runDirectory, "app-data");
mkdirSync(appDataDirectory, { recursive: true });
mkdirSync(artifactsDirectory, { recursive: true });

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repository,
    env: environment,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForWebDriver(port, application) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    if (application.exitCode !== null) {
      throw new Error(
        `The desktop app exited before WebDriver was ready (${application.exitCode})`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok && (await response.json()).value?.ready) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Tauri's embedded WebDriver did not become ready: ${lastError ?? "timeout"}`);
}

function registerSpec(testCases) {
  globalThis.describe = (_name, callback) => callback.call({ timeout() {} });
  globalThis.it = (name, callback) => testCases.push({ name, callback });
}

try {
  const [sampleA, sampleB] = generateFixtures(path.join(runDirectory, "inputs"));
  const batchInputsDirectory = path.join(runDirectory, "batch-inputs");
  mkdirSync(batchInputsDirectory, { recursive: true });
  copyFileSync(sampleA, path.join(batchInputsDirectory, "sample-a.mp4"));
  copyFileSync(sampleB, path.join(batchInputsDirectory, "sample-b.mp4"));
  const environment = {
    ...process.env,
    VIDCORD_E2E_ROOT: runDirectory,
    VIDCORD_E2E_SAMPLE_A: sampleA,
    VIDCORD_E2E_SAMPLE_B: sampleB,
    VIDCORD_E2E_INPUTS: batchInputsDirectory,
    VIDCORD_E2E_OUTPUTS: path.join(runDirectory, "outputs"),
    VIDCORD_E2E_ARTIFACTS: artifactsDirectory,
    VITE_VIDCORD_E2E: "1",
  };
  const buildEnvironment = { ...environment };

  if (process.platform === "win32") {
    environment.APPDATA = path.join(appDataDirectory, "Roaming");
    environment.LOCALAPPDATA = path.join(appDataDirectory, "Local");
  } else if (process.platform === "darwin") {
    environment.HOME = appDataDirectory;
  } else {
    environment.XDG_DATA_HOME = path.join(appDataDirectory, "data");
    environment.XDG_CONFIG_HOME = path.join(appDataDirectory, "config");
  }

  const buildStatus = run(
    "npm",
    [
      "run",
      "tauri",
      "--",
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      "src-tauri/tauri.e2e.conf.json",
      "--features",
      "e2e",
    ],
    buildEnvironment
  );
  if (buildStatus !== 0) {
    process.exitCode = buildStatus;
  } else {
    const binary = path.join(
      repository,
      "src-tauri",
      "target",
      "debug",
      process.platform === "win32" ? "vidcord.exe" : "vidcord"
    );
    if (process.platform !== "win32") chmodSync(binary, 0o755);

    const port = await getFreePort();
    environment.TAURI_WEBDRIVER_PORT = String(port);
    const logs = createWriteStream(path.join(artifactsDirectory, "desktop-app.log"));
    const application = spawn(binary, [], {
      cwd: repository,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    application.stdout.pipe(logs, { end: false });
    application.stderr.pipe(logs, { end: false });

    let driver;
    try {
      await waitForWebDriver(port, application);
      driver = await new Builder()
        .usingServer(`http://127.0.0.1:${port}`)
        .withCapabilities(new Capabilities().setBrowserName("tauri"))
        .build();
      await driver.manage().setTimeouts({ implicit: 0, pageLoad: 30_000, script: 30_000 });
      await driver.wait(
        () => driver.executeScript(() => document.readyState === "complete"),
        30_000,
        "Tauri's WebView document did not finish loading",
        100
      );
      const initialPage = await driver.executeScript(() => ({
        title: document.title,
        rootText: document.querySelector("#root")?.textContent?.slice(0, 500),
        tauriInternals: typeof window.__TAURI_INTERNALS__,
        e2eDialogs: typeof window.__VIDCORD_E2E_DIALOGS__,
        e2eDialogCalls: window.__VIDCORD_E2E_DIALOGS__?.calls,
        e2eErrors: window.__VIDCORD_E2E_DIALOGS__?.errors,
        dialogQueueLengths: window.__VIDCORD_E2E_DIALOGS__
          ? {
              open: window.__VIDCORD_E2E_DIALOGS__.openQueue.length,
              save: window.__VIDCORD_E2E_DIALOGS__.saveQueue.length,
            }
          : null,
      }));
      console.log("Connected to desktop WebView:", JSON.stringify(initialPage));
      await driver.wait(
        () =>
          driver.executeScript(
            () =>
              (document.querySelector("#root")?.childElementCount ?? 0) > 0 ||
              (window.__VIDCORD_E2E_DIALOGS__?.errors.length ?? 0) > 0
          ),
        10_000,
        "The frontend did not render or report a startup error",
        100
      );
      globalThis.browser = createSeleniumBrowser(driver);
      for (const key of [
        "VIDCORD_E2E_ROOT",
        "VIDCORD_E2E_SAMPLE_A",
        "VIDCORD_E2E_SAMPLE_B",
        "VIDCORD_E2E_INPUTS",
        "VIDCORD_E2E_OUTPUTS",
        "VIDCORD_E2E_ARTIFACTS",
      ]) {
        process.env[key] = environment[key];
      }

      const testCases = [];
      registerSpec(testCases);
      await import("../../e2e/desktop/app.e2e.spec.mjs");
      if (testCases.length !== 1) {
        throw new Error(`Expected one desktop end-to-end scenario, found ${testCases.length}`);
      }

      const [{ name, callback }] = testCases;
      console.log(`Running desktop scenario: ${name}`);
      let scenarioTimeout;
      try {
        await Promise.race([
          callback.call({ timeout() {} }),
          new Promise((_, reject) => {
            scenarioTimeout = setTimeout(
              () => reject(new Error("Desktop end-to-end scenario exceeded 12 minutes")),
              12 * 60_000
            );
          }),
        ]);
      } finally {
        clearTimeout(scenarioTimeout);
      }
      console.log("Desktop end-to-end scenario passed");
    } catch (error) {
      if (driver) {
        try {
          const diagnostics = await driver.executeScript(() => ({
            url: location.href,
            readyState: document.readyState,
            title: document.title,
            rootText: document.querySelector("#root")?.textContent?.slice(0, 2_000),
            bodyText: document.body?.innerText?.slice(0, 2_000),
            tauriInternals: typeof window.__TAURI_INTERNALS__,
            e2eDialogs: typeof window.__VIDCORD_E2E_DIALOGS__,
            e2eErrors: window.__VIDCORD_E2E_DIALOGS__?.errors,
            dialogQueueLengths: window.__VIDCORD_E2E_DIALOGS__
              ? {
                  open: window.__VIDCORD_E2E_DIALOGS__.openQueue.length,
                  save: window.__VIDCORD_E2E_DIALOGS__.saveQueue.length,
                }
              : null,
          }));
          console.error("Desktop WebView diagnostics:", JSON.stringify(diagnostics));
        } catch {
          // The WebView may have closed or failed before script execution was available.
        }
        try {
          await driver.takeScreenshot().then((screenshot) => {
            writeFileSync(
              path.join(artifactsDirectory, "desktop-e2e-failure.png"),
              Buffer.from(screenshot, "base64")
            );
          });
        } catch {
          // The app may have closed before the failure screenshot was captured.
        }
      }
      throw error;
    } finally {
      if (driver) await driver.quit().catch(() => {});
      if (application.exitCode === null && application.signalCode === null) application.kill();
      await new Promise((resolve) => logs.end(resolve));
    }
  }
} finally {
  if (process.env.VIDCORD_E2E_KEEP !== "1") rmSync(runDirectory, { recursive: true, force: true });
}
