# Release signing

These checks apply to native desktop update installers only. The browser editor
at [vidcord.app](https://vidcord.app/) is delivered as a static client-side
application, uses FFmpeg WebAssembly, and has no installer or in-app updater.

vidcord update installers use two independent checks before they are opened:

- the SHA-256 digest published by the GitHub Releases API, and
- a detached Ed25519 signature made by the release workflow with the private
  key stored in the `VIDCORD_RELEASE_SIGNING_KEY` GitHub Actions secret.

The public key is committed in
[`src-tauri/update-signing-public-key.hex`](src-tauri/update-signing-public-key.hex).
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
attestations. The release job verifies those attestations against this
repository and workflow before signing and publishing the release assets.
