# End-to-end UI tests

The end-to-end suites run the built browser demo and the real Tauri desktop app. Both generate
short H.264/AAC sample videos with FFmpeg, export them through the product UI, then inspect the
resulting media with `ffprobe`. The tests check MP4, lossless stream-copy, animated GIF, batch, and
PNG snapshot outputs as well as the editor's mode, settings, trim, preview, and queue controls.

## Run locally

Install the npm dependencies and make `ffmpeg` and `ffprobe` available on `PATH`. For the browser
suite, install Playwright's Chromium once with `npx playwright install chromium`. For the desktop
suite, install the Tauri platform prerequisites and run on a machine with a graphical session; on
Linux, use Xvfb as the CI workflow does.

```sh
npm run e2e:web       # browser demo
npm run e2e:desktop   # native Tauri app
npm run e2e           # both suites in sequence
```

The desktop build enables Tauri's embedded WebDriver and the test-only dialog mock bridge. Those
hooks are behind the `e2e` Cargo feature and `VITE_VIDCORD_E2E=1`; normal development and release
builds do not include them. File and folder picker responses are mocked so runs are unattended,
while FFmpeg probing, encoding, output publication, and output verification use the real backend.

Screenshots, the desktop app log, Playwright traces, and reports are saved under
`/tmp/vidcord-e2e-artifacts/` by default. Set `VIDCORD_E2E_ARTIFACTS` to change the output directory,
or `VIDCORD_E2E_KEEP=1` to keep the generated input and output fixture directory after the run.
GitHub Actions runs the browser suite and runs the desktop suite on Linux, macOS, and Windows; it
uploads the evidence as workflow artifacts.
