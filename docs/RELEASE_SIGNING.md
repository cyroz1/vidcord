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

To rotate the key, generate a new Ed25519 keypair out of band, replace the
committed public key, and publish that change before using the new private key
in `VIDCORD_RELEASE_SIGNING_KEY`. Do not put private key material in source,
artifacts, logs, or pull requests.

Release binaries are also published with GitHub artifact provenance
attestations. The `sign-release-artifacts` job verifies those attestations
against this repository, workflow, and tag before signing; `publish-release`
publishes immediately (`draft: false`) after extracting the exact `## vX.Y`
CHANGELOG heading. See [the build workflow](../.github/workflows/build.yml).

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
package signatures in the pacman repository, but the Ed25519 update-signing
loop covers only `.exe`, `.dmg`, `.AppImage`, `.deb`, and `.rpm`. The desktop
updater does not install `.deb`, `.rpm`, or pacman packages itself. See
[Linux installation and publishing setup](LINUX_INSTALL.md).
