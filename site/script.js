(function () {
  "use strict";

  const repo = "cyroz1/vidcord";
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const latestReleaseUrl = `https://github.com/${repo}/releases/latest`;

  const platformNames = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    unknown: "your platform",
  };

  const state = {
    platform: "unknown",
    arch: "unknown",
    selectedPlatform: "unknown",
    release: null,
    releaseError: null,
    userSelected: false,
  };

  const primaryDownload = document.getElementById("primaryDownload");
  const downloadStatus = document.getElementById("downloadStatus");
  const releaseState = document.getElementById("releaseState");
  const platformLinks = Array.from(document.querySelectorAll("[data-download-for]"));
  const platformCards = Array.from(document.querySelectorAll("[data-platform-card]"));
  const manualLinks = Array.from(document.querySelectorAll("[data-manual-platform]"));

  function normalizePlatform(value) {
    const text = String(value || "").toLowerCase();

    if (text.includes("win")) {
      return "windows";
    }

    if (text.includes("mac") || text.includes("darwin")) {
      return "macos";
    }

    if (text.includes("linux") || text.includes("x11")) {
      return "linux";
    }

    return "unknown";
  }

  function normalizeArch(value) {
    const text = String(value || "").toLowerCase();

    if (text.includes("arm") || text.includes("aarch64")) {
      return "arm64";
    }

    if (
      text.includes("x86_64") ||
      text.includes("x64") ||
      text.includes("amd64") ||
      text === "x86"
    ) {
      return "x64";
    }

    return "unknown";
  }

  async function detectEnvironment() {
    const userAgentData = navigator.userAgentData;
    const platformSource =
      (userAgentData && userAgentData.platform) || navigator.platform || navigator.userAgent;
    let architectureSource = navigator.platform || navigator.userAgent;

    if (userAgentData && typeof userAgentData.getHighEntropyValues === "function") {
      try {
        const values = await userAgentData.getHighEntropyValues(["architecture", "bitness"]);
        architectureSource = `${values.architecture || ""} ${values.bitness || ""}`;
      } catch (_error) {
        architectureSource = navigator.platform || navigator.userAgent;
      }
    }

    state.platform = normalizePlatform(platformSource);
    state.arch = normalizeArch(architectureSource);
    state.selectedPlatform = state.platform;
  }

  function isArm64Name(name) {
    return /(?:arm64|aarch64)/i.test(name);
  }

  function isX64Name(name) {
    return /(?:x64|x86_64|amd64)/i.test(name);
  }

  function platformExtension(platform) {
    if (platform === "windows") {
      return ".exe";
    }

    if (platform === "macos") {
      return ".dmg";
    }

    if (platform === "linux") {
      return ".appimage";
    }

    return "";
  }

  function assetScore(asset, platform, arch) {
    const name = asset.name.toLowerCase();
    let score = 0;

    if (name.includes("vidcord")) {
      score += 8;
    }

    if (platform === "windows" && name.includes("setup")) {
      score += 5;
    }

    if (platform === "macos" && name.includes("universal")) {
      score += 8;
    }

    if (platform === "linux" && name.includes("appimage")) {
      score += 5;
    }

    if (arch === "arm64") {
      score += isArm64Name(name) ? 20 : 0;
      score -= isX64Name(name) ? 14 : 0;
    } else if (arch === "x64") {
      score += isX64Name(name) ? 20 : 0;
      score -= isArm64Name(name) ? 14 : 0;
    }

    return score;
  }

  function selectBestAsset(platform, arch, assets) {
    const extension = platformExtension(platform);

    if (!extension || !Array.isArray(assets)) {
      return null;
    }

    const candidates = assets.filter((asset) =>
      String(asset.name || "")
        .toLowerCase()
        .endsWith(extension)
    );

    if (!candidates.length) {
      return null;
    }

    return candidates
      .map((asset) => ({ asset, score: assetScore(asset, platform, arch) }))
      .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name))[0].asset;
  }

  function labelFor(platform) {
    return `Download for ${platformNames[platform] || platformNames.unknown}`;
  }

  function setDownloadLink(anchor, platform) {
    const span = anchor.querySelector("span");
    const asset = state.release
      ? selectBestAsset(platform, state.arch, state.release.assets)
      : null;

    anchor.href = asset ? asset.browser_download_url : latestReleaseUrl;

    if (span) {
      span.textContent = labelFor(platform);
    }

    if (asset) {
      anchor.setAttribute("aria-label", `${labelFor(platform)}: ${asset.name}`);
      anchor.dataset.assetName = asset.name;
    } else {
      anchor.setAttribute("aria-label", `${labelFor(platform)} from the latest release`);
      delete anchor.dataset.assetName;
    }
  }

  function updatePlatformCards() {
    platformCards.forEach((card) => {
      const isActive = card.dataset.platformCard === state.selectedPlatform;
      card.classList.toggle("is-active", isActive);
    });
  }

  function updateDownloadLinks() {
    const selectedPlatform = state.selectedPlatform || "unknown";

    if (primaryDownload) {
      setDownloadLink(primaryDownload, selectedPlatform);
    }

    platformLinks.forEach((anchor) => {
      setDownloadLink(anchor, anchor.dataset.downloadFor);
    });

    updatePlatformCards();
    updateStatus();
  }

  function updateStatus() {
    const platformLabel = platformNames[state.selectedPlatform] || platformNames.unknown;
    const primaryAsset = state.release
      ? selectBestAsset(state.selectedPlatform, state.arch, state.release.assets)
      : null;

    if (releaseState) {
      if (state.release) {
        releaseState.textContent = `Latest release: ${state.release.tag_name}`;
      } else if (state.releaseError) {
        releaseState.textContent = "Latest release page available";
      } else {
        releaseState.textContent = "Checking latest release...";
      }
    }

    if (!downloadStatus) {
      return;
    }

    if (state.release && primaryAsset) {
      downloadStatus.textContent = `${platformLabel} detected. The button downloads ${primaryAsset.name}.`;
    } else if (state.release && state.selectedPlatform !== "unknown") {
      downloadStatus.textContent = `${platformLabel} detected. The button opens the latest release assets.`;
    } else if (state.releaseError) {
      downloadStatus.textContent =
        "Could not check GitHub automatically. The button opens the latest release page.";
    } else if (state.selectedPlatform === "unknown") {
      downloadStatus.textContent =
        "Choose Windows, macOS, or Linux below to get the right latest-release asset.";
    } else {
      downloadStatus.textContent = `${platformLabel} detected. Selecting the latest release asset.`;
    }
  }

  async function fetchLatestRelease() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(apiUrl, {
        headers: {
          Accept: "application/vnd.github+json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}`);
      }

      state.release = await response.json();
    } catch (error) {
      state.releaseError = error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function bindManualPlatformLinks() {
    manualLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        state.selectedPlatform = link.dataset.manualPlatform || "unknown";
        state.userSelected = true;
        updateDownloadLinks();

        if (primaryDownload) {
          primaryDownload.focus({ preventScroll: true });
        }
      });
    });
  }

  async function init() {
    bindManualPlatformLinks();
    await detectEnvironment();

    if (!state.userSelected) {
      state.selectedPlatform = state.platform;
    }

    updateDownloadLinks();
    await fetchLatestRelease();
    updateDownloadLinks();
  }

  window.vidcordDownload = {
    normalizePlatform,
    normalizeArch,
    selectBestAsset,
  };

  init();
})();
