# 🔧 @bismawy/pi-auto-compat

**Automatic `compat` flags self-healer for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).**

Silently detects and patches missing model compatibility flags in `models.json` in-process. Ensures prompt caching, adaptive reasoning, session affinity, and custom proxies work flawlessly without manual JSON editing or missing-compat warnings.

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/@bismawy/pi-auto-compat)](https://www.npmjs.com/package/@bismawy/pi-auto-compat)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

![pi-auto-compat](https://raw.githubusercontent.com/bismawy/pi-auto-compat/main/assets/screenshot.webp)

---

## ⚡ Quick Start

### 1. Installation
```bash
pi install npm:@bismawy/pi-auto-compat
```
*(Or install directly from Git: `pi install git:github.com/bismawy/pi-auto-compat`)*

### 2. Activate & Reload
Run `/reload` in your Pi session (or restart Pi).

### 3. Verification
Run `/auto-compat` at any time to inspect and verify all provider compat flags in your configuration.

---

## 🚀 Key Capabilities

- 🛡️ **Zero-Friction Auto-Healing:** Patches missing compatibility flags dynamically during `session_start`, `model_select`, and via real-time file watching on `models.json`.
- ⚡ **In-Process Registry Refresh:** Applies updates instantly via `modelRegistry.refresh({ allowNetwork: false })` without requiring session restarts.
- 🎯 **Full Feature Alignment with `pi-cache-optimizer`:** Automatically configures:
  - Universal long prompt caching (`supportsLongCacheRetention: true`).
  - Adaptive thinking for Claude 4.6+, Fable 5, and Kimi K3 models.
  - DeepSeek reasoning headers and thinking formats.
  - Proxy session affinity (`sendSessionAffinityHeaders: true`) and Anthropic cache control headers.
  - Default thinking level maps for unmapped reasoning models.
- 🔒 **Credential-Safe Guarantee:** Only touches `compat` and `modelOverrides` structures. Never touches API keys, tokens, or base URLs. Creates automatic timestamped backups (max 3) before writing.

---

## 📖 Deep Dive & Technical Architecture

<details>
<summary><b>🛠️ Compatibility Rules & Automated Fixes</b></summary>

| Category | Conditions | Applied Flags |
|---|---|---|
| **Universal Cache Retention** | All models/providers where unset (except built-in llama.cpp) | `supportsLongCacheRetention: true` |
| **Adaptive Generation** | `anthropic-messages` + Opus/Sonnet ≥ 4.6, Fable ≥ 5, Kimi K3 | `forceAdaptiveThinking: true`, `allowEmptySignature: true` (for K3) |
| **DeepSeek-like Models** | `openai-completions` / `openai-responses` matching DeepSeek | `supportsLongCacheRetention: true`<br>`requiresReasoningContentOnAssistantMessages: true`<br>`thinkingFormat: "deepseek"`<br>`sendSessionAffinityHeaders: true` |
| **Claude on Proxies** | Claude models hosted on OpenAI-compatible proxies | `cacheControlFormat: "anthropic"` |
| **OpenAI-Compatible Proxies** | Custom `openai-completions` endpoints | `sendSessionAffinityHeaders: true` (when undefined) |
| **Unmapped Reasoning** | Reasoning-capable models without declared thinking maps | `{ low, medium, high, xhigh }` thinkingLevelMap |

</details>

<details>
<summary><b>⚙️ Placement Strategy & Extension Provider Support</b></summary>

- **Hierarchical Fix Placement:** Channel-level parameters (e.g. session affinity, retention) are assigned to the provider level; model-specific behavior flags are placed under `models[].compat` or `modelOverrides`.
- **Extension-Owned Provider Handling:** When an extension registers custom providers with its own dynamic models list, Pi evaluates them after `models.json`. `pi-auto-compat` automatically directs fixes for these providers into `modelOverrides` to ensure precedence.

</details>

<details>
<summary><b>🔒 Safety & Non-Destructive Operation</b></summary>

- **Credential Isolation:** Never inspects, copies, or alters `apiKey`, OAuth tokens, or credential headers.
- **Additive-Only Patches:** Fills only missing or corrupt keys without removing user customizations or explicit `false` flags.
- **Automated Backups:** Rotates up to 3 timestamped backups (`models.json.backup.*`) prior to saving modifications.

</details>

---

## 📜 License & Acknowledgments

- Designed for the **[pi coding agent](https://github.com/earendil-works/pi-coding-agent)**.
- Compatible with detection rules from `pi-cache-optimizer`.
- Distributed under the **[MIT License](./LICENSE)**.
