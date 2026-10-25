# Install vidcord on Linux

vidcord ships native Linux packages for x86_64 and aarch64, plus a portable
AppImage. Native packages register a desktop entry and video/folder file
associations, install their declared runtime dependencies, and can receive
updates through the distribution package manager when the vidcord repository
is configured.

## Release files

For release version `<version>`, the workflow publishes these Linux installable
artifacts:

| Architecture | Debian / Ubuntu | Fedora / DNF | Arch Linux / Arch Linux ARM | Portable |
| --- | --- | --- | --- | --- |
| x86_64 | `vidcord_<version>_amd64.deb` | `vidcord_<version>_x86_64.rpm` | `vidcord-bin-<version>-1-x86_64.pkg.tar.zst` | `vidcord_<version>_amd64.AppImage` |
| aarch64 | `vidcord_<version>_arm64.deb` | `vidcord_<version>_aarch64.rpm` | `vidcord-bin-<version>-1-aarch64.pkg.tar.zst` | `vidcord_<version>_aarch64.AppImage` |

Each AppImage is accompanied by a matching `.AppImage.zsync` file for delta
update tools. The `.zsync` file is metadata, not an installer, and does not
have a detached Ed25519 `.sig` file. Release installable binaries and packages
have detached Ed25519 signatures named `<artifact>.sig`; release artifacts also
carry GitHub provenance attestations. The signatures bind the release tag,
filename, and artifact digest. See [release signing](RELEASE_SIGNING.md).

The `.deb`, `.rpm`, and AppImage are built by the platform matrix. The Arch
`vidcord-bin` package is made by repacking the matching `.deb` and declaring
Arch-native dependencies; the Arch job runs for tagged releases. The workflow
publishes public release files for `v*` tags. The platform build matrix also
runs for app and packaging changes on the main/version branches and pull
requests to provide CI artifacts; Arch package building and release/repository
publication are tag-only.

## Package dependencies and runtime

| Format | Package metadata and runtime behavior |
| --- | --- |
| `.deb` | Declares `ffmpeg` and GStreamer base, good, bad, and libav plugins. Tauri adds GTK, WebKitGTK, and other desktop runtime dependencies. |
| `.rpm` | Declares GStreamer base, good, and bad-free plugins plus Tauri's desktop runtime dependencies. It does not declare FFmpeg: Fedora users get FFmpeg from RPM Fusion. |
| `vidcord-bin` | Declares `ffmpeg`, GTK/WebKitGTK, GStreamer base/good/bad/libav, and desktop integration dependencies. |
| AppImage | Bundles GStreamer for WebKitGTK video playback. It still needs host `ffmpeg` and `ffprobe` for video probing and compression, plus FUSE support to run on systems that do not provide it already. |

All formats use the host's GTK/WebKitGTK desktop runtime where applicable.
AppImages bundle the media plugins used for HTML video playback, but do not
bundle FFmpeg. See the [FFmpeg setup guide](FFMPEG_SETUP.md) for manual setup.

## One-off package installation

Download the matching file from the
[latest GitHub release](https://github.com/cyroz1/vidcord/releases/latest),
then install it with the matching package manager. These examples assume one
matching release file in the current directory:

```sh
# Debian or Ubuntu
sudo apt install ./vidcord_*_amd64.deb

# Fedora (replace x86_64 with aarch64 for ARM64)
sudo dnf install ./vidcord_*_x86_64.rpm

# Arch Linux or Arch Linux ARM
sudo pacman -U ./vidcord-bin-*-1-x86_64.pkg.tar.zst
```

Use `arm64` for the Debian package, `aarch64` for the RPM package, and
`aarch64` for the Arch package on ARM systems. These commands install the local
package and resolve its dependencies without configuring the vidcord update
repository. To upgrade a one-off installation, download and install the newer
package manually. Without the repository, vidcord also checks GitHub and may
offer its AppImage; that AppImage does not upgrade an installed native package.

## Debian and Ubuntu repository

Before trusting the repository key, compare its fingerprint with a value
published by the maintainers through an independent, trusted channel. The
fingerprint file served beside the key is useful for inspection, but it is not
independent proof of the key's identity.

```sh
curl -fsSLo /tmp/vidcord-repo-key.gpg \
  https://cyroz1.github.io/vidcord/vidcord-repo-key.gpg
gpg --show-keys --with-fingerprint /tmp/vidcord-repo-key.gpg
```

After verifying the fingerprint, configure APT and install vidcord:

```sh
sudo install -d -m 0755 /usr/share/keyrings
sudo install -m 0644 /tmp/vidcord-repo-key.gpg \
  /usr/share/keyrings/vidcord-repo-key.gpg
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

Remove vidcord with `sudo apt remove vidcord`. To remove the repository too,
delete `/etc/apt/sources.list.d/vidcord.list` and
`/usr/share/keyrings/vidcord-repo-key.gpg`.

## Fedora and DNF systems

Download the repository key and inspect its fingerprint. Compare it with the
maintainer-published value through an independent, trusted channel before
accepting it in DNF:

```sh
curl -fsSLo /tmp/vidcord-repo-key.asc \
  https://cyroz1.github.io/vidcord/vidcord-repo-key.asc
gpg --show-keys --with-fingerprint /tmp/vidcord-repo-key.asc
```

After verification, add the repository and install vidcord:

```sh
sudo curl -fsSLo /etc/yum.repos.d/vidcord.repo \
  https://cyroz1.github.io/vidcord/rpm/vidcord.repo
sudo dnf install vidcord
```

Future releases arrive with `sudo dnf upgrade`. Remove vidcord with
`sudo dnf remove vidcord`. Remove `/etc/yum.repos.d/vidcord.repo` to stop using
the repository. RPM-MD metadata is signed and checked by DNF; individual RPM
files are not GPG-signed. Other RPM distributions may use different GTK,
WebKitGTK, and GStreamer package names.

## Arch Linux and Arch Linux ARM

The pacman repository serves both x86_64 and aarch64 using `$arch` in its
server URL. Download and inspect the key, and compare its fingerprint with a
maintainer-published value through an independent, trusted channel before
locally trusting it:

```sh
curl -fsSLo /tmp/vidcord-repo-key.asc \
  https://cyroz1.github.io/vidcord/vidcord-repo-key.asc
gpg --show-keys --with-fingerprint /tmp/vidcord-repo-key.asc
```

After verifying the displayed fingerprint, add and locally trust the key:

```sh
fingerprint="$(gpg --show-keys --with-colons /tmp/vidcord-repo-key.asc \
  | awk -F: '$1 == "fpr" { print $10; exit }')"
sudo pacman-key --add /tmp/vidcord-repo-key.asc
sudo pacman-key --lsign-key "$fingerprint"
```

Add the repository to `/etc/pacman.conf` before the standard repositories,
then install vidcord:

```sh
printf '\n[vidcord]\nSigLevel = Required DatabaseRequired\nServer = https://cyroz1.github.io/vidcord/pacman/$arch\n' \
  | sudo tee -a /etc/pacman.conf >/dev/null
sudo pacman -Syu vidcord-bin
```

Future releases arrive with `sudo pacman -Syu`. Remove vidcord with
`sudo pacman -Rns vidcord-bin`. Remove the `[vidcord]` section from
`/etc/pacman.conf` if you no longer want to use the repository. Package and
database signatures are required by the repository configuration.

## AppImage

Use an AppImage if you prefer a portable copy or your distribution is outside
the supported package repositories. Make it executable and run it:

```sh
chmod +x vidcord_*_amd64.AppImage
./vidcord_*_amd64.AppImage
```

AppImages need FUSE on hosts that do not provide it already. Common packages
are `libfuse2` on Debian/Ubuntu, `fuse-libs` on Fedora, and `fuse2` on Arch.
Use the `_aarch64.AppImage` file on ARM64 systems.
The matching `.zsync` sidecar is used by AppImage delta-update tools; keep it
beside the AppImage if you use one. vidcord's in-app updater downloads and
verifies the replacement AppImage, makes it executable, and reveals it in the
file manager. Quit vidcord, replace the old AppImage, and launch the new file;
the app does not start a second copy automatically.

## Updates and Flatpak

APT, DNF, and pacman installations use their package manager when both the
`vidcord` package and the official vidcord repository are configured. Without
that repository, the in-app GitHub update flow remains enabled and downloads an
AppImage; it does not upgrade a `.deb`, `.rpm`, or pacman package. Remove native
packages with the manager that installed them.

Flatpak environments manage updates through Flatpak. This repository does not
build a Flatpak package.

## Maintainer setup

On a `v*` tag, the workflow builds both architectures, publishes the installable
release artifacts and detached Ed25519 signatures, creates the Arch packages,
and creates the `.zsync` sidecars. Linux package repositories are then generated
and pushed to the `linux-packages` branch if the repository signing key is
configured. To enable repository publishing:

1. Add `VIDCORD_REPOSITORY_GPG_PRIVATE_KEY` as a GitHub Actions secret. It must
   contain an ASCII-armored GPG private key. If it has a passphrase, also add
   `VIDCORD_REPOSITORY_GPG_PASSPHRASE`.
2. Enable GitHub Pages using the `linux-packages` branch and its root directory
   as the publishing source.
3. Publish the next tagged release. The workflow generates signed APT and
   RPM-MD metadata, pacman package/database signatures, and the public key
   files `vidcord-repo-key.gpg`, `vidcord-repo-key.asc`, and
   `vidcord-repo-key.fingerprint`.
4. Publish the GPG fingerprint separately through a trusted channel so users
   can verify it before adding the package signing key.

If the GPG secret is missing, the GitHub release still receives its Linux
package files, but the `linux-packages` repository branch is not updated. RPM
packages themselves do not have GPG signatures; RPM-MD metadata is signed.
Keep the repository signing key outside source control.
