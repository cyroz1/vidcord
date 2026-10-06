import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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

const ASSET_BASE = import.meta.env.DEV ? "/site/marketing-assets" : "/marketing-assets";
const MARKETING_STYLESHEET = import.meta.env.DEV ? "/site/marketing.css?direct" : "/marketing.css";

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
  loading?: "eager" | "lazy";
};

function asset(file: string): string {
  return `${ASSET_BASE}/${file}`;
}

function platformArch(
  platform: Exclude<DownloadPlatform, "unknown">,
  environment: DownloadEnvironment
): DownloadArch {
  return platform === "macos"
    ? "unknown"
    : platform === environment.platform && environment.archCertain
      ? environment.arch
      : "unknown";
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
    href: release || releaseError ? LATEST_RELEASE_URL : "#download",
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
      detail: "ARM64 Linux systems, newer distros",
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
    href: release || releaseError ? LATEST_RELEASE_URL : "#download",
    label: `${platformDisplayName(platform)} ${archDisplayName(arch)}`,
    direct: false,
    pending: !release && !releaseError,
    needsArchChoice: false,
  };
}

function PlatformIcon({ platform }: { platform: Exclude<DownloadPlatform, "unknown"> }) {
  return (
    <svg className="platform-icon" aria-hidden="true" viewBox="0 0 24 24">
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

function Screenshot({ fallback, variants, width, height, alt, sizes, loading }: ScreenshotProps) {
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
        loading={loading ?? "lazy"}
        fetchPriority={loading === "eager" ? "high" : undefined}
        decoding="async"
        alt={alt}
      />
    </picture>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy fallback failed");
    }
  } finally {
    textarea.remove();
  }
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="command-block">
      <pre>
        <code>{command}</code>
      </pre>
      <button className="copy-command" type="button" onClick={() => void copy()}>
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function InlineCopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="command-block ffmpeg-prereq-command">
      <code>{command}</code>
      <button className="copy-command" type="button" onClick={() => void copy()}>
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

type FfmpegInstallInfo = {
  instruction: string;
  command: string;
};

function ffmpegInstallInfo(platform: DownloadPlatform): FfmpegInstallInfo {
  if (platform === "windows") {
    return {
      instruction:
        "vidcord can run this during install or first launch. If needed, run it manually, then restart or sign out:",
      command: "winget install Gyan.FFmpeg",
    };
  }

  if (platform === "macos") {
    return {
      instruction: "In Terminal, install Homebrew if needed, then run:",
      command: "brew install ffmpeg",
    };
  }

  if (platform === "linux") {
    return {
      instruction: "On Debian or Ubuntu, run this. Fedora and Arch commands are in the guide:",
      command: "sudo apt install ffmpeg",
    };
  }

  return {
    instruction: "Install ffmpeg and ffprobe before compressing videos. Use the guide for your OS:",
    command: "",
  };
}

function downloadStatusText(
  environment: DownloadEnvironment,
  release: LatestRelease | null,
  releaseError: boolean
): string {
  const platform = environment.platform;

  if (platform === "unknown") {
    if (releaseError) {
      return "Could not check GitHub automatically. The button opens the latest release page.";
    }

    return "Choose Windows, macOS, or Linux below to get the right latest-release asset.";
  }

  const platformLabel = platformDisplayName(platform);
  const arch = platformArch(platform, environment);
  const shouldChooseArch = needsArchitectureChoice(platform, arch);
  const primaryAsset =
    !shouldChooseArch && release ? selectBestDownloadAsset(platform, arch, release.assets) : null;

  if (release && shouldChooseArch) {
    return `${platformLabel} detected, but architecture needs confirmation. Choose x64 or ARM64 to download the direct binary.`;
  }

  if (release && primaryAsset) {
    const archLabel = arch !== "unknown" ? ` ${archDisplayName(arch)}` : "";
    return `${platformLabel}${archLabel} detected. The button downloads ${primaryAsset.name}.`;
  }

  if (release) {
    return `${platformLabel} detected. Choose a direct latest-release binary below.`;
  }

  if (releaseError) {
    return "Could not check GitHub automatically. The button opens the latest release page.";
  }

  return `${platformLabel} detected. Selecting the latest release asset.`;
}

type DetailSectionProps = {
  title: string;
  copy: string;
  items: readonly string[];
  image: ScreenshotProps;
  reverse?: boolean;
};

function DetailSection({ title, copy, items, image, reverse = false }: DetailSectionProps) {
  return (
    <section className={`detail-section${reverse ? " detail-section-reverse" : ""}`}>
      <div className="detail-copy">
        <h2>{title}</h2>
        <p>{copy}</p>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div className="detail-image">
        <Screenshot {...image} />
      </div>
    </section>
  );
}

function DesktopUpgrade({ children }: { children?: ReactNode }) {
  const [environment, setEnvironment] = useState<DownloadEnvironment>(DEFAULT_ENVIRONMENT);
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [releaseError, setReleaseError] = useState(false);
  const [downloadCount, setDownloadCount] = useState("—");
  const [architectureChoice, setArchitectureChoice] = useState<Exclude<
    DownloadPlatform,
    "unknown"
  > | null>(null);
  const architectureDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const existingLink = document.querySelector<HTMLLinkElement>(
      'link[data-vidcord-marketing-styles="true"]'
    );

    if (existingLink) {
      return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = MARKETING_STYLESHEET;
    link.dataset.vidcordMarketingStyles = "true";
    document.head.appendChild(link);

    return () => link.remove();
  }, []);

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
        if (active) {
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;

    void fetch("https://img.shields.io/github/downloads/cyroz1/vidcord/total", {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Shields returned ${response.status}`);
        }

        return response.text();
      })
      .then((badge) => {
        const match = badge.match(/aria-label=["']downloads:\s*([^"']+)["']/i);
        const count = match?.[1]?.trim();

        if (!count || !/^\d+(?:\.\d+)?[kKmMbB]?$/.test(count)) {
          throw new Error("Shields returned an unexpected download count");
        }

        if (active) {
          setDownloadCount(count);
        }
      })
      .catch(() => {
        if (active) {
          setDownloadCount("—");
        }
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
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
  const ffmpegInfo = ffmpegInstallInfo(selectedPlatform);
  const desktopAction: DownloadAction =
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
    if (action.pending) {
      event.preventDefault();
      return;
    }
    if (action.needsArchChoice) {
      event.preventDefault();
      setArchitectureChoice(platform);
    }
  };

  return (
    <div className="web-marketing">
      <section className="hero" id="desktop-app" aria-labelledby="desktop-app-title">
        <div className="hero-copy">
          <h1 id="desktop-app-title">vidcord</h1>
          <p className="hero-lede">The full desktop app for local Discord compression.</p>
          <p className="hero-body">
            Compress MP4, MOV, MKV, AVI, WebM, FLV, and WMV for Discord&apos;s 20 MB–1 GB limits
            with system FFmpeg. Trim without re-encoding or make target-size GIFs.
          </p>
          <p className="hero-body">
            Download for GPU acceleration, Open With, native outputs, and the full desktop workflow.
          </p>

          <div className="hero-actions">
            <div className="desktop-download-primary">
              <a
                className="button button-primary"
                id="primaryDownload"
                href={desktopAction.href}
                aria-label={desktopAction.label}
                aria-disabled={desktopAction.pending ? "true" : undefined}
                onClick={(event) => {
                  if (selectedPlatform !== "unknown") {
                    handleDownloadClick(event, selectedPlatform, desktopAction);
                  }
                }}
              >
                <DownloadIcon />
                <span>
                  {desktopAction.needsArchChoice
                    ? desktopAction.label
                    : "Download for your platform"}
                </span>
              </a>
              <p className="web-demo-callout">
                Need a quick export on a phone or tablet? <a href="#web-editor">Try the web demo</a>
              </p>
            </div>
            <a
              className="button button-secondary"
              href="https://github.com/cyroz1/vidcord"
              rel="noreferrer"
              target="_blank"
            >
              <svg className="github-mark" aria-hidden="true" viewBox="0 0 24 24">
                <path d="M12 2.75a9.25 9.25 0 0 0-2.92 18.03c.46.08.63-.2.63-.44v-1.72c-2.57.56-3.11-1.09-3.11-1.09-.42-1.07-1.03-1.36-1.03-1.36-.84-.58.06-.56.06-.56.93.07 1.42.96 1.42.96.83 1.41 2.17 1 2.7.77.08-.6.32-1 .58-1.23-2.05-.23-4.2-1.02-4.2-4.56 0-1 .36-1.83.95-2.48-.1-.23-.41-1.17.09-2.44 0 0 .78-.25 2.55.95A8.8 8.8 0 0 1 12 7.27c.79 0 1.58.1 2.32.31 1.77-1.2 2.55-.95 2.55-.95.5 1.27.19 2.21.09 2.44.59.65.95 1.47.95 2.48 0 3.55-2.16 4.32-4.22 4.55.33.29.63.85.63 1.72v2.52c0 .24.17.52.64.43A9.25 9.25 0 0 0 12 2.75Z" />
              </svg>
              <span>View on GitHub</span>
            </a>
          </div>

          <p className="download-count">
            <strong id="downloadCount">{downloadCount}</strong>
            <span>downloads</span>
          </p>

          <div className="ffmpeg-prereq" role="note" aria-labelledby="ffmpeg-prereq-title">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.3 4.5 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.5a2 2 0 0 0-3.4 0Z" />
            </svg>
            <div>
              <strong id="ffmpeg-prereq-title">FFmpeg required for the desktop app</strong>
              <span id="ffmpegInstruction">{ffmpegInfo.instruction}</span>
              {ffmpegInfo.command ? <InlineCopyCommand command={ffmpegInfo.command} /> : null}
              <div className="ffmpeg-prereq-links">
                <a
                  href="https://github.com/cyroz1/vidcord/blob/main/docs/FFMPEG_SETUP.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Full FFMPEG_SETUP.md
                </a>
              </div>
            </div>
          </div>

          <p className="download-note" id="downloadStatus">
            {downloadStatusText(environment, release, releaseError)}
          </p>

          <dl className="hero-facts" aria-label="Project facts">
            <div>
              <dt>Tauri 2</dt>
              <dd>Small native desktop app</dd>
            </div>
            <div>
              <dt>Offline</dt>
              <dd>No uploads or telemetry</dd>
            </div>
            <div>
              <dt>FFmpeg</dt>
              <dd>Install it before compressing</dd>
            </div>
          </dl>
        </div>

        <div className="hero-product" aria-label="vidcord desktop application screenshot">
          <div className="product-window">
            <div className="window-bar" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <Screenshot
              fallback="window.png"
              variants={[
                { file: "window-480.webp", width: 480 },
                { file: "window-720.webp", width: 720 },
                { file: "window-960.webp", width: 960 },
                { file: "window-1144.webp", width: 1144 },
              ]}
              width={1144}
              height={1668}
              loading="lazy"
              alt="vidcord desktop app with Compress mode, video preview, trim timeline, and Discord target controls"
              sizes="(max-width: 760px) calc(100vw - 36px), (max-width: 1040px) 560px, 500px"
            />
          </div>
        </div>
      </section>

      {children}

      <section className="browser-section" id="browser" aria-labelledby="browser-title">
        <div className="browser-copy">
          <span className="eyebrow">Browser edition</span>
          <h2 id="browser-title">A quick no-install option, when you&apos;re in a pinch.</h2>
          <p>
            Use it on a phone, tablet, or desktop without installing. Files stay in your browser as
            FFmpeg WebAssembly encodes them; videos and PNG snapshots download locally. Use
            browser-readable files up to 512 MB; speed and format support vary by device.
          </p>
        </div>
        <div className="browser-points">
          <div>
            <strong>What works here</strong>
            <span>
              Compress, Advanced, Lossless Trim, GIF, trim/crop/zoom/pan/snap, FPS, audio
              normalization or removal (including lossless), snapshots, keyframe search, and Batch.
            </span>
          </div>
          <div>
            <strong>Know the limits</strong>
            <span>
              Files must be browser-readable and 512 MB or less. Re-encodes use fixed libx264 and
              the first audio track. Batch supports 12 full-length files on one Compress profile;
              keyframe search is capped at 60 seconds or 100,000 keys. Desktop adds GPU/encoder
              choice, track mixing, presets, native folders and completion actions, Open With,
              notifications, Dock/taskbar progress, and updates.
            </span>
          </div>
        </div>
      </section>

      <section className="feature-band" id="features" aria-label="Features">
        <article>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M7 11V8.5a5 5 0 0 1 10 0V11M6 11h12v9H6zM12 15v2" />
          </svg>
          <h2>100% local</h2>
          <p>Your files stay on your device. vidcord never uploads video to a server.</p>
        </article>
        <article>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M8 7.5 12 5l4 2.5v5L12 15l-4-2.5z" />
            <path d="M8 12.5v4L12 19l4-2.5v-4" />
          </svg>
          <h2>Discord targets</h2>
          <p>
            Auto-calculate for 20, 50, 100, 500 MB, or 1 GB Nitro targets. GIFs target 5, 10, or 20
            MB at 15, 30, or up to 50 FPS.
          </p>
        </article>
        <article>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m5 19 14-14M5 5l14 14M9 9l6 6" />
          </svg>
          <h2>Trim and preview</h2>
          <p>
            Scrub and trim to the moment you need. Lossless Trim snaps to keyframes; desktop Linux
            adds FFmpeg previews.
          </p>
        </article>
        <article>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M13 2 4 14h7l-1 8 10-13h-7z" />
          </svg>
          <h2>Desktop acceleration</h2>
          <p>
            Detect NVENC, AMF, QSV, VAAPI, and VideoToolbox; prefer working H.264 hardware with CPU
            fallback. The browser uses fixed libx264 WebAssembly.
          </p>
        </article>
      </section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-title">
        <div className="section-heading">
          <h2 id="workflow-title">How it works</h2>
          <p>Three steps from a large clip—or a batch—to Discord-ready uploads.</p>
        </div>
        <div className="workflow-grid">
          <article>
            <span className="step-number">1</span>
            <h3>Add your videos</h3>
            <p>
              Browse or drop browser videos; desktop also imports folders recursively, from
              the folder picker or file-manager context menu. Select multiple clips for Batch.
            </p>
          </article>
          <article>
            <span className="step-number">2</span>
            <h3>Choose controls and trim</h3>
            <p>
              Set a size, adjust FPS or audio, then preview and trim. Desktop adds the full control
              set.
            </p>
          </article>
          <article>
            <span className="step-number">3</span>
            <h3>Compress and save</h3>
            <p>
              Encode locally and verify size. Download in the browser or save to a desktop
              destination.
            </p>
          </article>
        </div>
      </section>

      <DetailSection
        title="Simple when you want it. Precise when you need it."
        copy="Both editions offer crop, size, resolution, FPS, and audio controls. Desktop adds encoder selection, source-track mixing, presets, native destinations, and copy/reveal/no-action completion choices."
        items={[
          "Browser Batch: up to 12 full-length files, one Compress profile, per-file details, and aggregate ETA. Desktop adds per-file trims and parallel encoding.",
          "Output-size checks with adaptive retries; safe cancellation and collision-safe native filenames.",
          "Desktop presets: Autosave, restore, and delete. FPS: 24, 30, 60, or custom (browser source metadata permitting).",
          "Crop presets: 16:9, 1:1, 9:16, 4:3, 3:4, 4:5, and 5:4.",
          "Normalize or remove audio in either edition; desktop Advanced can mix source tracks.",
          "Desktop updates are user-approved and verified against GitHub’s published SHA-256 digest.",
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
          alt: "vidcord advanced mode with target size, resolution, and encoder controls",
        }}
      />

      <DetailSection
        title="Keep the original quality when you only need a shorter clip."
        copy="Both editions stream-copy keyframe-aligned clips without re-encoding video. Desktop adds container and output choices."
        items={[
          "Trim edges snap outward to keyframes; keep audio or remove every track without re-encoding.",
          "Desktop can offer it when a size target should fit, then falls back to compression if copy fails.",
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
        title="Turn the best moment into a Discord-ready GIF."
        copy="Create local, target-size GIFs in either edition."
        items={[
          "Target 5, 10, or 20 MB at 15, 30, or up to 50 FPS.",
          "Palette optimization and size retries preserve the selected rate; GIFs are silent.",
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
        title="Compress a whole queue in Batch mode."
        copy="Queue clips with per-file status and aggregate progress. Desktop adds folder scanning, separate trims, parallel encoding, and native outputs."
        items={[
          "Browse or drop browser files; desktop opens files or folders from Explorer or Finder, the folder picker, or the file-manager context menu, and scans folders recursively.",
          "Desktop flags skipped, linked, or unreadable files; it runs two encodes at once with serial fallback.",
          "Continue after failures, retry failed browser jobs, or cancel and skip queued work.",
          "Browser Batch uses one Compress profile; desktop adds per-file trims and collision-safe MP4 outputs.",
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

      <section
        className="integration-section"
        id="integrations"
        aria-labelledby="integrations-title"
      >
        <div className="section-heading">
          <div>
            <h2 id="integrations-title">Open one or more videos from Explorer or Finder</h2>
            <p>
              Open videos from Explorer or Finder, then save compressed MP4s to Downloads or a
              chosen desktop folder.
            </p>
          </div>
        </div>

        <div className="integration-grid">
          <article className="integration-panel">
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
          <article className="integration-panel integration-panel-wide">
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
          <article className="integration-panel">
            <div>
              <h3>Saved output file</h3>
              <p>
                Collision-safe names in Downloads, beside the source, or in a custom folder. Browser
                exports use browser downloads.
              </p>
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

      <section className="faq-section" id="faq" aria-labelledby="faq-title">
        <div className="section-heading">
          <div>
            <h2 id="faq-title">Questions people ask before downloading</h2>
            <p>Short answers for anyone checking how the web and desktop editions work.</p>
          </div>
        </div>

        <div className="faq-grid">
          <article>
            <h3>Does vidcord upload videos?</h3>
            <p>
              No. Both editions process files locally; there are no uploads, accounts, or telemetry.
            </p>
          </article>
          <article>
            <h3>Can I use vidcord in a browser?</h3>
            <p>
              Yes. The <a href="#web-editor">browser edition</a> uses local WebAssembly and a fixed
              libx264 encoder. Desktop adds GPU support, Open With, folders, and OS integrations.
            </p>
          </article>
          <article>
            <h3>Is the browser demo suitable for mobile?</h3>
            <p>
              Yes, for a quick export. It supports browser-readable files up to 512 MB; performance
              and download behavior vary. Use desktop for large inputs and the full native workflow.
            </p>
          </article>
          <article>
            <h3>Which Discord upload limits are supported?</h3>
            <p>
              Compress targets: 20, 50, 100, 500 MB, or 1 GB Nitro. Advanced adds custom size,
              resolution, FPS, and desktop encoder controls. GIFs target 5, 10, or 20 MB.
            </p>
          </article>
          <article>
            <h3>Can vidcord compress multiple videos at once?</h3>
            <p>
              Yes. Select or drop browser files; desktop also imports folders recursively,
              from the folder picker or file-manager context menu. Browser Batch supports up to 12
              files; desktop adds per-file trims and parallel workers.
            </p>
          </article>
          <article>
            <h3>Can vidcord change output FPS?</h3>
            <p>
              Yes. Keep the source rate or cap at 24, 30, or 60 FPS. Advanced supports custom FPS in
              both editions; desktop also offers encoder choices.
            </p>
          </article>
          <article>
            <h3>Are scrubbing and playback previews available on Linux?</h3>
            <p>
              Yes. Desktop Linux generates FFmpeg frame previews; the browser uses local video
              playback.
            </p>
          </article>
          <article>
            <h3>Does vidcord include FFmpeg?</h3>
            <p>
              Desktop needs system <code>ffmpeg</code> and <code>ffprobe</code> on PATH. The browser
              uses WebAssembly.
            </p>
          </article>
          <article>
            <h3>How does the desktop download work?</h3>
            <p>
              vidcord links to the latest binary for your OS; choose x64 or ARM64 if detection is
              unsure.
            </p>
          </article>
          <article>
            <h3>How do I run the Linux AppImage?</h3>
            <p>
              Run <code>chmod +x vidcord_*.AppImage</code>, then launch it. Install FUSE:
              <code>libfuse2</code> (Debian/Ubuntu), <code>fuse-libs</code> (Fedora), or
              <code>fuse2</code> (Arch). x86_64 supports older distros; ARM64 targets newer ones.
            </p>
          </article>
          <article>
            <h3>How do desktop updates work?</h3>
            <p>
              After your approval, vidcord verifies the installer&apos;s SHA-256 digest before
              saving and opening it.
            </p>
          </article>
        </div>
      </section>

      <section className="ffmpeg-section" id="ffmpeg-install" aria-labelledby="ffmpeg-title">
        <div className="section-heading">
          <div>
            <h2 id="ffmpeg-title">Set up FFmpeg</h2>
            <p>
              Desktop requires system <code>ffmpeg</code> and <code>ffprobe</code>; first-run setup
              can install them. The browser uses local WebAssembly.
            </p>
          </div>
          <a
            className="text-link"
            href="https://github.com/cyroz1/vidcord/blob/main/docs/FFMPEG_SETUP.md"
            target="_blank"
            rel="noreferrer"
          >
            Full FFMPEG_SETUP.md
          </a>
        </div>

        <div className="ffmpeg-install-grid" aria-label="FFmpeg install directions by platform">
          <article
            className={`ffmpeg-install-card${selectedPlatform === "windows" ? " is-active" : ""}`}
            id="ffmpeg-windows"
            data-ffmpeg-platform="windows"
            aria-current={selectedPlatform === "windows" ? "true" : undefined}
          >
            <span className="detected-pill">Detected platform</span>
            <h3>Windows</h3>
            <p>Run from the installer, first-run setup, or Terminal:</p>
            <CopyCommand command="winget install Gyan.FFmpeg" />
            <p>Select Retry when it finishes; WinGet installs work without restarting.</p>
          </article>
          <article
            className={`ffmpeg-install-card${selectedPlatform === "macos" ? " is-active" : ""}`}
            id="ffmpeg-macos"
            data-ffmpeg-platform="macos"
            aria-current={selectedPlatform === "macos" ? "true" : undefined}
          >
            <span className="detected-pill">Detected platform</span>
            <h3>macOS</h3>
            <p>Install Homebrew, then run:</p>
            <CopyCommand command="brew install ffmpeg" />
            <p>
              Reopen vidcord to detect <code>ffmpeg</code> and <code>ffprobe</code> on PATH.
            </p>
          </article>
          <article
            className={`ffmpeg-install-card${selectedPlatform === "linux" ? " is-active" : ""}`}
            id="ffmpeg-linux"
            data-ffmpeg-platform="linux"
            aria-current={selectedPlatform === "linux" ? "true" : undefined}
          >
            <span className="detected-pill">Detected platform</span>
            <h3>Linux</h3>
            <p>Run the command for your distribution:</p>
            <div className="ffmpeg-linux-commands">
              <div className="ffmpeg-linux-command">
                <span>Debian / Ubuntu</span>
                <CopyCommand command="sudo apt install ffmpeg" />
              </div>
              <div className="ffmpeg-linux-command">
                <span>Fedora (enable RPM Fusion first)</span>
                <CopyCommand command="sudo dnf install -y https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm && sudo dnf install -y ffmpeg" />
              </div>
              <div className="ffmpeg-linux-command">
                <span>Arch / Manjaro</span>
                <CopyCommand command="sudo pacman -S ffmpeg" />
              </div>
            </div>
            <p>
              Launch vidcord normally; it uses the system <code>ffmpeg</code> and{" "}
              <code>ffprobe</code>.
            </p>
          </article>
        </div>
      </section>

      <section className="download-section" id="download" aria-labelledby="download-title">
        <div className="download-heading">
          <div>
            <h2 id="download-title">Download vidcord</h2>
            <p>Free, open-source, MIT licensed. Built for Windows, macOS, and Linux.</p>
          </div>
          <div className="release-state" id="releaseState" data-release-state>
            {release
              ? `Latest release: ${release.tag_name}`
              : releaseError
                ? "Latest release page available"
                : "Checking latest release..."}
          </div>
        </div>

        <div className="ffmpeg-callout">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 17v-6M12 7.5h.01" />
            <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          <div>
            <strong>FFmpeg required for the desktop app</strong>
            <span>
              Desktop uses system <code>ffmpeg</code> and <code>ffprobe</code>; browser encoding
              runs locally in WebAssembly.
            </span>
          </div>
          <div className="ffmpeg-callout-actions">
            <a href="#ffmpeg-install">Setup steps</a>
            <a
              href="https://github.com/cyroz1/vidcord/blob/main/docs/FFMPEG_SETUP.md"
              target="_blank"
              rel="noreferrer"
            >
              Full guide
            </a>
          </div>
        </div>

        <div className="download-grid" aria-label="Platform downloads">
          {DOWNLOAD_PLATFORMS.map(({ id, name, description }) => {
            const action = createDownloadAction(id, environment, release, releaseError);
            const isActive = selectedPlatform === id;

            return (
              <article
                className={`download-card${isActive ? " is-active" : ""}`}
                data-platform-card={id}
                key={id}
              >
                <PlatformIcon platform={id} />
                <h3>{name}</h3>
                <p>{description}</p>
                <a
                  className="button button-platform"
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
            className="arch-dialog"
            aria-labelledby="arch-choice-title"
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
            <div className="arch-dialog-panel">
              <button
                className="arch-dialog-close"
                type="button"
                aria-label="Close"
                onClick={() => setArchitectureChoice(null)}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
              <h3 id="arch-choice-title">
                Choose {platformDisplayName(architectureChoice)} download
              </h3>
              <p>
                Your browser did not report this device architecture with enough certainty. Choose
                the build that matches your computer.
              </p>
              <div className="arch-options">
                {architectureOptions(architectureChoice).map(({ arch, label, detail }) => {
                  const action = createArchitectureAction(
                    architectureChoice,
                    arch,
                    release,
                    releaseError
                  );

                  return (
                    <a
                      className="arch-option"
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
