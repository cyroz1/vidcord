import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFixtures } from "./media.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runDirectory = mkdtempSync(path.join(os.tmpdir(), "vidcord-web-e2e-"));
const outputDirectory = path.join(runDirectory, "outputs");
const artifactsDirectory =
  process.env.VIDCORD_E2E_ARTIFACTS || path.join(os.tmpdir(), "vidcord-e2e-artifacts", "web");

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repository,
    env: environment,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

try {
  mkdirSync(artifactsDirectory, { recursive: true });
  const [sampleA, sampleB] = generateFixtures(path.join(runDirectory, "inputs"));
  const environment = {
    ...process.env,
    VIDCORD_E2E_ROOT: runDirectory,
    VIDCORD_E2E_OUTPUTS: outputDirectory,
    VIDCORD_E2E_ARTIFACTS: artifactsDirectory,
  };

  run("npm", ["run", "web:build"], environment);
  if (!process.exitCode) {
    run(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", "e2e/web/playwright.config.mjs"],
      { ...environment, VIDCORD_E2E_SAMPLE_A: sampleA, VIDCORD_E2E_SAMPLE_B: sampleB }
    );
  }
} finally {
  if (process.env.VIDCORD_E2E_KEEP !== "1") rmSync(runDirectory, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
