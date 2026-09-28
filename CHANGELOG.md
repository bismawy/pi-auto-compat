# Changelog

## [1.4.3] - 2026-09-28

### Added
- Windows resilience patch for `pi-cache-optimizer`: detects and wraps `writeStatsShardV7` with `safeAtomicRename` (retry with backoff + `copyFile` fallback) to prevent Win32/NTFS `EPERM`/`EBUSY` file locking warnings, and cleans up orphaned `.tmp` shards automatically.
- Dedicated unit test suite (`test/compat.test.mjs`) verifying compatibility flag generation across Anthropic, DeepSeek, Kimi Coding, OpenAI proxies, and local llama.cpp endpoints.
- Standardized `npm run dev` and `npm test` scripts in `package.json`.
- Root `CHANGELOG.md` following the Keep a Changelog standard.

### Changed
- Standardized layout following `arnative-pi` contract: moved extension entry point to `extensions/index.ts`.
- Manifest update: enabled `"type": "module"`, updated `"files"` to include `extensions`, `CHANGELOG.md`, `LICENSE`, and `README.md`.
- Updated package card preview image in `package.json` to `assets/banner.webp`.
- Restructured `README.md` to mirror `pi-arnative` design: minimal shieldcn outline badges, full-width responsive banner image (`width="100%"`), structured feature overview, clean command tables, and collapsible architecture accordions.

---

## [1.4.2] - 2026-09-10

### Changed
- Updated package banner asset and aligned metadata URLs with `pi.dev` registry.

---

## [1.4.1] - 2026-08-30

### Fixed
- Declared `supportsLongCacheRetention` explicitly per channel instead of relying on default true: enabled true for Anthropic messages and official OpenAI, and false for other OpenAI-compatible endpoints to avoid HTTP 400 errors.

---

## [1.4.0] - 2026-08-29

### Added
- Universal cache retention detection mirroring `pi-cache-optimizer`.
- Packaged under `@bismawy/pi-auto-compat` scope.
- Support for Kimi Coding (`kimi-k3`, `kimi-for-coding`) with adaptive thinking and empty signature bypass.
