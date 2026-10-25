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
repo_add_workspace="$(mktemp -d)"
trap 'rm -rf "$gpg_home" "$repo_add_workspace"' EXIT
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

gpg_sign_to_file() {
  local output_path="$1"
  shift
  local temporary_signature
  temporary_signature="$(mktemp "$(dirname "$output_path")/.vidcord-signature.XXXXXX")"
  gpg_sign --detach-sign --output "$temporary_signature" "$@"
  chmod 644 "$temporary_signature"
  mv -fT -- "$temporary_signature" "$output_path"
}

copy_file_atomically() {
  local source_path="$1"
  local output_path="$2"
  local temporary_copy
  temporary_copy="$(mktemp "$(dirname "$output_path")/.vidcord-copy.XXXXXX")"
  cp -- "$source_path" "$temporary_copy"
  chmod 644 "$temporary_copy"
  mv -fT -- "$temporary_copy" "$output_path"
}

mkdir -p "$repository_root/apt/pool/main" \
  "$repository_root/apt/dists/stable/main/binary-amd64" \
  "$repository_root/apt/dists/stable/main/binary-arm64" \
  "$repository_root/rpm" \
  "$repository_root/pacman/x86_64" \
  "$repository_root/pacman/aarch64"
for architecture in x86_64 aarch64; do
  if [[ -L "$repository_root/pacman/$architecture" ]]; then
    echo "Refusing symlinked pacman repository directory: $architecture" >&2
    exit 1
  fi
done

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

declare -A package_by_arch=()
for package in "${packages[@]}"; do
  package_name="$(basename "$package")"
  if [[ ! "$package_name" =~ ^vidcord-bin-[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-(x86_64|aarch64)\.pkg\.tar\.zst$ ]]; then
    echo "Unexpected pacman package name: $package_name" >&2
    exit 1
  fi
  package_arch="${BASH_REMATCH[1]}"
  if [[ -n "${package_by_arch[$package_arch]:-}" ]]; then
    echo "More than one pacman package found for $package_arch." >&2
    exit 1
  fi
  package_by_arch[$package_arch]="$package"
  copy_file_atomically "$package" "$repository_root/pacman/${package_arch}/$package_name"
done
for architecture in x86_64 aarch64; do
  if [[ -z "${package_by_arch[$architecture]:-}" ]]; then
    echo "Missing pacman package for $architecture." >&2
    exit 1
  fi
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

repo_add_input="$repo_add_workspace/input"
repo_add_output="$repo_add_workspace/output"
mkdir -p "$repo_add_input" "$repo_add_output"
for architecture in x86_64 aarch64; do
  package_directory="$repository_root/pacman/$architecture"
  mkdir -p "$repo_add_input/$architecture" "$repo_add_output/$architecture"
  package_count=0
  for package in "$package_directory"/*.pkg.tar.zst; do
    if [[ ! -e "$package" && ! -L "$package" ]]; then
      continue
    fi
    if [[ ! -f "$package" || -L "$package" ]]; then
      echo "Refusing non-regular pacman package input: $package" >&2
      exit 1
    fi
    cp -- "$package" "$repo_add_input/$architecture/"
    package_count=$((package_count + 1))
  done
  if [[ "$package_count" -eq 0 ]]; then
    echo "No pacman packages found for $architecture." >&2
    exit 1
  fi
done

docker run --rm \
  --mount "type=bind,source=$repo_add_input,target=/input,readonly" \
  --mount "type=bind,source=$repo_add_output,target=/output" \
  archlinux:base-devel@sha256:3cbf69d2d5958d6a294f3722c5668e6187c4df8e00fa27f72352f0bf83e495e1 \
  bash -lc 'set -e; command -v repo-add >/dev/null; for architecture in x86_64 aarch64; do repo-add "/output/$architecture/vidcord.db.tar.zst" /input/"$architecture"/*.pkg.tar.zst; done'

if [[ ! -d "$repo_add_output" || -L "$repo_add_output" ]]; then
  echo "The repository generator replaced its output directory." >&2
  exit 1
fi
repo_add_output_real="$(realpath -e "$repo_add_output")"
for architecture in x86_64 aarch64; do
  architecture_output="$repo_add_output/$architecture"
  if [[ ! -d "$architecture_output" || -L "$architecture_output" ]]; then
    echo "The repository generator replaced the $architecture output directory." >&2
    exit 1
  fi
  architecture_output_real="$(realpath -e "$architecture_output")"
  if [[ "$architecture_output_real" != "$repo_add_output_real/$architecture" ]]; then
    echo "The $architecture repository output escaped its staging directory." >&2
    exit 1
  fi
  package_directory="$repository_root/pacman/$architecture"
  generated_database="$architecture_output/vidcord.db.tar.zst"
  if [[ ! -f "$generated_database" || -L "$generated_database" ]]; then
    echo "repo-add did not produce a regular database for $architecture." >&2
    exit 1
  fi
  generated_database_real="$(realpath -e "$generated_database")"
  if [[ "$generated_database_real" != "$architecture_output_real/vidcord.db.tar.zst" ]]; then
    echo "The $architecture database escaped its staging directory." >&2
    exit 1
  fi
  database_archive_tmp="$(mktemp "$package_directory/.vidcord-db-archive.XXXXXX")"
  cp -- "$generated_database" "$database_archive_tmp"
  chmod 644 "$database_archive_tmp"
  mv -fT -- "$database_archive_tmp" "$package_directory/vidcord.db.tar.zst"

  database="$package_directory/vidcord.db"
  database_tmp="$(mktemp "$package_directory/.vidcord-db.XXXXXX")"
  cp -- "$generated_database" "$database_tmp"
  chmod 644 "$database_tmp"
  mv -fT -- "$database_tmp" "$database"

  generated_files_database="$architecture_output/vidcord.files.tar.zst"
  if [[ -e "$generated_files_database" || -L "$generated_files_database" ]]; then
    if [[ ! -f "$generated_files_database" || -L "$generated_files_database" ]]; then
      echo "repo-add produced an unsafe files database for $architecture." >&2
      exit 1
    fi
    generated_files_database_real="$(realpath -e "$generated_files_database")"
    if [[ "$generated_files_database_real" != "$architecture_output_real/vidcord.files.tar.zst" ]]; then
      echo "The $architecture files database escaped its staging directory." >&2
      exit 1
    fi
    copy_file_atomically "$generated_files_database" "$package_directory/vidcord.files.tar.zst"
    copy_file_atomically "$generated_files_database" "$package_directory/vidcord.files"
  fi

  for package in "$package_directory"/*.pkg.tar.zst; do
    gpg_sign_to_file "${package}.sig" "$package"
  done
  gpg_sign_to_file "${database}.sig" "$database"
done
cat > "$repository_root/pacman/vidcord.conf" <<EOF
[vidcord]
SigLevel = Required DatabaseRequired
Server = ${repository_base_url}/pacman/\$arch
EOF

gpg --batch --export "$signing_fingerprint" > "$repository_root/vidcord-repo-key.gpg"
gpg --batch --armor --export "$signing_fingerprint" > "$repository_root/vidcord-repo-key.asc"
printf '%s\n' "$signing_fingerprint" > "$repository_root/vidcord-repo-key.fingerprint"
