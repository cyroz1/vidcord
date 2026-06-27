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

  const archNames = {
    x64: "x64",
    arm64: "ARM64",
  };

  const state = {
    platform: "unknown",
    arch: "unknown",
    archCertain: false,
    selectedPlatform: "unknown",
    release: null,
    releaseError: null,
    userSelected: false,
  };

  const primaryDownload = document.getElementById("primaryDownload");
  const downloadStatus = document.getElementById("downloadStatus");
  const ffmpegInstruction = document.getElementById("ffmpegInstruction");
  const ffmpegCommand = document.getElementById("ffmpegCommand");
  const releaseState = document.getElementById("releaseState");
  const ffmpegQuickLink = document.getElementById("ffmpegQuickLink");
  const platformLinks = Array.from(document.querySelectorAll("[data-download-for]"));
  const platformCards = Array.from(document.querySelectorAll("[data-platform-card]"));
  const ffmpegCards = Array.from(document.querySelectorAll("[data-ffmpeg-platform]"));
  const manualLinks = Array.from(document.querySelectorAll("[data-manual-platform]"));
  const archDialog = document.getElementById("archChoiceDialog");
  const archDialogTitle = document.getElementById("archChoiceTitle");
  const archDialogBody = document.getElementById("archChoiceBody");
  const archDialogLinks = Array.from(document.querySelectorAll("[data-arch-download]"));
  const archDialogCloseButtons = Array.from(document.querySelectorAll("[data-arch-dialog-close]"));

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
    const compactText = text.replace(/[\s_-]+/g, "");

    if (
      compactText.includes("arm64") ||
      compactText.includes("aarch64") ||
      (compactText.includes("arm") && compactText.includes("64"))
    ) {
      return "arm64";
    }

    if (
      compactText.includes("x8664") ||
      compactText.includes("x64") ||
      compactText.includes("amd64") ||
      text.includes("win64") ||
      text.includes("wow64")
    ) {
      return "x64";
    }

    return "unknown";
  }

  async function detectEnvironment() {
    const userAgentData = navigator.userAgentData;
    let platformSource =
      (userAgentData && userAgentData.platform) || navigator.platform || navigator.userAgent;

    if (userAgentData && typeof userAgentData.getHighEntropyValues === "function") {
      try {
        const values = await userAgentData.getHighEntropyValues([
          "architecture",
          "bitness",
          "platform",
        ]);
        const detectedArch = normalizeArch(`${values.architecture || ""} ${values.bitness || ""}`);
        platformSource = values.platform || platformSource;

        if (detectedArch !== "unknown") {
          state.arch = detectedArch;
          state.archCertain = true;
        }
      } catch (_error) {
        state.arch = "unknown";
        state.archCertain = false;
      }
    }

    state.platform = normalizePlatform(platformSource);
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

  function assetMatchesArch(asset, arch) {
    const name = String(asset.name || "");

    if (arch === "arm64") {
      return isArm64Name(name);
    }

    if (arch === "x64") {
      return isX64Name(name);
    }

    return false;
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

    if (platform === "macos") {
      return (
        candidates.find((asset) =>
          String(asset.name || "")
            .toLowerCase()
            .includes("universal")
        ) || candidates[0]
      );
    }

    return (
      candidates
        .filter((asset) => assetMatchesArch(asset, arch))
        .sort((a, b) => a.name.localeCompare(b.name))[0] || null
    );
  }

  function assetFor(platform, arch) {
    if (!state.release) {
      return null;
    }

    return selectBestAsset(platform, arch, state.release.assets);
  }

  function effectiveArchForPlatform(platform) {
    return platform === state.platform && state.archCertain ? state.arch : "unknown";
  }

  function needsArchChoice(platform, arch) {
    return (platform === "windows" || platform === "linux") && arch === "unknown";
  }

  function labelFor(platform) {
    return `Download for ${platformNames[platform] || platformNames.unknown}`;
  }

  function downloadLabel(platform, arch) {
    if (!arch || arch === "unknown") {
      return labelFor(platform);
    }

    return `Download for ${platformNames[platform]} ${archNames[arch]}`;
  }

  function setPendingLink(anchor, label) {
    const span = anchor.querySelector("span");

    anchor.href = state.releaseError ? latestReleaseUrl : "#download";
    anchor.dataset.directDownload = "false";
    delete anchor.dataset.needsArchChoice;
    delete anchor.dataset.assetName;

    if (span) {
      span.textContent = label;
    }

    if (state.releaseError) {
      anchor.removeAttribute("aria-disabled");
      anchor.setAttribute("aria-label", `${label}: open latest release page`);
      return;
    }

    anchor.setAttribute("aria-disabled", "true");
    anchor.setAttribute("aria-label", `${label}: checking latest release`);
  }

  function setDownloadLink(anchor, platform, arch) {
    const span = anchor.querySelector("span");
    const label = downloadLabel(platform, arch);
    const asset = assetFor(platform, arch);

    if (!asset) {
      setPendingLink(anchor, label);
      return;
    }

    anchor.href = asset.browser_download_url;
    anchor.dataset.directDownload = "true";
    delete anchor.dataset.needsArchChoice;
    anchor.removeAttribute("aria-disabled");

    if (span) {
      span.textContent = label;
    }

    anchor.setAttribute("aria-label", `${label}: ${asset.name}`);
    anchor.dataset.assetName = asset.name;
  }

  function setChooseArchLink(anchor, platform) {
    const span = anchor.querySelector("span");
    const label = `Choose ${platformNames[platform]} architecture`;

    anchor.href = "#arch-choice";
    anchor.dataset.directDownload = "false";
    anchor.dataset.needsArchChoice = platform;
    anchor.removeAttribute("aria-disabled");
    delete anchor.dataset.assetName;

    if (span) {
      span.textContent = label;
    }

    anchor.setAttribute("aria-label", label);
  }

  function updatePrimaryDownload() {
    if (!primaryDownload) {
      return;
    }

    const selectedPlatform = state.selectedPlatform || "unknown";
    const span = primaryDownload.querySelector("span");

    if (selectedPlatform === "unknown") {
      primaryDownload.href = "#download";
      primaryDownload.dataset.directDownload = "false";
      delete primaryDownload.dataset.needsArchChoice;

      if (span) {
        span.textContent = "Choose your platform";
      }

      primaryDownload.setAttribute("aria-label", "Choose your platform");
      return;
    }

    const arch = selectedPlatform === "macos" ? null : effectiveArchForPlatform(selectedPlatform);

    if (needsArchChoice(selectedPlatform, arch)) {
      setChooseArchLink(primaryDownload, selectedPlatform);
      return;
    }

    setDownloadLink(primaryDownload, selectedPlatform, arch);
  }

  function updatePlatformCards() {
    platformCards.forEach((card) => {
      const isActive = card.dataset.platformCard === state.selectedPlatform;
      card.classList.toggle("is-active", isActive);
    });
  }

  function updateFfmpegInstallLinks() {
    const selectedPlatform = state.selectedPlatform || "unknown";

    ffmpegCards.forEach((card) => {
      const isActive = card.dataset.ffmpegPlatform === selectedPlatform;
      card.classList.toggle("is-active", isActive);

      if (isActive) {
        card.setAttribute("aria-current", "true");
      } else {
        card.removeAttribute("aria-current");
      }
    });

    if (!ffmpegQuickLink) {
      return;
    }

    const quickLinkLabel = ffmpegQuickLink.querySelector("span");

    if (selectedPlatform === "unknown") {
      ffmpegQuickLink.href = "#ffmpeg-install";

      if (quickLinkLabel) {
        quickLinkLabel.textContent = "Show setup for your platform";
      }

      return;
    }

    ffmpegQuickLink.href = `#ffmpeg-${selectedPlatform}`;

    if (quickLinkLabel) {
      quickLinkLabel.textContent = `Show ${platformNames[selectedPlatform]} FFmpeg setup`;
    }
  }

  function archOptionText(platform, arch) {
    if (platform === "windows" && arch === "arm64") {
      return {
        label: "Windows ARM64 installer",
        detail: "Snapdragon and Surface Pro X-style PCs",
      };
    }

    if (platform === "windows") {
      return {
        label: "Windows x86_64 installer",
        detail: "Most Intel and AMD Windows PCs",
      };
    }

    if (platform === "linux" && arch === "arm64") {
      return {
        label: "Linux aarch64 AppImage",
        detail: "ARM64 Linux systems",
      };
    }

    return {
      label: "Linux x86_64 AppImage",
      detail: "Most Intel and AMD Linux systems",
    };
  }

  function setArchDialogDownloadLink(anchor, platform, arch) {
    const asset = assetFor(platform, arch);

    if (!asset) {
      anchor.href = state.releaseError ? latestReleaseUrl : "#download";
      anchor.dataset.directDownload = "false";
      delete anchor.dataset.assetName;

      if (state.releaseError) {
        anchor.removeAttribute("aria-disabled");
        anchor.setAttribute(
          "aria-label",
          `${platformNames[platform]} ${archNames[arch]}: open latest release page`
        );
      } else {
        anchor.setAttribute("aria-disabled", "true");
        anchor.setAttribute(
          "aria-label",
          `${platformNames[platform]} ${archNames[arch]}: checking latest release`
        );
      }

      return;
    }

    anchor.href = asset.browser_download_url;
    anchor.dataset.directDownload = "true";
    anchor.removeAttribute("aria-disabled");
    anchor.setAttribute(
      "aria-label",
      `${platformNames[platform]} ${archNames[arch]}: ${asset.name}`
    );
    anchor.dataset.assetName = asset.name;
  }

  function updateArchDialogContent(platform) {
    if (!archDialog || !platform || platform === "unknown") {
      return;
    }

    archDialog.dataset.platform = platform;

    if (archDialogTitle) {
      archDialogTitle.textContent = `Choose ${platformNames[platform]} download`;
    }

    if (archDialogBody) {
      archDialogBody.textContent =
        "Your browser did not report this device architecture with enough certainty. Choose the build that matches your computer.";
    }

    archDialogLinks.forEach((link) => {
      const arch = link.dataset.archDownload || "unknown";
      const label = link.querySelector("span");
      const detail = link.querySelector("small");
      const text = archOptionText(platform, arch);

      if (label) {
        label.textContent = text.label;
      }

      if (detail) {
        detail.textContent = text.detail;
      }

      setArchDialogDownloadLink(link, platform, arch);
    });
  }

  function updateDownloadLinks() {
    const selectedPlatform = state.selectedPlatform || "unknown";

    updatePrimaryDownload();

    platformLinks.forEach((anchor) => {
      const platform = anchor.dataset.downloadFor;
      const arch = platform === "macos" ? null : effectiveArchForPlatform(platform);

      if (needsArchChoice(platform, arch)) {
        setChooseArchLink(anchor, platform);
      } else {
        setDownloadLink(anchor, platform, arch);
      }
    });

    updateArchDialogContent(archDialog && archDialog.dataset.platform);
    updatePlatformCards();
    updateFfmpegInstallLinks();
    updateStatus();
    updateFfmpegWarning();
  }

  function updateStatus() {
    const selectedPlatform = state.selectedPlatform || "unknown";
    const platformLabel = platformNames[selectedPlatform] || platformNames.unknown;
    const arch = selectedPlatform === "macos" ? null : effectiveArchForPlatform(selectedPlatform);
    const shouldChooseArch = needsArchChoice(selectedPlatform, arch);
    const primaryAsset = shouldChooseArch ? null : assetFor(selectedPlatform, arch);

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

    if (state.release && shouldChooseArch) {
      downloadStatus.textContent = `${platformLabel} detected, but architecture needs confirmation. Choose x64 or ARM64 to download the direct binary.`;
    } else if (state.release && primaryAsset) {
      const archLabel = arch ? ` ${archNames[arch]}` : "";
      downloadStatus.textContent = `${platformLabel}${archLabel} detected. The button downloads ${primaryAsset.name}.`;
    } else if (state.release && selectedPlatform !== "unknown") {
      downloadStatus.textContent = `${platformLabel} detected. Choose a direct latest-release binary below.`;
    } else if (state.releaseError) {
      downloadStatus.textContent =
        "Could not check GitHub automatically. The button opens the latest release page.";
    } else if (selectedPlatform === "unknown") {
      downloadStatus.textContent =
        "Choose Windows, macOS, or Linux below to get the right latest-release asset.";
    } else {
      downloadStatus.textContent = `${platformLabel} detected. Selecting the latest release asset.`;
    }
  }

  function ffmpegInstallInfo(platform, arch) {
    if (platform === "windows" && arch === "arm64") {
      return {
        instruction:
          "Windows ARM64 needs a community FFmpeg build. Download it, copy ffmpeg.exe and ffprobe.exe to C:\\ffmpeg, then add that folder to PATH.",
        command: "",
      };
    }

    if (platform === "windows") {
      return {
        instruction: "Open PowerShell or Command Prompt, run this, then restart or sign out:",
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
      instruction:
        "Install ffmpeg and ffprobe before compressing videos. Use the guide for your OS:",
      command: "",
    };
  }

  function updateFfmpegWarning() {
    if (!ffmpegInstruction || !ffmpegCommand) {
      return;
    }

    const platform = state.selectedPlatform || state.platform;
    const arch = effectiveArchForPlatform(platform);
    const installInfo = ffmpegInstallInfo(platform, arch);

    ffmpegInstruction.textContent = installInfo.instruction;
    ffmpegCommand.textContent = installInfo.command;
    ffmpegCommand.hidden = !installInfo.command;
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

  function openArchDialog(platform) {
    if (!archDialog || !platform || platform === "unknown") {
      return;
    }

    updateArchDialogContent(platform);

    if (archDialog.open) {
      return;
    }

    if (typeof archDialog.showModal === "function") {
      archDialog.showModal();
    } else {
      archDialog.setAttribute("open", "");
    }
  }

  function closeArchDialog() {
    if (!archDialog) {
      return;
    }

    if (typeof archDialog.close === "function") {
      archDialog.close();
    } else {
      archDialog.removeAttribute("open");
    }
  }

  function bindDownloadLinks() {
    [primaryDownload, ...platformLinks].filter(Boolean).forEach((anchor) => {
      anchor.addEventListener("click", (event) => {
        const archChoicePlatform = anchor.dataset.needsArchChoice;

        if (!archChoicePlatform) {
          return;
        }

        event.preventDefault();
        openArchDialog(archChoicePlatform);
      });
    });

    archDialogLinks.forEach((anchor) => {
      anchor.addEventListener("click", (event) => {
        if (anchor.dataset.directDownload === "false" && !state.releaseError) {
          event.preventDefault();
        }
      });
    });
  }

  function bindArchDialog() {
    if (!archDialog) {
      return;
    }

    archDialogCloseButtons.forEach((button) => {
      button.addEventListener("click", closeArchDialog);
    });

    archDialog.addEventListener("click", (event) => {
      if (event.target === archDialog) {
        closeArchDialog();
      }
    });
  }

  async function init() {
    bindManualPlatformLinks();
    bindDownloadLinks();
    bindArchDialog();
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
    ffmpegInstallInfo,
    needsArchChoice,
    needsWindowsArchChoice: needsArchChoice,
    selectBestAsset,
  };

  init();
})();
