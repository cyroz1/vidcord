import { defineConfig } from "@playwright/test";
import path from "node:path";

const artifacts = path.resolve(
  process.cwd(),
  process.env.VIDCORD_E2E_ARTIFACTS || ".e2e-artifacts/web"
);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 12 * 60 * 1000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: path.join(artifacts, "report"), open: "never" }]],
  outputDir: path.join(artifacts, "results"),
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 1000 },
    acceptDownloads: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node ../../scripts/e2e/serve-site.mjs",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
