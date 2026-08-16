# pi-auto-compat

A [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that automatically fixes missing `compat` flags in `models.json` — so warnings like `💡 pi-cache-optimizer: ... merged compat lacks ...` and the `⚠️ compat` footer marker never appear.

Detection mirrors [pi-cache-optimizer](https://www.npmjs.com/package/pi-cache-optimizer) exactly (same priority chain), and the source of truth is the **merged** model list from `ctx.modelRegistry` — not a static file scan. Providers without a `models.json` entry are patched too (a minimal compat-only entry is created; credentials are never touched).

## What it fixes

1. **Adaptive generation** (`anthropic-messages` + Opus/Sonnet ≥ 4.6, Fable ≥ 5, or Kimi Coding K3)
   → `forceAdaptiveThinking: true` (+ `allowEmptySignature` for K3 empty-signature models)
2. **DeepSeek-like** (`openai-completions` / `openai-responses`)
   → `supportsLongCacheRetention`, `requiresReasoningContentOnAssistantMessages`, `thinkingFormat: "deepseek"` (+ `sendSessionAffinityHeaders` on completions)
3. **Claude-like on OpenAI-compatible proxies**
   → `cacheControlFormat: "anthropic"`
4. **Non-official OpenAI-compatible proxies** (`openai-completions`)
   → `sendSessionAffinityHeaders: true` — **only when undefined**; explicit `false` is a valid anti-403 opt-out and is never overwritten
5. **Reasoning models without `thinkingLevelMap`** (static rule)
   → default `{ low, medium, high, xhigh }` map

## How it works

- Fix placement mirrors pi-cache-optimizer `/fix`: channel keys (affinity/retention) go provider-level; model-behavior keys go model-level (`models[].compat` or `modelOverrides`) unless every sibling model is compatible.
- After writing, the registry is refreshed **in-process** (`modelRegistry.refresh({ allowNetwork: false })`) — no `/reload` needed.
- Triggers: `session_start`, `model_select`, the `models.json` file-watcher, and the manual `/auto-compat` command.
- A timestamped backup is written before each save (max 3 kept).

## Install

```
pi install npm:pi-auto-compat
```

Then run `/reload` in Pi (or restart it). Optionally run `/auto-compat` once to fix everything immediately.

Manual install (from source): copy `index.ts` into `%USERPROFILE%\.pi\agent\extensions\`.

## Safety

- Never copies, moves, or writes credentials (`apiKey`, OAuth) — new provider entries are compat-only.
- Never deletes existing values; only fills/repairs the specific compat keys listed above.
- Skips official OpenAI endpoints and Pi's built-in llama.cpp provider.
