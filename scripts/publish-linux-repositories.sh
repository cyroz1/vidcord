#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: scripts/publish-linux-repositories.sh <release-assets> <repository-root>" >&2
  exit 2
fi

asset_dir="$(realpath "$1")"
repository_root="$(realpath -m "$2")"
repository_base_url="${VIDCORD_REPOSITORY_BASE_URL:-https://cyroz1.github.io/vidcord}"
signing_key="${VIDCORD_REPOSITORY_GPG_PRIVATE_KEY:-}"
signing_passphrase="${VIDCORD_REPOSITORY_GPG_PASSPHRASE:-}"

if [[ -z "$signing_key" ]]; then
  echo "VIDCORD_REPOSITORY_GPG_PRIVATE_KEY is required to sign package metadata." >&2
  exit 1
fi

gpg_home="$(mktemp -d)"
trap 'rm -rf "$gpg_home"' EXIT
chmod 700 "$gpg_home"
export GNUPGHOME="$gpg_home"
printf '%s\n' "$signing_key" | gpg --batch --import >/dev/null 2>&1
signing_fingerprint="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
if [[ ! "$signing_fingerprint" =~ ^[A-Fa-f0-9]{40,64}$ ]]; then
  echo "Could not find a signing key fingerprint in VIDCORD_REPOSITORY_GPG_PRIVATE_KEY." >&2
  exit 1
fi

# Keep the passphrase out of the process list: it lives in a file inside
# the mode-700 temporary GNUPGHOME and is removed with it by the EXIT trap.
passphrase_file="$gpg_home/passphrase"
printf '%s' "$signing_passphrase" > "$passphrase_file"
chmod 600 "$passphrase_file"

gpg_sign() {
  gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$passphrase_file" \
    --local-user "$signing_fingerprint" "$@"
}

mkdir -p "$repository_root/apt/pool/main" \
  "$repository_root/apt/dists/stable/main/binary-amd64" \
  "$repository_root/apt/dists/stable/main/binary-arm64" \
  "$repository_root/rpm" \
  "$repository_root/pacman/x86_64" \
  "$repository_root/pacman/aarch64"

mapfile -t debs < <(find "$asset_dir" -maxdepth 1 -type f -name 'vidcord_*.deb' | sort)
mapfile -t rpms < <(find "$asset_dir" -maxdepth 1 -type f -name 'vidcord_*.rpm' | sort)
mapfile -t packages < <(find "$asset_dir" -maxdepth 1 -type f -name 'vidcord-bin-*.pkg.tar.zst' | sort)
if [[ "${#debs[@]}" -ne 2 || "${#rpms[@]}" -ne 2 || "${#packages[@]}" -ne 2 ]]; then
  echo "Expected two architectures each for deb, rpm, and pacman packages (deb=${#debs[@]}, rpm=${#rpms[@]}, pacman=${#packages[@]})." >&2
  exit 1
fi

for asset in "${debs[@]}"; do
  cp "$asset" "$repository_root/apt/pool/main/"
done
for asset in "${rpms[@]}"; do
  cp "$asset" "$repository_root/rpm/"
done

for package in "${packages[@]}"; do
  package_arch="$(basename "$package" | sed -E 's/^.*-(x86_64|aarch64)\.pkg\.tar\.zst$/\1/')"
  cp "$package" "$repository_root/pacman/${package_arch}/"
done

for architecture in amd64 arm64; do
  index_directory="$repository_root/apt/dists/stable/main/binary-${architecture}"
  (
    cd "$repository_root/apt"
    dpkg-scanpackages --arch "$architecture" pool/main /dev/null > "$index_directory/Packages"
  )
  gzip -9 -c "$index_directory/Packages" > "$index_directory/Packages.gz"
  xz -9 -c "$index_directory/Packages" > "$index_directory/Packages.xz"
done

cat > "$repository_root/apt-release.conf" <<'EOF'
APT::FTPArchive::Release::Origin "Vidcord";
APT::FTPArchive::Release::Label "Vidcord";
APT::FTPArchive::Release::Suite "stable";
APT::FTPArchive::Release::Codename "stable";
APT::FTPArchive::Release::Architectures "amd64 arm64";
APT::FTPArchive::Release::Components "main";
APT::FTPArchive::Release::Description "Vidcord stable package repository";
EOF
(
  cd "$repository_root/apt"
  apt-ftparchive -c "$repository_root/apt-release.conf" release dists/stable > dists/stable/Release
  gpg_sign --clearsign --output dists/stable/InRelease dists/stable/Release
  gpg_sign --detach-sign --output dists/stable/Release.gpg dists/stable/Release
)
rm "$repository_root/apt-release.conf"

createrepo_c --simple-md-filenames "$repository_root/rpm"
gpg_sign --armor --detach-sign \
  --output "$repository_root/rpm/repodata/repomd.xml.asc" \
  "$repository_root/rpm/repodata/repomd.xml"
cat > "$repository_root/rpm/vidcord.repo" <<EOF
[vidcord]
name=Vidcord stable packages
baseurl=${repository_base_url}/rpm/
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=${repository_base_url}/vidcord-repo-key.asc
EOF

docker run --rm \
  --volume "$repository_root/pacman:/repo/pacman" \
  archlinux:base-devel \
  bash -lc 'pacman -Syu --noconfirm pacman-contrib && cd /repo/pacman/x86_64 && repo-add vidcord.db.tar.zst ./*.pkg.tar.zst && cd /repo/pacman/aarch64 && repo-add vidcord.db.tar.zst ./*.pkg.tar.zst'

for architecture in x86_64 aarch64; do
  package_directory="$repository_root/pacman/$architecture"
  database="$package_directory/vidcord.db"
  if [[ -L "$database" ]]; then
    cp -L "$database" "$database.tmp"
    rm "$database"
    mv "$database.tmp" "$database"
  fi
  for package in "$package_directory"/*.pkg.tar.zst; do
    gpg_sign --detach-sign --output "${package}.sig" "$package"
  done
  gpg_sign --detach-sign --output "${database}.sig" "$database"
done
cat > "$repository_root/pacman/vidcord.conf" <<EOF
[vidcord]
SigLevel = Required DatabaseRequired
Server = ${repository_base_url}/pacman/\$arch
EOF

gpg --batch --export "$signing_fingerprint" > "$repository_root/vidcord-repo-key.gpg"
gpg --batch --armor --export "$signing_fingerprint" > "$repository_root/vidcord-repo-key.asc"
printf '%s\n' "$signing_fingerprint" > "$repository_root/vidcord-repo-key.fingerprint"
