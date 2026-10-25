# Release signing

These checks apply to native desktop update installers only. The browser editor
at [vidcord.app](https://vidcord.app/) is delivered as a static client-side
application, uses FFmpeg WebAssembly, and has no installer or in-app updater.

vidcord update installers use two independent checks before platform handoff:

- the SHA-256 digest published by the GitHub Releases API, and
- a detached Ed25519 signature made by the release workflow with the private
  key stored in the `VIDCORD_RELEASE_SIGNING_KEY` GitHub Actions secret.

After approval, the app fetches the exact release tag selected in the update
prompt, even if a newer release appears before installation begins.

The public key is committed in
[`src-tauri/update-signing-public-key.hex`](../src-tauri/update-signing-public-key.hex).
The private key must remain outside the repository and should be protected by
the repository's release environment or equivalent secret-management controls.
The release workflow fails closed when the secret is missing or does not match
the committed public key.

Each raw 64-byte signature covers this exact UTF-8 message:

```text
vidcord-update-signature-v1
<release tag>
<installer filename>
<lowercase SHA-256 digest>
```

The trailing newline is part of the signed message. This binds a signature to
one release and filename as well as to the downloaded bytes, so a release
metadata change cannot make a different installer valid without the private
key.

To verify a downloaded Linux release asset manually, use a repository checkout
at the same release tag and set `asset` to the downloaded filename:

```sh
tag=v7.7
asset=vidcord_7.7.0_amd64.deb
verify_dir="$(mktemp -d)"
trap 'rm -rf "$verify_dir"' EXIT
key_hex="$(git show "$tag:src-tauri/update-signing-public-key.hex" | tr -d '[:space:]')"
printf '302a300506032b6570032100%s' "$key_hex" | xxd -r -p > "$verify_dir/public-key.der"
digest="$(sha256sum -- "$asset" | awk '{print $1}')"
printf 'vidcord-update-signature-v1\n%s\n%s\n%s\n' \
  "$tag" "$(basename "$asset")" "$digest" > "$verify_dir/message"
openssl pkeyutl -verify -pubin -inkey "$verify_dir/public-key.der" \
  -rawin -in "$verify_dir/message" -sigfile "$asset.sig"
```

Replace the example tag and filename with the release you downloaded. This
checks the detached Ed25519 signature; it is separate from APT, DNF, or pacman
repository signatures. AppImage `.zsync` sidecars do not have Ed25519 signatures.

To rotate the key, generate a new Ed25519 keypair out of band, replace the
committed public key, and publish that change before using the new private key
in `VIDCORD_RELEASE_SIGNING_KEY`. Do not put private key material in source,
artifacts, logs, or pull requests.

Release binaries are also published with GitHub artifact provenance
attestations. `attest-platform-builds` downloads the completed platform
artifacts and creates their attestations in a separate job with OIDC permissions;
the source-executing build matrix keeps read-only repository permissions.
`sign-release-artifacts` verifies the attestations against this repository,
workflow, and tag before signing; `publish-release` publishes immediately
(`draft: false`) after extracting the exact `## vX.Y` CHANGELOG heading. See
[the build workflow](../.github/workflows/build.yml).

The signing secret is a PEM-encoded Ed25519 private key accepted by
`openssl pkey` and `openssl pkeyutl -sign -rawin`. The committed public key is
the corresponding 32-byte raw public key encoded as hex. Each detached update
signature is 64 raw bytes, named `<installer filename>.sig`.

Windows opens the verified NSIS installer; macOS opens the universal DMG.
Linux downloads the architecture-specific AppImage, makes it executable, and
reveals it for the user to replace and relaunch manually. The transfer allows
60 seconds for response headers and each subsequent chunk, with a 512 MiB
installer limit; progress can continue beyond a single minute overall.

Linux repository signing uses a separate GPG key:
`VIDCORD_REPOSITORY_GPG_PRIVATE_KEY` and optional
`VIDCORD_REPOSITORY_GPG_PASSPHRASE`. APT Release metadata and RPM-MD metadata
are signed; pacman packages and databases are signed. RPM configuration uses
`repo_gpgcheck=1` and `gpgcheck=0`, so this is signed repository metadata, not
individual RPM GPG signatures. Arch packages have build attestations and GPG
package signatures in the pacman repository. The detached Ed25519 release
signatures cover `.exe`, `.dmg`, `.AppImage`, `.deb`, `.rpm`, and
`.pkg.tar.zst` assets. AppImage `.zsync` sidecars are provenance-attested but
do not have detached Ed25519 signatures. The desktop updater does not install
`.deb`, `.rpm`, or pacman packages itself. See
[Linux installation and publishing setup](LINUX_INSTALL.md).
