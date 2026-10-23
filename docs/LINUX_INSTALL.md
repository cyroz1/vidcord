# Install vidcord on Linux

The Linux package repositories provide native desktop entries, video and folder
associations, dependency installation, package-manager upgrades, and clean
removal. The AppImage remains available as a portable fallback.

The repository commands below become available after the release workflow has
published the `linux-packages` branch and GitHub Pages is enabled for that
branch. For a one-off package install, use
`sudo apt install ./vidcord_*.deb` or `sudo dnf install ./vidcord_*.rpm`; those
commands resolve system dependencies and register vidcord without adding the
update repository. Download packages from the
[latest GitHub release](https://github.com/cyroz1/vidcord/releases/latest), or
use the AppImage instructions at the end of this page. For package-manager
updates, add the repository for your distribution below.

## Debian and Ubuntu

Add the signing key and APT source, then install vidcord:

```sh
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://cyroz1.github.io/vidcord/vidcord-repo-key.gpg \
  | sudo tee /usr/share/keyrings/vidcord-repo-key.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/vidcord-repo-key.gpg] https://cyroz1.github.io/vidcord/apt stable main' \
  | sudo tee /etc/apt/sources.list.d/vidcord.list >/dev/null
sudo apt update
sudo apt install vidcord
```

Future releases arrive with normal system upgrades:

```sh
sudo apt update
sudo apt upgrade
```

Remove vidcord with `sudo apt remove vidcord`.

## Fedora and DNF systems

Install the repository definition and vidcord:

```sh
sudo curl -fsSLo /etc/yum.repos.d/vidcord.repo \
  https://cyroz1.github.io/vidcord/rpm/vidcord.repo
sudo dnf install vidcord
```

Future releases arrive with `sudo dnf upgrade`. Remove vidcord with
`sudo dnf remove vidcord`. The RPM package declares Fedora's GTK, WebKitGTK,
and GStreamer runtime dependencies. Other RPM distributions may use different
dependency names; use the AppImage if the package manager cannot resolve them.

## Arch Linux

The repository serves both x86_64 (Arch Linux) and aarch64 (Arch Linux ARM)
through the `$arch` variable in the server URL, so the same setup works on
both.

Import and locally trust the repository key, then add the repository to
`/etc/pacman.conf` before the standard repositories:

```sh
curl -fsSLo /tmp/vidcord-repo-key.asc \
  https://cyroz1.github.io/vidcord/vidcord-repo-key.asc
fingerprint="$(gpg --show-keys --with-colons /tmp/vidcord-repo-key.asc \
  | awk -F: '$1 == "fpr" { print $10; exit }')"
sudo pacman-key --add /tmp/vidcord-repo-key.asc
sudo pacman-key --lsign-key "$fingerprint"
printf '\n[vidcord]\nSigLevel = Required DatabaseRequired\nServer = https://cyroz1.github.io/vidcord/pacman/$arch\n' \
  | sudo tee -a /etc/pacman.conf >/dev/null
sudo pacman -Syu vidcord-bin
```

Future releases arrive with `sudo pacman -Syu`. Remove vidcord with
`sudo pacman -Rns vidcord-bin`.

## FFmpeg

The desktop app uses system `ffmpeg` and `ffprobe`; these binaries are not
bundled. Debian and Arch package metadata install FFmpeg automatically. Fedora
gets FFmpeg from RPM Fusion, which the RPM package manager cannot enable as an
implicit dependency; vidcord's setup flow can ask before enabling it.

## AppImage fallback

Use the AppImage if you prefer a portable copy or your distribution is outside
the supported package repositories. Make it executable and install the FUSE
runtime if your system needs it:

```sh
chmod +x vidcord_*.AppImage
./vidcord_*.AppImage
```

The AppImage checks for updates itself. APT, RPM, and pacman installations are
updated and removed by their package managers.

## Maintainer setup

The release workflow builds `.deb` and `.rpm` packages for x86_64 and ARM64,
builds Arch packages for x86_64 and aarch64, signs repository metadata, and pushes the
repository indexes to the `linux-packages` branch. APT, RPM-MD, and
pacman repositories install runtime dependencies and provide package-manager
updates and removal. To activate repository publishing:

1. Add `VIDCORD_REPOSITORY_GPG_PRIVATE_KEY` as a GitHub Actions secret. It must
   contain an ASCII-armored GPG private key. If the key has a passphrase, also
   add `VIDCORD_REPOSITORY_GPG_PASSPHRASE`.
2. Enable GitHub Pages in the repository settings, using the `linux-packages`
   branch and its root directory as the publishing source.
3. Publish the next tagged release. The APT, RPM, and pacman indexes and their
   signatures will be generated and published by the workflow.

The workflow reserves the `linux-packages` branch for repository output. Keep
the repository signing key outside source control and verify its published
fingerprint when bootstrapping package-manager trust.
