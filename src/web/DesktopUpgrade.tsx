import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  DEFAULT_ENVIRONMENT,
  LATEST_RELEASE_URL,
  archDisplayName,
  detectDownloadEnvironment,
  downloadLabel,
  fetchLatestRelease,
  needsArchitectureChoice,
  platformDisplayName,
  selectBestDownloadAsset,
  type DownloadArch,
  type DownloadEnvironment,
  type DownloadPlatform,
  type LatestRelease,
} from "./desktopDownloads";

const ASSET_BASE = "/legacy/assets";

const DOWNLOAD_PLATFORMS = [
  {
    id: "windows",
    name: "Windows",
    description: "Windows 10 or later, x86_64 and ARM64 builds.",
  },
  {
    id: "macos",
    name: "macOS",
    description: "macOS 11 or later with one universal Apple Silicon and Intel DMG.",
  },
  {
    id: "linux",
    name: "Linux",
    description: "AppImage builds for modern glibc distros on x86_64 and aarch64.",
  },
] as const satisfies ReadonlyArray<{
  id: Exclude<DownloadPlatform, "unknown">;
  name: string;
  description: string;
}>;

type DownloadAction = {
  href: string;
  label: string;
  direct: boolean;
  pending: boolean;
  needsArchChoice: boolean;
  assetName?: string;
};

type ArchitectureOption = {
  arch: Exclude<DownloadArch, "unknown">;
  label: string;
  detail: string;
};

type ImageVariant = { file: string; width: number };

type ScreenshotProps = {
  fallback: string;
  variants: readonly ImageVariant[];
  width: number;
  height: number;
  alt: string;
  sizes?: string;
};

function asset(file: string): string {
  return `${ASSET_BASE}/${file}`;
}

function platformArch(
  platform: Exclude<DownloadPlatform, "unknown">,
  environment: DownloadEnvironment
) {
  return platform === "macos"
    ? ("unknown" as const)
    : platform === environment.platform && environment.archCertain
      ? environment.arch
      : ("unknown" as const);
}

function createDownloadAction(
  platform: Exclude<DownloadPlatform, "unknown">,
  environment: DownloadEnvironment,
  release: LatestRelease | null,
  releaseError: boolean
): DownloadAction {
  const arch = platformArch(platform, environment);
  const label = downloadLabel(platform, arch);

  if (needsArchitectureChoice(platform, arch)) {
    return {
      href: "#arch-choice",
      label: `Choose ${platformDisplayName(platform)} architecture`,
      direct: false,
      pending: false,
      needsArchChoice: true,
    };
  }

  const selectedAsset = release ? selectBestDownloadAsset(platform, arch, release.assets) : null;

  if (selectedAsset) {
    return {
      href: selectedAsset.browser_download_url,
      label,
      direct: true,
      pending: false,
      needsArchChoice: false,
      assetName: selectedAsset.name,
    };
  }

  return {
    href: releaseError ? LATEST_RELEASE_URL : "#download",
    label,
    direct: false,
    pending: !release && !releaseError,
    needsArchChoice: false,
  };
}

function architectureOptions(platform: Exclude<DownloadPlatform, "unknown">): ArchitectureOption[] {
  if (platform === "windows") {
    return [
      {
        arch: "x64",
        label: "Windows x86_64 installer",
        detail: "Most Intel and AMD Windows PCs",
      },
      {
        arch: "arm64",
        label: "Windows ARM64 installer",
        detail: "Snapdragon and Surface Pro X-style PCs",
      },
    ];
  }

  return [
    {
      arch: "x64",
      label: "Linux x86_64 AppImage",
      detail: "Most Intel and AMD Linux systems",
    },
    {
      arch: "arm64",
      label: "Linux aarch64 AppImage",
      detail: "ARM64 Linux systems",
    },
  ];
}

function createArchitectureAction(
  platform: Exclude<DownloadPlatform, "unknown">,
  arch: Exclude<DownloadArch, "unknown">,
  release: LatestRelease | null,
  releaseError: boolean
): DownloadAction {
  const selectedAsset = release ? selectBestDownloadAsset(platform, arch, release.assets) : null;

  if (selectedAsset) {
    return {
      href: selectedAsset.browser_download_url,
      label: `${platformDisplayName(platform)} ${archDisplayName(arch)}`,
      direct: true,
      pending: false,
      needsArchChoice: false,
      assetName: selectedAsset.name,
    };
  }

  return {
    href: releaseError ? LATEST_RELEASE_URL : "#download",
    label: `${platformDisplayName(platform)} ${archDisplayName(arch)}`,
    direct: false,
    pending: !release && !releaseError,
    needsArchChoice: false,
  };
}

function PlatformIcon({ platform }: { platform: Exclude<DownloadPlatform, "unknown"> }) {
  return (
    <svg className="web-platform-icon" aria-hidden="true" viewBox="0 0 24 24">
      {platform === "windows" ? (
        <path d="M3 5.1 10.8 4v7.4H3zm9-1.3L21 2.5v8.9h-9zM3 12.6h7.8V20L3 18.9zm9 .1h9v8.8l-9-1.3z" />
      ) : platform === "macos" ? (
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83ZM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11Z" />
      ) : (
        <>
          <path d="M12 2.8c-2 0-3.6 1.6-3.6 3.8v3.8L5.7 15c-1.4 2.4.3 5.4 3.1 5.4h6.4c2.8 0 4.5-3 3.1-5.4l-2.7-4.6V6.6c0-2.2-1.6-3.8-3.6-3.8Z" />
          <path d="M9.1 17.5h5.8M10 7.1h.01M14 7.1h.01" />
        </>
      )}
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" />
    </svg>
  );
}

function Screenshot({ fallback, variants, width, height, alt, sizes }: ScreenshotProps) {
  return (
    <picture>
      <source
        type="image/webp"
        srcSet={variants
          .map(({ file, width: variantWidth }) => `${asset(file)} ${variantWidth}w`)
          .join(", ")}
        sizes={sizes ?? "(max-width: 760px) calc(100vw - 36px), (max-width: 1040px) 560px, 500px"}
      />
      <img
        src={asset(fallback)}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        alt={alt}
      />
    </picture>
  );
}

function FeatureGlyph({ symbol }: { symbol: string }) {
  return (
    <span className="web-feature-glyph" aria-hidden="true">
      {symbol}
    </span>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="web-command-block">
      <pre>
        <code>{command}</code>
      </pre>
      <button type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type DetailSectionProps = {
  label: string;
  title: string;
  copy: string;
  items: readonly string[];
  image: ScreenshotProps;
  reverse?: boolean;
};

function DetailSection({ label, title, copy, items, image, reverse = false }: DetailSectionProps) {
  return (
    <section className={`web-marketing-detail${reverse ? " reverse" : ""}`} aria-label={label}>
      <div className="web-detail-copy">
        <span className="web-eyebrow">{label}</span>
        <h2>{title}</h2>
        <p>{copy}</p>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div className="web-detail-image">
        <Screenshot {...image} />
      </div>
    </section>
  );
}

function DesktopUpgrade() {
  const [environment, setEnvironment] = useState<DownloadEnvironment>(DEFAULT_ENVIRONMENT);
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [releaseError, setReleaseError] = useState(false);
  const [architectureChoice, setArchitectureChoice] = useState<Exclude<
    DownloadPlatform,
    "unknown"
  > | null>(null);
  const architectureDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const releaseTimeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;

    const environmentRequest = detectDownloadEnvironment();
    const releaseRequest = fetchLatestRelease(controller.signal);

    void environmentRequest.then((nextEnvironment) => {
      if (active) {
        setEnvironment(nextEnvironment);
      }
    });

    void releaseRequest
      .then((nextRelease) => {
        if (active) {
          setRelease(nextRelease);
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted) {
          setReleaseError(true);
        }
      })
      .finally(() => window.clearTimeout(releaseTimeout));

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(releaseTimeout);
    };
  }, []);

  useEffect(() => {
    const dialog = architectureDialogRef.current;

    if (!dialog || !architectureChoice) {
      return;
    }

    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    }

    return () => {
      if (dialog.open) {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    };
  }, [architectureChoice]);

  const selectedPlatform = environment.platform;
  const desktopAction =
    selectedPlatform === "unknown"
      ? {
          href: "#download",
          label: "Choose your platform",
          direct: false,
          pending: false,
          needsArchChoice: false,
        }
      : createDownloadAction(selectedPlatform, environment, release, releaseError);

  const handleDownloadClick = (
    event: MouseEvent<HTMLAnchorElement>,
    platform: Exclude<DownloadPlatform, "unknown">,
    action: DownloadAction
  ) => {
    if (action.needsArchChoice) {
      event.preventDefault();
      setArchitectureChoice(platform);
    }
  };

  return (
    <div className="web-marketing">
      <section className="web-desktop-bridge" id="desktop-app" aria-labelledby="desktop-app-title">
        <div className="web-bridge-copy">
          <span className="web-eyebrow">Native desktop edition</span>
          <h2 id="desktop-app-title">Need more power? Download the full vidcord app.</h2>
          <p>
            The browser editor is the quick, private way to make a clip shareable. Install the
            native app when you want faster encoding, hardware acceleration, file-manager shortcuts,
            native save locations, and the complete workflow.
          </p>
          <div className="web-marketing-actions">
            <a
              className="web-marketing-button primary"
              href={desktopAction.href}
              aria-label={desktopAction.label}
              aria-disabled={desktopAction.pending ? "true" : undefined}
              onClick={(event) => {
                if (selectedPlatform !== "unknown") {
                  handleDownloadClick(event, selectedPlatform, desktopAction);
                }
              }}
            >
              {desktopAction.needsArchChoice ? desktopAction.label : "Download the desktop app"}
            </a>
            <a className="web-marketing-button secondary" href="#features">
              See what’s included
            </a>
          </div>
        </div>
        <div className="web-bridge-points">
          <div>
            <strong>Faster native encoding</strong>
            <span>Use system FFmpeg and available H.264 hardware encoders.</span>
          </div>
          <div>
            <strong>More control</strong>
            <span>Choose encoders, output folders, audio tracks, and desktop presets.</span>
          </div>
          <div>
            <strong>Fits your workflow</strong>
            <span>Open clips from Explorer or Finder and keep working while exports run.</span>
          </div>
        </div>
      </section>

      <section className="web-feature-band" id="features" aria-label="vidcord features">
        <article>
          <FeatureGlyph symbol="◌" />
          <h2>100% local</h2>
          <p>Your files stay on your device. vidcord never uploads video to a server.</p>
        </article>
        <article>
          <FeatureGlyph symbol="◇" />
          <h2>Discord targets</h2>
          <p>
            Choose a 20, 50, 100, or 500 MB limit and let vidcord calculate the bitrate. GIF Mode
            supports 20 MB Free and 50 MB Nitro Basic exports at 15, 30, or up to 50 FPS.
          </p>
        </article>
        <article>
          <FeatureGlyph symbol="×" />
          <h2>Trim and preview</h2>
          <p>
            Scrub, preview, and compress only the range you need. Lossless Trim preserves source
            streams with keyframe-aligned boundaries.
          </p>
        </article>
        <article>
          <FeatureGlyph symbol="ϟ" />
          <h2>GPU acceleration</h2>
          <p>
            Detects NVENC, AMF, QSV, VAAPI, and VideoToolbox, prefers H.264 hardware on first run,
            and keeps CPU fallback ready.
          </p>
        </article>
      </section>

      <section className="web-platform-section" aria-labelledby="platform-title">
        <div>
          <span className="web-eyebrow">Start in the browser</span>
          <h2 id="platform-title">The web version is the fast, private start.</h2>
          <p>
            No account, no upload step, and no installer. Selected files stay in this browser while
            FFmpeg WebAssembly handles the encode locally; finished videos and frame snapshots are
            downloaded by the browser.
          </p>
        </div>
        <div className="web-platform-points">
          <div>
            <strong>Included here</strong>
            <span>
              Compress, Advanced, Lossless Trim, GIF, trim, crop, FPS, presets, snapshots, and
              batches.
            </span>
          </div>
          <div>
            <strong>Desktop upgrade</strong>
            <span>
              Get native folders, GPU encoder discovery, Open With, notifications, and faster system
              encoding.
            </span>
          </div>
        </div>
      </section>

      <section
        className="web-marketing-section web-workflow"
        id="workflow"
        aria-labelledby="workflow-title"
      >
        <div className="web-marketing-heading">
          <span className="web-eyebrow">A simple flow</span>
          <h2 id="workflow-title">How it works</h2>
          <p>Three steps from a large clip—or a batch—to Discord-ready uploads.</p>
        </div>
        <div className="web-workflow-grid">
          <article>
            <span className="web-step-number">1</span>
            <h3>Add your videos</h3>
            <p>
              Choose a local file or drag and drop. Multi-select to activate Batch mode
              automatically.
            </p>
          </article>
          <article>
            <span className="web-step-number">2</span>
            <h3>Choose controls and trim</h3>
            <p>
              Select a Discord target, cap FPS or remove audio, then preview the range you want to
              share.
            </p>
          </article>
          <article>
            <span className="web-step-number">3</span>
            <h3>Export locally</h3>
            <p>
              Run FFmpeg on this device, verify the output size, and download a ready-to-send clip.
            </p>
          </article>
        </div>
      </section>

      <DetailSection
        label="Desktop controls"
        title="Simple when you want it. Precise when you need it."
        copy="Compress includes aspect-ratio crop presets, while Advanced mode adds custom size, resolution, FPS, and audio normalization. The desktop app also adds encoder selection, source audio-track mixing, and saved output preferences."
        items={[
          "Automatic Batch mode for multiple selections with per-file details, separate trims, and an aggregate ETA.",
          "Strict output size checks with safer adaptive retry behavior.",
          "Named settings presets with Autosave, restore, and delete controls.",
          "Output FPS controls for 24, 30, 60, or a custom advanced value.",
          "Crop to 16:9, 1:1, 9:16, 4:3, 3:4, 4:5, or 5:4 before scaling.",
          "Peak-normalize audio, remove it for more video bitrate, or mix source tracks.",
          "Race-safe cancellation and atomically reserved outputs that never overwrite your files.",
          "User-approved update installers verified against GitHub’s published integrity data.",
        ]}
        image={{
          fallback: "advancedmode.png",
          variants: [
            { file: "advancedmode-480.webp", width: 480 },
            { file: "advancedmode-720.webp", width: 720 },
            { file: "advancedmode-960.webp", width: 960 },
            { file: "advancedmode-1144.webp", width: 1144 },
          ],
          width: 1144,
          height: 1668,
          alt: "vidcord Advanced mode with target size, resolution, and encoder controls",
        }}
      />

      <DetailSection
        label="Lossless Trim"
        title="Keep the original quality when you only need a shorter clip."
        copy="Lossless Trim cuts on source keyframes without re-encoding the video. Choose the section you need, keep or remove audio, and export an original-quality clip quickly with stream-copy processing."
        items={[
          "No video re-encoding for fast, original-quality exports.",
          "Trim boundaries snap outward to source keyframes.",
          "Keep audio or remove every audio track without re-encoding video.",
          "Size-based exports offer it when the selected segment is estimated to fit.",
          "Falls back to normal compression when stream copying is incompatible.",
        ]}
        image={{
          fallback: "losslesstrim.png",
          variants: [
            { file: "losslesstrim-480.webp", width: 480 },
            { file: "losslesstrim-720.webp", width: 720 },
            { file: "losslesstrim-960.webp", width: 960 },
            { file: "losslesstrim-1144.webp", width: 1144 },
          ],
          width: 1144,
          height: 1668,
          alt: "vidcord Lossless Trim mode with keyframe-aligned trim controls and no video re-encoding",
        }}
      />

      <DetailSection
        label="GIF Mode"
        title="Turn the best moment into a Discord-ready GIF."
        copy="GIF Mode swaps in focused controls for animated exports. Choose a Discord Free or Nitro Basic size target and the motion quality you want, then let vidcord optimize the result locally."
        items={[
          "Focused 20 MB Free and 50 MB Nitro Basic targets.",
          "Selectable 15, 30, or Discord-safe maximum 50 FPS output.",
          "Automatic palette generation for cleaner color and motion.",
          "Adaptive size retries that preserve your selected frame rate.",
          "No audio track or unrelated video-only controls.",
        ]}
        reverse
        image={{
          fallback: "gifmode.png",
          variants: [
            { file: "gifmode-480.webp", width: 480 },
            { file: "gifmode-720.webp", width: 720 },
            { file: "gifmode-960.webp", width: 960 },
            { file: "gifmode-1144.webp", width: 1144 },
          ],
          width: 1144,
          height: 1668,
          alt: "vidcord GIF mode with Discord size targets, frame-rate control, trim timeline, and Create GIF button",
        }}
      />

      <DetailSection
        label="Batch mode"
        title="Compress a whole queue in one pass."
        copy="Select multiple videos and vidcord probes, trims, and encodes each one independently. The queue keeps source details and per-file progress visible while the aggregate status shows how much of the batch is complete."
        items={[
          "Select multiple videos through Browse, drag-and-drop, Open With, or the command line.",
          "Apply shared standard Compress settings with separate start and end trims.",
          "Run up to two encodes at once, with a serial fallback when resources contend.",
          "Continue after individual failures and keep collision-safe MP4 outputs.",
          "Cancel active work while queued items are skipped cleanly.",
        ]}
        image={{
          fallback: "batchmode.png",
          variants: [
            { file: "batchmode-480.webp", width: 480 },
            { file: "batchmode-720.webp", width: 720 },
            { file: "batchmode-960.webp", width: 960 },
            { file: "batchmode-1144.webp", width: 1144 },
          ],
          width: 1144,
          height: 1668,
          alt: "vidcord Batch mode with a multi-video queue, per-file status, and aggregate compression progress",
        }}
      />

      <section className="web-integrations" id="integrations" aria-labelledby="integrations-title">
        <div className="web-marketing-heading">
          <span className="web-eyebrow">Native workflow</span>
          <h2 id="integrations-title">Open videos from Explorer or Finder.</h2>
          <p>
            These integrations belong to the desktop app. Start from your file manager, choose one
            or more videos, and get compressed MP4s in the destination you already use.
          </p>
        </div>
        <div className="web-integration-grid">
          <article>
            <div>
              <h3>Windows context menu</h3>
              <p>Right-click a video and choose vidcord from Open with.</p>
            </div>
            <Screenshot
              fallback="context.png"
              variants={[
                { file: "context-480.webp", width: 480 },
                { file: "context-720.webp", width: 720 },
                { file: "context-1115.webp", width: 1115 },
              ]}
              width={1115}
              height={947}
              alt="Windows File Explorer context menu showing vidcord as an Open with option"
              sizes="(max-width: 760px) calc(100vw - 80px), 430px"
            />
          </article>
          <article className="wide">
            <div>
              <h3>macOS Finder</h3>
              <p>Use Open With in Finder to send a local video straight into vidcord.</p>
            </div>
            <Screenshot
              fallback="finder.png"
              variants={[
                { file: "finder-720.webp", width: 720 },
                { file: "finder-1200.webp", width: 1200 },
                { file: "finder-1600.webp", width: 1600 },
              ]}
              width={2176}
              height={1208}
              alt="macOS Finder Open With menu showing vidcord for a video file"
              sizes="(max-width: 760px) calc(100vw - 80px), 670px"
            />
          </article>
          <article>
            <div>
              <h3>Saved output file</h3>
              <p>Use Downloads, the clip folder, a remembered custom folder, or a save prompt.</p>
            </div>
            <Screenshot
              fallback="file.png"
              variants={[
                { file: "file-480.webp", width: 480 },
                { file: "file-572.webp", width: 572 },
              ]}
              width={572}
              height={638}
              alt="Compressed vidcord MP4 output file saved in the Downloads folder"
              sizes="(max-width: 760px) calc(100vw - 80px), 430px"
            />
          </article>
        </div>
      </section>

      <section className="web-faq" id="faq" aria-labelledby="faq-title">
        <div className="web-marketing-heading">
          <span className="web-eyebrow">Good to know</span>
          <h2 id="faq-title">Questions people ask before downloading.</h2>
          <p>Short answers for anyone checking how the web and desktop editions work.</p>
        </div>
        <div className="web-faq-grid">
          <article>
            <h3>Does vidcord upload videos?</h3>
            <p>
              No. The browser editor keeps selected files local, and the desktop app runs FFmpeg on
              your device.
            </p>
          </article>
          <article>
            <h3>What does the web editor include?</h3>
            <p>
              Compress, Advanced, Lossless Trim, GIF, trim, crop, FPS, presets, snapshots, and
              same-profile batches.
            </p>
          </article>
          <article>
            <h3>Which features need the desktop app?</h3>
            <p>
              Native folders, Open With, GPU encoder discovery, system FFmpeg, notifications, and
              other OS integrations.
            </p>
          </article>
          <article>
            <h3>Which Discord upload limits are supported?</h3>
            <p>
              Presets cover 20 MB, 50 MB, 100 MB, and 500 MB targets. GIF Mode supports 20 MB and 50
              MB exports.
            </p>
          </article>
          <article>
            <h3>Can vidcord compress multiple videos?</h3>
            <p>
              Yes. Select two or more files to activate Batch mode, which applies a shared profile
              and reports queue progress.
            </p>
          </article>
          <article>
            <h3>Can I change output FPS?</h3>
            <p>
              Standard mode offers source, 24, 30, and 60 FPS. Advanced mode accepts a custom value
              or a blank source-rate setting.
            </p>
          </article>
          <article>
            <h3>Does vidcord include FFmpeg?</h3>
            <p>
              No. The desktop edition uses <code>ffmpeg</code> and <code>ffprobe</code> on PATH. The
              web edition loads a local WebAssembly build.
            </p>
          </article>
          <article>
            <h3>How does the desktop download work?</h3>
            <p>
              The download page detects your platform and links to the matching latest-release
              asset, with architecture choice when needed.
            </p>
          </article>
          <article>
            <h3>How do desktop updates work?</h3>
            <p>
              After approval, vidcord streams, validates, and hashes the installer before saving and
              opening it.
            </p>
          </article>
        </div>
      </section>

      <section className="web-ffmpeg" id="ffmpeg-install" aria-labelledby="ffmpeg-title">
        <div className="web-marketing-heading">
          <span className="web-eyebrow">Desktop setup</span>
          <h2 id="ffmpeg-title">Set up FFmpeg for the native app.</h2>
          <p>
            vidcord does not bundle FFmpeg. The installer or first launch can help install it
            through your platform package manager, then detect <code>ffmpeg</code> and{" "}
            <code>ffprobe</code> automatically.
          </p>
        </div>
        <div className="web-ffmpeg-grid">
          <article>
            <span className="web-detected-pill">Windows</span>
            <h3>Install with WinGet</h3>
            <CopyCommand command="winget install Gyan.FFmpeg" />
            <p>
              Select Retry in vidcord when it finishes. The app recognizes the WinGet install
              directory without a restart.
            </p>
          </article>
          <article>
            <span className="web-detected-pill">macOS</span>
            <h3>Install with Homebrew</h3>
            <CopyCommand command="brew install ffmpeg" />
            <p>
              After Homebrew finishes, reopen vidcord. It will look for both binaries on your PATH.
            </p>
          </article>
          <article>
            <span className="web-detected-pill">Linux</span>
            <h3>Use your distro package manager</h3>
            <CopyCommand
              command={"sudo apt install ffmpeg\nsudo dnf install ffmpeg\nsudo pacman -S ffmpeg"}
            />
            <p>Use the command for your distro, then launch vidcord normally.</p>
          </article>
        </div>
        <a
          className="web-marketing-text-link"
          href="https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md"
          target="_blank"
          rel="noreferrer"
        >
          Read the full FFMPEG_SETUP.md guide →
        </a>
      </section>

      <section className="web-downloads" id="download" aria-labelledby="download-title">
        <div className="web-download-heading">
          <div>
            <h2 id="download-title">Download vidcord</h2>
            <p>Free, open-source, MIT licensed. Built for Windows, macOS, and Linux.</p>
          </div>
          <div className="web-release-state" data-release-state>
            {release
              ? `Latest release: ${release.tag_name}`
              : releaseError
                ? "Latest release page available"
                : "Checking latest release..."}
          </div>
        </div>

        <div className="web-download-callout">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 17v-6M12 7.5h.01" />
            <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          <div>
            <strong>FFmpeg required</strong>
            <span>
              vidcord can help install FFmpeg through your package manager. The app shells out to
              your system <code>ffmpeg</code> and <code>ffprobe</code>.
            </span>
          </div>
          <div className="web-download-callout-actions">
            <a href="#ffmpeg-install">Setup steps</a>
            <a
              href="https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md"
              target="_blank"
              rel="noreferrer"
            >
              Full guide
            </a>
          </div>
        </div>

        <div className="web-download-grid" aria-label="Platform downloads">
          {DOWNLOAD_PLATFORMS.map(({ id, name, description }) => {
            const action = createDownloadAction(id, environment, release, releaseError);
            const isActive = selectedPlatform === id;

            return (
              <article
                className={`web-download-card${isActive ? " active" : ""}`}
                data-platform-card={id}
                key={id}
              >
                <PlatformIcon platform={id} />
                <h3>{name}</h3>
                <p>{description}</p>
                <a
                  className="web-marketing-button secondary web-download-button"
                  href={action.href}
                  aria-label={
                    action.assetName ? `${action.label}: ${action.assetName}` : action.label
                  }
                  aria-disabled={action.pending ? "true" : undefined}
                  data-download-for={id}
                  data-direct-download={String(action.direct)}
                  data-asset-name={action.assetName}
                  data-needs-arch-choice={action.needsArchChoice ? id : undefined}
                  onClick={(event) => handleDownloadClick(event, id, action)}
                >
                  <DownloadIcon />
                  <span>{action.label}</span>
                </a>
              </article>
            );
          })}
        </div>

        {architectureChoice ? (
          <dialog
            ref={architectureDialogRef}
            className="web-arch-dialog"
            aria-labelledby="web-arch-choice-title"
            onCancel={(event) => {
              event.preventDefault();
              setArchitectureChoice(null);
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setArchitectureChoice(null);
              }
            }}
          >
            <div className="web-arch-dialog-panel">
              <button
                className="web-arch-dialog-close"
                type="button"
                aria-label="Close"
                onClick={() => setArchitectureChoice(null)}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
              <h3 id="web-arch-choice-title">
                Choose {platformDisplayName(architectureChoice)} download
              </h3>
              <p>
                Your browser did not report this device architecture with enough certainty. Choose
                the build that matches your computer.
              </p>
              <div className="web-arch-options">
                {architectureOptions(architectureChoice).map(({ arch, label, detail }) => {
                  const action = createArchitectureAction(
                    architectureChoice,
                    arch,
                    release,
                    releaseError
                  );

                  return (
                    <a
                      className="web-arch-option"
                      href={action.href}
                      aria-label={action.assetName ? `${label}: ${action.assetName}` : label}
                      aria-disabled={action.pending ? "true" : undefined}
                      data-arch-download={arch}
                      data-direct-download={String(action.direct)}
                      data-asset-name={action.assetName}
                      onClick={(event) => {
                        if (action.pending) {
                          event.preventDefault();
                        }
                      }}
                      key={arch}
                    >
                      <span>{label}</span>
                      <small>{detail}</small>
                    </a>
                  );
                })}
              </div>
            </div>
          </dialog>
        ) : null}
      </section>
    </div>
  );
}

export default DesktopUpgrade;
