# Changelog

## [1.5.1] - 2026-10-05

### Added
- **Model-metadata sync**: pi-auto-compat now probes each custom channel's `GET /models` endpoint and writes the real `contextWindow` / `maxTokens` into `models.json`, so a 1M-token model no longer runs on Pi's 128k default. Works for any OpenAI-compatible channel (DeepSeek, GLM, Kimi, Qwen, MiMo, Claude/Gemini proxies, …).
  - Parses the widest context field (`context_length`, `context_window`, `max_model_len`, `max_input_tokens`, …) and the output cap (`max_output_tokens`, `max_completion_tokens`, `max_tokens`, …). A generic `max_tokens` equal to the window is the context length, not an output cap, and is ignored.
  - **Smart and conservative**: unit anomalies are rejected (a per-request number an order of magnitude below the current window is not written); values only ever grow; a generic `max_tokens` above the context is clamped to the window.
  - **Verification round-trip**: every network value is stamped with provenance in a sidecar (`pi-auto-compat-sync.json`). A hand-edited value is detected as a manual override and never overwritten twice; a real API correction is still applied.
  - **Non-blocking**: runs on `session_start` and `model_select`, TTL-gated to 6 hours and keyed by a `baseUrl` + model-id signature, so switching models does not re-hit the network. `/auto-compat` forces a full re-probe.
  - Reads per-channel credentials from `models.json` (`$ENV`, `!command`, literal); a channel whose key cannot be resolved is reported as unreachable, never silently mis-detected. `models[].contextWindow` is updated in place and `modelOverrides` is used for extension-owned providers.
- `test/context-sync.test.mjs` covering the parser, the anomaly guard, provenance (manual override protected), and TTL behavior against a local HTTP server.

### Changed
- `package.json` `description` now leads with the README tagline ("Automated model compat flags. In-process self-healing. Zero session restart.") followed by the capability summary, per the `/arnative-pi` manifest standard — pi.dev/packages renders this field verbatim as the package card description.

## [1.5.0] - 2026-10-03

### Added
- Universal developer-role opt-out: reasoning models on OpenAI-compatible channels other than official OpenAI / OpenRouter get `supportsDeveloperRole: false`, so Pi sends the instruction prompt as role `system`. Fixes third-party routers that accept only `system|user|assistant|tool` and answer `400 messages.0.role: Invalid option` (e.g. Enclave/Cyberouter). Written provider-level, and explicit user values are respected.
- `test/placement.test.mjs` verifying provider-level placement against a throwaway agent dir.

### Fixed
- Windows cache-optimizer patch silently no-oped on `pi-cache-optimizer` 2.8.18+, which moved `writeStatsShardV7` from `index.ts` into `src/stats-store.ts`. The patcher now targets the owning module first and falls back to `index.ts`, and injects the `copyFile` import the helper needs.
- `safeAtomicRename` no longer deletes the temp shard when the rename never succeeded: a `renamed` flag skips the `unlink`, so a failed publish keeps the shard data instead of losing it.
- Orphaned `.tmp` cleanup now only removes shards older than one hour, so a temp file belonging to a live writer is no longer unlinked mid-rename (a self-inflicted `EPERM` source).
- `safeAtomicRename` and `writeStatsShardV7` are exported so the patch can be unit-tested against a fixture module.
- Added `test/cache-optimizer-windows-patch.test.mjs` covering patch application, import injection, and idempotency.

## [1.4.4] - 2026-09-28

### Added
- Windows resilience patch for `pi-cache-optimizer`: detects and wraps `writeStatsShardV7` with `safeAtomicRename` (retry with backoff + `copyFile` fallback) to prevent Win32/NTFS `EPERM`/`EBUSY` file locking warnings, and cleans up orphaned `.tmp` shards automatically.
- Dedicated unit test suite (`test/compat.test.mjs`) verifying compatibility flag generation across Anthropic, DeepSeek, Kimi Coding, OpenAI proxies, and local llama.cpp endpoints.
- Standardized `npm run dev` and `npm test` scripts in `package.json`.
- Root `CHANGELOG.md` following the Keep a Changelog standard.

### Changed
- Standardized layout following `arnative-pi` contract: moved extension entry point to `extensions/index.ts`.
- Manifest update: enabled `"type": "module"`, updated `"files"` to include `extensions`, `CHANGELOG.md`, `LICENSE`, and `README.md`.
- Updated package card preview image in `package.json` to `assets/banner.webp`.
- Restructured `README.md` to mirror `pi-arnative` gold standard: minimal shieldcn outline badges, full-width responsive banner image (`width="100%"`), structured feature overview, clean command tables, and collapsible architecture accordions.
- Updated tagline to concrete outcome: `Automated model compat flags. In-process self-healing. Zero session restart.`

---

## [1.4.3] - 2026-09-11

### Fixed
- Declared `supportsLongCacheRetention` explicitly per channel instead of relying on default true: enabled true for Anthropic messages and official OpenAI, and false for other OpenAI-compatible endpoints to avoid HTTP 400 errors.

---

## [1.4.0] - 2026-08-29

### Added
- Universal cache retention detection mirroring `pi-cache-optimizer`.
- Packaged under `@bismawy/pi-auto-compat` scope.
- Support for Kimi Coding (`kimi-k3`, `kimi-for-coding`) with adaptive thinking and empty signature bypass.
