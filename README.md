# Auto Compat

Automated model compat flags. In-process self-healing. Zero session restart.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-auto-compat)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-auto-compat.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-auto-compat)
[![license](https://shieldcn.dev/github/bismawy/pi-auto-compat/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-auto-compat)

<img src="https://raw.githubusercontent.com/bismawy/pi-auto-compat/main/assets/banner.webp" alt="Auto Compat: in-process model compatibility flags self-healer" width="100%">

## Overview

pi-auto-compat inspects active models and patches missing compatibility flags in `models.json` in-process.

- Auto-Heal: Patches missing flags on `session_start`, `model_select`, and `models.json` file events.
- Metadata Sync: Probes each custom channel's `GET /models` and syncs the real `contextWindow` / `maxTokens` (a 1M-token model no longer runs on Pi's 128k default). Rejects unit anomalies, clamps an output cap to the window, and stamps every network value with provenance.
- In-Process Refresh: Invokes `modelRegistry.refresh()` immediately upon write without session restart.
- Cache-Optimizer Parity: Mirrors 1-hour cache retention, adaptive generation, proxy anthropic cache control, and session affinity.
- **Thinking Map Synthesis**: Synthesizes the standard `{ low, medium, high, xhigh }` `thinkingLevelMap` only for reasoning models that declare none.
- Thinking-Effort Probe: Discovers which `reasoning_effort` names a channel actually accepts (one tiny completion per level; 7 requests per model) and remaps the rejected ones to the nearest accepted value, so `/thinking` never sends a level the upstream 400s on.
- Windows Lock Resilience: Wraps `writeStatsShardV7` in `pi-cache-optimizer` with retry and copy fallback against NTFS `EPERM`/`EBUSY`.
- **Credential-Safe**: Touches only `compat`, `modelOverrides`, `thinkingLevelMap`, and the `contextWindow` / `maxTokens` model limits. API keys and base URLs are never modified.

## Install

```bash
pi install npm:@bismawy/pi-auto-compat
```

To test locally without installing:
```bash
pi -e ./extensions/index.ts
```

## Commands

| Command | Scope | Action |
| --- | --- | --- |
| `/auto-compat` | Global | Audit active models, patch missing flags in `models.json`, force a full metadata re-probe, probe every thinking-effort level, and refresh the registry |

> **Notes:**
> - **Zero-Config Background Run:** Fixes are applied automatically on session launch and when switching models.
> - **Explicit Settings Honored:** If you have explicitly configured a compat flag (even `false`), pi-auto-compat will never overwrite it.

## Architecture

<details>
<summary><b>Compatibility Rules</b></summary>

| Category | Conditions | Applied Flags |
| --- | --- | --- |
| **Universal Cache Retention** | All models where unset (except built-in llama.cpp) | `supportsLongCacheRetention: true` (Anthropic & official OpenAI), `false` (third-party OpenAI-compatible) |
| **Developer Role Opt-Out** | Reasoning models on OpenAI-compatible channels except official OpenAI / OpenRouter | `supportsDeveloperRole: false` — sends the instruction prompt as `system` instead of `developer`, fixing routers that 400 on `messages.0.role` |
| **Adaptive Generation** | `anthropic-messages` + Opus/Sonnet ≥ 4.6, Fable ≥ 5, Kimi K3 | `forceAdaptiveThinking: true`, `allowEmptySignature: true` (Kimi K3) |
| **DeepSeek Reasoning** | `openai-completions` / `openai-responses` matching DeepSeek | `requiresReasoningContentOnAssistantMessages: true`, `thinkingFormat: "deepseek"`, session affinity |
| **Claude on Proxies** | Claude models on OpenAI-compatible proxies | `cacheControlFormat: "anthropic"` |
| **OpenAI-Compatible Proxies** | Custom `openai-completions` endpoints | `sendSessionAffinityHeaders: true` (when undefined) |
| **Unmapped Reasoning** | Reasoning models without declared thinking maps | Declares standard `{ low, medium, high, xhigh }` `thinkingLevelMap` |
| **Thinking Effort** | Reasoning models on an OpenAI-compatible channel (not first-party / OpenRouter / llama.cpp, and expected to send `reasoning_effort`) | Rejected levels are remapped to the nearest accepted value (up first, ties down), e.g. `medium: "high"` — discovered by probing, provenance-stamped, 24h TTL |
| **Metadata Sync** | Custom channels with a `baseUrl` exposing `GET /models` | `contextWindow` from the widest context field; `maxTokens` from the output cap — network values only, provenance-stamped, anomaly-guarded |

</details>

<details>
<summary><b>Metadata Sync (contextWindow / maxTokens)</b></summary>

- **Detection**: Reads the first matching context field in priority order (`context_length`, `context_window`, `max_model_len`, `max_input_tokens`, …) and the output cap (`max_output_tokens`, `max_completion_tokens`, `max_tokens`, …). A generic `max_tokens` equal to the window is the context length, not an output cap.
- **Conservative**: Rejects unit anomalies (a per-request number an order of magnitude below the current window); keeps a real API shrink but ignores noise. Output caps above the window are clamped to it.
- **Provenance**: Each network value is stamped in `pi-auto-compat-sync.json`. A hand-edited value is detected as a manual override and never overwritten twice; a real API correction still applies. Flips both values at once (a manual lower output cap does not freeze the window).
- **TTL & Signature**: Non-forced runs re-probe a channel only when its `baseUrl` + model-id signature changed or the 6-hour TTL expired; `/auto-compat` forces a full re-probe.
- **Credentials**: Resolved from `models.json` (`$ENV`, `!command`, or literal) without logging. Unreachable channels are reported, never silently mis-detected.

</details>

<details>
<summary><b>Thinking-Effort Probe</b></summary>

- **Why**: Pi sends `thinkingLevelMap[level] ?? level` as `reasoning_effort`, so an unsupported level reaches the upstream and returns 400 — surfaced by routers as `502 provider_error` when the body carries the hint (Enclave → Together rejects `medium` for `deepseek-v4.1-flash`). `GET /models` does not advertise the accepted subset.
- **Discovery**: One tiny completion per level (`max_tokens: 16`, carrying the same `thinking`/`reasoning` payload Pi would send) — 7 requests per model per probe. A level is only marked accepted on success; a 400 gets one confirmation retry, so a single upstream flake cannot rewrite the map.
- **Remap**: A rejected level maps to the nearest accepted value in Pi's clamp order — up first, ties down (a failed request is worse than a slightly weaker answer). Pi assumes support for unmapped levels, so identity mappings still have to be written once a sibling is dropped; the entry is only written when it carries information.
- **Opt-in levels**: `off`, `xhigh`, and `max` are only adjusted where the model already declares them, and only when the probe tested the value it currently sends. A deliberate opt-out (`null`) stays an opt-out.
- **User wins**: A map the user shaped deliberately (a remap, or an explicit `null`) is skipped and not even probed — not by the background pass, not by `/auto-compat`. Delete the entry to opt back in.
- **Provenance & TTL**: Outcomes are stamped in `pi-auto-compat-sync.json` together with the effective map. Untouched models are re-probed after 24 hours, or immediately when the model's map no longer matches the recorded one. A channel that answered nothing is retried after 1 hour instead.
- **Triggers**: `session_start`, `model_select`, the `models.json` watcher (`/better-custom`, `/login`), and a reactive pass on `message_end` that probes the model from the registry when an inference error carries the parameter-rejection hint. `/auto-compat` forces a full re-probe.
- **Scope**: `reasoning` models on `openai-completions` / `openai-responses` channels that are not first-party (official OpenAI, OpenRouter, built-in llama.cpp) and are expected to send `reasoning_effort` — `supportsReasoningEffort: false` and the `openrouter` / `chat-template` / `qwen-chat-template` / `ant-ling` formats are excluded.

</details>

<details>
<summary><b>Placement Strategy</b></summary>

- Provider Settings: Writes channel-wide parameters (session affinity, cache retention) directly to provider blocks.
- Model Overrides: Writes model-specific flags under `models[].compat`, or `modelOverrides` for dynamic extension providers.

</details>

<details>
<summary><b>Windows Resilience</b></summary>

- Shard Lock Protection: Wraps `writeStatsShardV7` in `pi-cache-optimizer` with `safeAtomicRename` (retry with backoff + copy fallback) against NTFS `EPERM`/`EBUSY`.
- Orphan Cleanup: Unlinks stale `.tmp` files in `pi-cache-optimizer-stats.d/shards/` automatically on session start.

</details>

<details>
<summary><b>Safety & Backups</b></summary>

- Credential-Safe: Only writes `compat`, `modelOverrides`, `thinkingLevelMap`, and `contextWindow` / `maxTokens`. The metadata probe reads `baseUrl` and `apiKey` from `models.json` to authenticate; neither is ever written back or logged.
- Rotating Backups: Retains up to 3 timestamped backups (`models.json.bak-auto-compat-*`) before saving.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test    # Run the unit suites: compat flags, placement, metadata sync, thinking effort, Windows patch
npm run dev # Launch local Pi instance with auto-compat active
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
