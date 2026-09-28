# Auto Compat

In-process model compatibility flags self-healer. Built for Pi.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-auto-compat)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-auto-compat.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-auto-compat)
[![license](https://shieldcn.dev/github/bismawy/pi-auto-compat/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-auto-compat)

<img src="https://raw.githubusercontent.com/bismawy/pi-auto-compat/main/assets/banner.webp" alt="Auto Compat: in-process model compatibility flags self-healer" width="100%">

## Overview

pi-auto-compat inspects active models and patches missing compatibility flags in `models.json` in-process.

- Auto-Heal: Patches missing flags on `session_start`, `model_select`, and `models.json` file events.
- In-Process Refresh: Invokes `modelRegistry.refresh()` immediately upon write without session restart.
- Cache-Optimizer Parity: Mirrors 1-hour cache retention, adaptive generation, proxy anthropic cache control, and session affinity.
- Thinking Map Synthesis: Synthesizes standard `{ low, medium, high, xhigh }` `thinkingLevelMap` for unmapped reasoning models.
- Windows Lock Resilience: Wraps `writeStatsShardV7` in `pi-cache-optimizer` with retry and copy fallback against NTFS `EPERM`/`EBUSY`.
- Credential-Safe: Touches only `compat` and `modelOverrides`, keeping API keys untouched with rotating backups (max 3).

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
| `/auto-compat` | Global | Audit active models, patch missing flags in `models.json`, and refresh the registry |

> **Notes:**
> - **Zero-Config Background Run:** Fixes are applied automatically on session launch and when switching models.
> - **Explicit Settings Honored:** If you have explicitly configured a compat flag (even `false`), pi-auto-compat will never overwrite it.

## Architecture

<details>
<summary><b>Compatibility Detection Rules</b></summary>

| Category | Conditions | Applied Flags |
| --- | --- | --- |
| **Universal Cache Retention** | All models where unset (except built-in llama.cpp) | `supportsLongCacheRetention: true` (Anthropic & official OpenAI), `false` (third-party OpenAI-compatible) |
| **Adaptive Generation** | `anthropic-messages` + Opus/Sonnet ≥ 4.6, Fable ≥ 5, Kimi K3 | `forceAdaptiveThinking: true`, `allowEmptySignature: true` (Kimi K3) |
| **DeepSeek Reasoning** | `openai-completions` / `openai-responses` matching DeepSeek | `requiresReasoningContentOnAssistantMessages: true`, `thinkingFormat: "deepseek"`, session affinity |
| **Claude on Proxies** | Claude models on OpenAI-compatible proxies | `cacheControlFormat: "anthropic"` |
| **OpenAI-Compatible Proxies** | Custom `openai-completions` endpoints | `sendSessionAffinityHeaders: true` (when undefined) |
| **Unmapped Reasoning** | Reasoning models without declared thinking maps | Declares standard `{ low, medium, high, xhigh }` `thinkingLevelMap` |

</details>

<details>
<summary><b>Placement Strategy</b></summary>

- **Provider-Level Settings:** Channel-wide parameters like session affinity and default cache retention are written directly to provider blocks.
- **Model-Level Overrides:** Model-specific flags go under `models[].compat`. When external extensions register dynamic providers, fixes are directed into `modelOverrides` so they take precedence cleanly.

</details>

<details>
<summary><b>Windows File-Lock Resilience</b></summary>

On Windows, NTFS briefly locks destination files during concurrent background reads or terminal polling, which can cause `pi-cache-optimizer` stats shard writes to throw `EPERM`/`EBUSY`.

- Wraps `writeStatsShardV7` in `pi-cache-optimizer` with `safeAtomicRename` (exponential backoff retry + copy fallback).
- Cleans up orphaned `.tmp` shard files in `pi-cache-optimizer-stats.d/shards/` automatically on session start.

</details>

<details>
<summary><b>Safety & Backups</b></summary>

- **Read-Only API Keys:** Never inspects, logs, or alters credentials or base URLs.
- **Rotating Backups:** Automatically rotates up to 3 timestamped backups (`models.json.backup.<timestamp>`) before committing modifications.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test    # Run unit tests verifying compat flag rules
npm run dev # Launch local Pi instance with auto-compat active
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
