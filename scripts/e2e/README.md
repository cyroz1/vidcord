# End-to-end UI tests

The end-to-end suites run the built browser demo and the real Tauri desktop app. Both generate
short H.264/AAC sample videos with FFmpeg, export them through the product UI, then inspect the
resulting media with `ffprobe`. The tests check MP4, lossless stream-copy, animated GIF, batch, and
PNG snapshot outputs as well as the editor's mode, settings, trim, preview, and queue controls.

## Run locally

Install the npm dependencies and make `ffmpeg` and `ffprobe` available on `PATH`. For the browser
suite, install Playwright's Chromium once with `npx playwright install chromium`. For the desktop
suite, install the Tauri platform prerequisites and run on a machine with a graphical session; on
Linux, use Xvfb as the CI workflow does, and install `gstreamer1.0-plugins-base`,
`gstreamer1.0-plugins-good`, `gstreamer1.0-plugins-bad` (which provides the H.264 parser), and
`gstreamer1.0-libav` so WebKitGTK can decode the HTML video preview.

```sh
npm run e2e:web       # browser demo
npm run e2e:desktop   # native Tauri app
npm run e2e           # both suites in sequence
```

The desktop build enables Tauri's embedded WebDriver and the test-only dialog mock bridge. Those
hooks are behind the `e2e` Cargo feature and `VITE_VIDCORD_E2E=1`; normal development and release
builds do not include them. One intentional surface difference remains: `src-tauri/tauri.e2e.conf.json`
sets `withGlobalTauri: true`, so e2e runs expose the global `__TAURI__` object that production
builds (default `false`) do not. The WebDriver plugin needs that global; application code must
only use the imported `@tauri-apps/api` modules, never the global, or it would pass e2e and fail
in production. Window settings, CSP, and asset scope are not overridden and inherit from
`tauri.conf.json` unchanged. File and folder picker responses are mocked so runs are unattended,
and `VIDCORD_E2E_DATA_DIR` isolates test settings from the user's profile on every platform,
while FFmpeg probing, encoding, output publication, and output verification use the real backend.

Screenshots, the desktop app log, Playwright traces, and reports are saved under
`/tmp/vidcord-e2e-artifacts/` by default. Set `VIDCORD_E2E_ARTIFACTS` to change the output directory,
or `VIDCORD_E2E_KEEP=1` to keep the generated input and output fixture directory after the run.
GitHub Actions runs the browser suite and runs the desktop suite on Linux, macOS, and Windows; it
uploads the evidence as workflow artifacts.

## Runner behavior and limits

The browser runner builds the committed site with `web:build`, serves `site/`
locally, and runs Playwright Chromium using `e2e/web/playwright.config.mjs`.
This can rewrite generated site files; inspect the resulting diff. It does not
exercise Firefox or Safari.

The desktop runner builds a debug binary with `--no-bundle`, the `e2e` feature,
and `tauri.e2e.conf.json`, then connects Selenium to its embedded WebDriver.
It uses a small adapter in `selenium-browser.mjs` to run the desktop scenarios;
a separate `tauri-driver`, ChromeDriver, or WDIO runner is not required. Normal
installer builds and their setup dialogs are outside this suite. Package-manager
update routing is disabled for E2E to avoid dependence on the test host's installs.

The workflow's desktop matrix covers Ubuntu 22.04 x86_64, Ubuntu 24.04 ARM64,
macOS, and Windows. This is four desktop jobs plus one browser job, each with
a 60-minute deadline and seven-day evidence retention. These native host tests
do not cover every packaged architecture, desktop environment, GPU, or codec.
Windows ARM64 and the macOS universal bundle still rely on packaging/build checks
in the release matrix rather than dedicated E2E runners.

Default evidence directories use the platform temp directory followed by
`vidcord-e2e-artifacts/web` or `vidcord-e2e-artifacts/desktop` (on Linux,
usually `/tmp/vidcord-e2e-artifacts/`). Native failures include DOM/source and
screenshot diagnostics when the WebDriver session remains usable. The runner
bounds session operations and shutdown; on Linux, file-manager helper processes
must not keep inherited app log pipes open after the app exits.
