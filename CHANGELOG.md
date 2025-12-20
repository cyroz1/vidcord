# Changelog

## v5.2 (2025-12-20)

### Features
- **Linux ARM64 Support**: Added support for building and distributing Linux AppImages on ARM64 (aarch64) architecture.
- **Improved Hardware Detection**: Replaced deprecated `wmic` with PowerShell for more reliable GPU detection on Windows, with a robust fallback mechanism.

### CI/CD & Automation
- **Concurrency Control**: Implemented GitHub Actions concurrency settings to prevent duplicate workflow runs on the same branch.
- **Enhanced Release Workflow**: 
  - Added support for numeric tags (e.g., `5.1`) in addition to prefixed tags (e.g., `v5.1`).
  - Fixed release permission issues to ensure automated asset uploads.
  - Optimized multi-architecture builds for Linux.

### Bug Fixes
- Fixed potential crashes or detection failures in Windows GPU identification.
- Resolved permission errors during the automated release process.

### Maintenance
- General stability improvements and workflow refinements for faster and more reliable builds.
