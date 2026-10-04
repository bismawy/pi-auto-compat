/**
 * auto-compat — Pi extension
 *
 * Universal auto-compat fixer for models.json — registry-driven.
 *
 * Detection & suggestions mirror pi-cache-optimizer (same priority chain),
 * so every source of the ⚠️ compat footer marker / model_select warnings
 * is covered:
 *
 *   0. UNIVERSAL: every model/provider gets an explicit supportsLongCacheRetention
 *      when not explicitly set — true only for Anthropic-messages and official
 *      OpenAI (the channels that reliably accept long cache retention), false
 *      for other OpenAI-compatible channels (some, e.g. Fireworks, 400 on
 *      prompt_cache_retention; pi's implicit default is true, so omission is
 *      not safe). Explicit user values are respected. New models added via
 *      /better-custom are covered automatically — no per-model injection.
 *   0b. UNIVERSAL: developer-role capability for reasoning models on
 *      OpenAI-compatible channels other than official OpenAI / OpenRouter
 *      → supportsDeveloperRole: false, so Pi sends the instruction prompt as
 *        "system" instead of "developer". Many third-party routers accept only
 *        system|user|assistant|tool and answer 400
 *        `messages.0.role: Invalid option` otherwise. Explicit values win.
 *   1. Adaptive generation (api anthropic-messages + Opus/Sonnet >= 4.6,
 *      Fable >= 5, or Kimi Coding K3 channel)
 *      → forceAdaptiveThinking: true (+ allowEmptySignature for K3 empty-sig)
 *   2. DeepSeek-like (api openai-completions OR openai-responses)
 *      → supportsLongCacheRetention, requiresReasoningContentOnAssistantMessages,
 *        thinkingFormat: "deepseek" (+ sendSessionAffinityHeaders for completions)
 *   3. Claude-like on OpenAI-compatible APIs
 *      → cacheControlFormat: "anthropic"
 *   4. Non-official OpenAI-compatible proxy (api openai-completions)
 *      → sendSessionAffinityHeaders: true — ONLY when undefined; explicit
 *        false is a valid opt-out (proxies/CDNs blocking affinity headers
 *        with 403) and is never overwritten.
 *   5. Static: reasoning model without thinkingLevelMap → default map.
 *
 * Source of truth = MERGED models from ctx.modelRegistry (catalog +
 * provider.compat + models[].compat + modelOverrides). Providers without a
 * models.json entry can be patched too: a minimal compat-only /
 * modelOverrides entry is created — credentials are never touched.
 *
 * Fix placement mirrors pi-cache-optimizer /fix: channel keys (affinity /
 * retention) go provider-level; model-behavior keys go model-level unless
 * every sibling model is compatible; a model level that already contains a
 * target key is repaired in place (Pi precedence: modelOverrides >
 * models[] > provider).
 *
 * Exception — extension-owned model lists: when an extension registers a
 * provider with its own `models` array (or `refreshModels`), Pi composes
 * that list AFTER models.json (provider-composer applyExtension replaces
 * the model list wholesale), so provider-level compat and models[].compat
 * never reach the merged model — only modelOverrides do (applied last via
 * applyModelOverride/mergeCompat). Fixes for such providers are always
 * written to modelOverrides.
 *
 * After writing, the registry is refreshed in-process (modelRegistry.refresh)
 * so changes apply immediately without /reload. Triggers: session_start,
 * model_select, the models.json file-watcher, and the /auto-compat command.
 * A backup is written before each save (max 3 kept).
 */
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	copyFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { join } from "node:path";

// ── Constants (detection identical to pi-cache-optimizer) ───────────

const THINKING_MAP = {
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

// Claude Opus/Sonnet >= 4.6, Fable >= 5 (pi-cache-optimizer patterns).
const ADAPTIVE_RE =
	/(?:^|[/\s:_-])(?:opus-4[.-][6-9]|opus-4-[1-9][0-9]|opus-(?:[5-9]|[1-9][0-9])|sonnet-4[.-][6-9]|sonnet-4-[1-9][0-9]|sonnet-(?:[5-9]|[1-9][0-9])|fable-(?:[5-9]|[1-9][0-9]))(?:$|[-_.:/\s[])/i;

// Channel-capability compat keys — safe at provider level.
const PROVIDER_SAFE_KEYS = new Set([
	"sendSessionAffinityHeaders",
	"supportsDeveloperRole",
	"supportsLongCacheRetention",
]);

const MODELS_JSON = join(getAgentDir(), "models.json");

type Compat = Record<string, unknown>;

// Merged registry model — the same shape pi-cache-optimizer reads.
interface RtModel {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: unknown;
	compat?: Compat;
	[key: string]: unknown;
}

// ── Detection (mirrors pi-cache-optimizer) ──────────────────────────

function lower(v: unknown): string {
	return String(v ?? "").toLowerCase();
}

function tokensOf(m: RtModel): string[] {
	return [m.id, m.name].map(lower).filter(Boolean);
}

function isAdaptiveGeneration(tokens: string[]): boolean {
	return tokens.some((t) => ADAPTIVE_RE.test(t));
}

function isKimiCodingChannel(m: RtModel): boolean {
	return (
		lower(m.provider).includes("kimi-coding") ||
		lower(m.baseUrl).includes("api.kimi.com/coding")
	);
}

function isKimiCodingAdaptive(m: RtModel): boolean {
	if (!isKimiCodingChannel(m)) return false;
	return tokensOf(m).some(
		(t) =>
			t === "k3" ||
			t.includes("kimi-k3") ||
			t.includes("kimi k3") ||
			t.includes("kimi-for-coding") ||
			t.includes("kimi for coding"),
	);
}

function isKimiCodingEmptySignature(m: RtModel): boolean {
	if (!isKimiCodingAdaptive(m)) return false;
	return tokensOf(m).some(
		(t) =>
			t === "k3" ||
			t === "kimi-k3" ||
			t.startsWith("kimi-k3-") ||
			t === "kimi k3" ||
			t === "kimi-for-coding" ||
			t === "kimi for coding",
	);
}

function isDeepSeekLike(tokens: string[]): boolean {
	return tokens.some((t) => t.includes("deepseek"));
}

function isClaudeLike(tokens: string[]): boolean {
	return tokens.some((t) => t.includes("anthropic") || t.includes("claude"));
}

function isOpenAICompatibleApi(api: unknown): boolean {
	const v = lower(api);
	return v === "openai-completions" || v === "openai-responses";
}

// Pi built-in llama.cpp provider fingerprint — excluded from all rules.
function isPiBuiltInLlamaCpp(m: RtModel): boolean {
	if (lower(m.provider) !== "llama.cpp" || lower(m.api) !== "openai-completions")
		return false;
	const c = m.compat ?? {};
	return (
		c.supportsStore === false &&
		c.supportsDeveloperRole === false &&
		c.supportsReasoningEffort === false &&
		c.supportsUsageInStreaming === false &&
		c.supportsStrictMode === false &&
		c.maxTokensField === "max_tokens" &&
		c.sendSessionAffinityHeaders === undefined &&
		c.sessionAffinityFormat === undefined &&
		c.supportsLongCacheRetention === undefined
	);
}

function isOfficialOpenAI(m: RtModel): boolean {
	const value = String(m.baseUrl ?? "")
		.trim()
		.toLowerCase();
	if (!value) return lower(m.provider) === "openai";
	try {
		return new URL(value).hostname === "api.openai.com";
	} catch {
		return value === "api.openai.com" || value.startsWith("api.openai.com/");
	}
}

function isOpenRouter(m: RtModel): boolean {
	return (
		lower(m.provider) === "openrouter" ||
		lower(m.baseUrl).includes("openrouter.ai")
	);
}

/**
 * Compat suggestion for one merged model — priority chain & semantics
 * identical to pi-cache-optimizer's describeMissingCacheCompatForModel +
 * adapter warningText. Deliberate deviation: sendSessionAffinityHeaders is
 * only set when undefined (explicit false = anti-403 opt-out; see the
 * comment on describeMissingOpenAICompatibleProxyCompat in cache-optimizer).
 */
export function suggestCompat(m: RtModel): Compat {
	const api = lower(m.api);
	const compat = m.compat ?? {};
	const tokens = tokensOf(m);
	const out: Compat = {};

	// 0. Long cache retention — universal, no provider-name special cases.
	// Anthropic natively supports 1h cache TTL; official OpenAI accepts
	// prompt_cache_retention. Other OpenAI-compatible channels may 400 on it
	// (e.g. Fireworks uses automatic prompt caching). pi defaults this to true
	// when undeclared, so declare it explicitly to make the effective value
	// deterministic. Explicit user values are respected (checked above);
	// built-in llama.cpp is not official OpenAI and correctly gets false —
	// it has no retention parameter either.
	if (compat.supportsLongCacheRetention === undefined) {
		out.supportsLongCacheRetention =
			lower(api) === "anthropic-messages" || isOfficialOpenAI(m);
	}

	// 0b. Developer role — channel capability, not a model trait. Pi sends the
	// instruction prompt as role "developer" for reasoning models unless
	// supportsDeveloperRole is false (openai-completions) / not true
	// (openai-responses). Its detectCompat defaults that flag to true for
	// providers outside its known non-standard list, but many third-party
	// OpenAI-compatible routers accept only system|user|assistant|tool and
	// answer 400 `messages.0.role: Invalid option` (e.g. Enclave/Cyberouter).
	// "system" is accepted by every OpenAI-compatible channel, so declaring
	// false is the safe default. Official OpenAI keeps the native developer
	// role; OpenRouter is excluded because Pi deliberately keeps developer for
	// its anthropic/openai models.
	if (
		m.reasoning === true &&
		isOpenAICompatibleApi(api) &&
		compat.supportsDeveloperRole === undefined &&
		!isOfficialOpenAI(m) &&
		!isOpenRouter(m)
	) {
		out.supportsDeveloperRole = false;
	}

	// 1. Adaptive thinking (only relevant on anthropic-messages).
	if (
		lower(api) === "anthropic-messages" &&
		(isAdaptiveGeneration(tokens) || isKimiCodingAdaptive(m))
	) {
		if (compat.forceAdaptiveThinking !== true) out.forceAdaptiveThinking = true;
		if (isKimiCodingEmptySignature(m) && compat.allowEmptySignature !== true)
			out.allowEmptySignature = true;
		return out;
	}

	// 2. DeepSeek-like on OpenAI-compatible APIs.
	if (isDeepSeekLike(tokens) && isOpenAICompatibleApi(api) && !isPiBuiltInLlamaCpp(m)) {
		if (
			lower(api) === "openai-completions" &&
			compat.sendSessionAffinityHeaders === undefined
		)
			out.sendSessionAffinityHeaders = true;
		if (compat.requiresReasoningContentOnAssistantMessages !== true)
			out.requiresReasoningContentOnAssistantMessages = true;
		if (compat.thinkingFormat !== "deepseek") out.thinkingFormat = "deepseek";
		return out;
	}

	// 3. Claude-like on OpenAI-compatible proxy ("claude" adapter warningText).
	if (isClaudeLike(tokens) && isOpenAICompatibleApi(api) && !isPiBuiltInLlamaCpp(m)) {
		if (compat.cacheControlFormat !== "anthropic")
			out.cacheControlFormat = "anthropic";
	}

	// 4. Non-official OpenAI-compatible proxy.
	if (
		lower(api) === "openai-completions" &&
		!isOfficialOpenAI(m) &&
		!isPiBuiltInLlamaCpp(m) &&
		compat.sendSessionAffinityHeaders === undefined
	) {
		out.sendSessionAffinityHeaders = true;
	}

	return out;
}

// ── models.json types ───────────────────────────────────────────────

// models.json is schema-free JSON; these minimal types capture the structure
// this extension uses without hiding runtime checks.
interface ProviderEntry {
	baseUrl?: unknown;
	api?: unknown;
	models?: unknown;
	modelOverrides?: unknown;
	compat?: Compat;
	[key: string]: unknown;
}
interface ModelEntry {
	id?: unknown;
	reasoning?: unknown;
	thinkingLevelMap?: unknown;
	compat?: Compat;
	[key: string]: unknown;
}
interface ModelsConfig {
	providers?: Record<string, unknown>;
}

// ── models.json IO ──────────────────────────────────────────────────

/** Read & parse models.json. Returns null if missing or invalid. */
function loadModelsConfig(): ModelsConfig | null {
	if (!existsSync(MODELS_JSON)) return null;
	let raw: string;
	try {
		raw = readFileSync(MODELS_JSON, "utf8");
	} catch {
		return null;
	}
	if (!raw.trim()) return null;

	let cfg: ModelsConfig;
	try {
		cfg = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
	cfg.providers ??= {};
	return cfg;
}

/** Keep at most N newest backups (Date.now() suffix → lexicographic = chronological). */
function pruneBackups(keep = 3): void {
	try {
		const prefix = "models.json.bak-auto-compat-";
		const backups = readdirSync(getAgentDir())
			.filter((f: string) => f.startsWith(prefix))
			.sort();
		for (const f of backups.slice(0, Math.max(0, backups.length - keep))) {
			try {
				unlinkSync(join(getAgentDir(), f));
			} catch {
				// failing to delete an old backup is not fatal
			}
		}
	} catch {
		// ignore
	}
}

/** Backup + write. Returns an error message on failure. */
function writeModelsConfig(cfg: ModelsConfig): string | null {
	try {
		copyFileSync(MODELS_JSON, `${MODELS_JSON}.bak-auto-compat-${Date.now()}`);
		writeFileSync(MODELS_JSON, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
		pruneBackups();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return null;
}

// ── Fix placement & application ─────────────────────────────────────

/**
 * Fix placement — mirrors pi-cache-optimizer's decideFixPlacement, with the
 * sibling list taken from the registry (a superset of models.json, so
 * API-login providers with many models are handled safely too). Model-level
 * if: a behavior key doesn't fit every sibling, OR the model level already
 * contains one of the target keys (provider cannot override
 * models[]/modelOverrides).
 */
function decidePlacement(
	keys: string[],
	siblings: RtModel[],
	modelEntry: ModelEntry | undefined,
	overrideCompat: Compat | undefined,
): "provider" | "model" {
	const existing = { ...(overrideCompat ?? {}), ...(modelEntry?.compat ?? {}) };
	if (keys.some((k) => k in existing)) return "model";

	const list = siblings.filter((m) => m && m.id);
	if (list.length <= 1) return "provider";

	const all = (pred: (m: RtModel) => boolean) => list.every(pred);
	for (const k of keys) {
		if (PROVIDER_SAFE_KEYS.has(k)) continue;
		if (k === "forceAdaptiveThinking") {
			if (!all((s) => isAdaptiveGeneration(tokensOf(s)) || isKimiCodingAdaptive(s)))
				return "model";
			continue;
		}
		if (k === "allowEmptySignature") {
			if (!all(isKimiCodingAdaptive)) return "model";
			continue;
		}
		if (k === "thinkingFormat" || k === "requiresReasoningContentOnAssistantMessages") {
			if (!all((s) => isDeepSeekLike(tokensOf(s)))) return "model";
			continue;
		}
		if (k === "cacheControlFormat") {
			if (!all((s) => isClaudeLike(tokensOf(s)))) return "model";
			continue;
		}
		return "model"; // unknown behavior key → stay conservative
	}
	return "provider";
}

/** Apply one compat suggestion to cfg. Returns the detail line. */
function applyModelFix(
	cfg: ModelsConfig,
	model: RtModel,
	siblings: RtModel[],
	suggestion: Compat,
	forceOverride = false,
): string | undefined {
	const providers = (cfg.providers ??= {}) as Record<string, ProviderEntry>;
	const entry = (providers[model.provider] ??= {}); // minimal compat-only entry if absent

	const models = Array.isArray(entry.models)
		? (entry.models as unknown[])
		: undefined;
	const modelEntry = models?.find(
		(me): me is ModelEntry =>
			!!me && typeof me === "object" && !Array.isArray(me) && String(me.id) === model.id,
	);
	const overrides =
		entry.modelOverrides &&
		typeof entry.modelOverrides === "object" &&
		!Array.isArray(entry.modelOverrides)
			? (entry.modelOverrides as Record<string, ModelEntry>)
			: undefined;
	const overrideCompat = overrides?.[model.id]?.compat;

	const keys = Object.keys(suggestion);
	// Provider-level compat never reaches the merged model when the provider's
	// model list is owned by an extension — modelOverrides is the only layer
	// that lands (see extensionOwnsModels).
	const placement: "provider" | "model" | "override" = forceOverride
		? "override"
		: decidePlacement(keys, siblings, modelEntry, overrideCompat);

	if (placement === "provider") {
		const pc = (entry.compat ??= {});
		Object.assign(pc, suggestion);
		return `providers["${model.provider}"].compat += ${keys.join(", ")}`;
	}

	if (placement === "model" && modelEntry) {
		const mc = (modelEntry.compat ??= {});
		Object.assign(mc, suggestion);
		return `providers["${model.provider}"].models["${model.id}"].compat += ${keys.join(", ")}`;
	}

	const mo = (entry.modelOverrides ??= {}) as Record<string, ModelEntry>;
	const oe = (mo[model.id] ??= {});
	const oc = (oe.compat ??= {});
	Object.assign(oc, suggestion);
	return `providers["${model.provider}"].modelOverrides["${model.id}"].compat += ${keys.join(", ")}`;
}

/** Static rule: models.json reasoning model without thinkingLevelMap → default map. */
function applyThinkingLevelMaps(cfg: ModelsConfig): string[] {
	const detail: string[] = [];
	for (const [providerId, providerRaw] of Object.entries(cfg.providers ?? {})) {
		if (!providerRaw || typeof providerRaw !== "object" || Array.isArray(providerRaw))
			continue;
		const entry = providerRaw as unknown as ProviderEntry;
		for (const modelRaw of Array.isArray(entry.models) ? entry.models : []) {
			if (!modelRaw || typeof modelRaw !== "object" || Array.isArray(modelRaw))
				continue;
			const m = modelRaw as unknown as ModelEntry;
			if (m.reasoning !== true) continue;
			const map = m.thinkingLevelMap;
			const needsMap =
				!map ||
				typeof map !== "object" ||
				Array.isArray(map) ||
				Object.keys(map).length === 0;
			if (needsMap) {
				m.thinkingLevelMap = { ...THINKING_MAP };
				detail.push(`providers["${providerId}"].models["${String(m.id)}"].thinkingLevelMap`);
			}
		}
	}
	return detail;
}

/** Check & patch models.json for a list of merged models. */
export function fixModelsConfig(
	models: RtModel[],
	siblingsByProvider?: Map<string, RtModel[]>,
	forceOverrides?: (provider: string) => boolean,
): { changed: boolean; detail: string[] } {
	const cfg = loadModelsConfig();
	if (!cfg || !cfg.providers) return { changed: false, detail: [] };

	const detail: string[] = [];
	detail.push(...applyThinkingLevelMaps(cfg));

	for (const m of models) {
		const suggestion = suggestCompat(m);
		if (!Object.keys(suggestion).length) continue;
		const siblings =
			siblingsByProvider?.get(lower(m.provider)) ?? [m];
		const line = applyModelFix(
			cfg,
			m,
			siblings,
			suggestion,
			forceOverrides?.(m.provider) ?? false,
		);
		if (line) detail.push(line);
	}

	if (detail.length === 0) return { changed: false, detail };

	const err = writeModelsConfig(cfg);
	if (err) return { changed: false, detail: [`WRITE FAILED: ${err}`] };
	return { changed: true, detail };
}

// ── Extension ───────────────────────────────────────────────────────

// Sync subset of the ctx.modelRegistry facade this extension uses.
interface RegistryLike {
	getAll?: () => unknown[];
	refresh?: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
	getRegisteredProviderConfig?: (provider: string) => unknown;
}

function registryOf(ctx: ExtensionContext | undefined): RegistryLike | undefined {
	return (ctx as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry;
}

/**
 * True when an extension-registered provider supplies its own model list
 * (`models` array now, or later via `refreshModels`). Pi's provider-composer
 * applies such lists AFTER models.json (applyExtension replaces the model
 * list wholesale), so provider-level compat and models[].compat are dropped
 * from the merged model — only modelOverrides survive. Compat fixes for
 * these providers must go to modelOverrides.
 */
function extensionOwnsModels(
	registry: RegistryLike | undefined,
	provider: string,
): boolean {
	try {
		const cfg = registry?.getRegisteredProviderConfig?.(provider);
		if (!cfg || typeof cfg !== "object") return false;
		return (
			Array.isArray((cfg as { models?: unknown }).models) ||
			typeof (cfg as { refreshModels?: unknown }).refreshModels === "function"
		);
	} catch {
		return false;
	}
}

function registryModels(ctx: ExtensionContext | undefined): RtModel[] {
	const all = registryOf(ctx)?.getAll?.() ?? [];
	return all.filter((m): m is RtModel => !!m && typeof m === "object");
}

function groupByProvider(models: RtModel[]): Map<string, RtModel[]> {
	const map = new Map<string, RtModel[]>();
	for (const m of models) {
		if (!m || !m.provider || !m.id) continue;
		const list = map.get(lower(m.provider)) ?? [];
		list.push(m);
		map.set(lower(m.provider), list);
	}
	return map;
}

/**
 * Scan targets: all registry models of providers that already have a
 * models.json entry (channels the user opted into) OR whose model list is
 * owned by an extension (registered provider with its own `models` /
 * `refreshModels`), + the active model of any provider. Models of other
 * providers (built-in catalog proxies) get patched when selected/active — no
 * entries are created for dozens of unused built-in providers.
 */
function scanTargets(ctx: ExtensionContext | undefined): RtModel[] {
	const known = new Set(
		Object.keys(loadModelsConfig()?.providers ?? {}).map(lower),
	);
	const registry = registryOf(ctx);
	const seen = new Set<string>();
	const out: RtModel[] = [];
	const push = (m: RtModel | undefined): void => {
		if (!m?.provider || !m.id) return;
		const k = `${lower(m.provider)}\0${m.id}`;
		if (seen.has(k)) return;
		seen.add(k);
		out.push(m);
	};
	for (const m of registryModels(ctx)) {
		if (known.has(lower(m.provider)) || extensionOwnsModels(registry, m.provider)) push(m);
	}
	push(ctx?.model as RtModel | undefined);
	return out;
}

// ── Windows Cache-Optimizer Atomic-Rename Fix ─────────────────────────

const SAFE_RENAME_BLOCK = String.raw`export async function safeAtomicRename(tempPath: string, destPath: string, maxRetries = 5): Promise<void> {
  let renamed = false;
  try {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await rename(tempPath, destPath);
        renamed = true;
        return;
      } catch (err: any) {
        const code = err?.code;
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)));
          continue;
        }
        // copyFile does not fail on a briefly-held destination, but it
        // truncates in place, so a crash mid-copy can leave a partial shard.
        // Readers skip malformed shards and the next update publishes a
        // complete replacement, so that beats losing persistence entirely.
        await copyFile(tempPath, destPath);
        renamed = true;
        return;
      }
    }
  } finally {
    if (renamed) await unlink(tempPath).catch(() => {});
  }
}

export async function writeStatsShardV7(path: string, shard: PersistedStatsShardV7): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, JSON.stringify(shard, null, 2) + "\n", "utf8");
  await safeAtomicRename(tempPath, path);
}`;
// Anchor on the column-zero closing brace so nested blocks inside the function
// body cannot terminate the match early. `export` must stay outside the match:
// swallowing it would leave writeStatsShardV7 unexported and break index.ts.
const WRITER_PATTERN =
	/(?:export )?async function writeStatsShardV7\([^)]*\)[^{]*\{[\s\S]*?\n\}/;

// The injected helper needs copyFile, which stats-store.ts does not import.
const NODE_FS_IMPORT_PATTERN = /import \{([^}]*)\} from "node:fs\/promises";/;

const PATCH_REGION =
	/(?:export )?async function safeAtomicRename\([^)]*\)[^{]*\{[\s\S]*?\n\}\s*\n\s*(?:export )?async function writeStatsShardV7\([^)]*\)[^{]*\{[\s\S]*?\n\}/;

// A previously generated patch could corrupt the `+"\n"` escape into a real
// newline, producing a file that no longer parses. Detect it so we overwrite
// the whole safeAtomicRename region instead of trusting the marker alone.
const BROKEN_ESCAPE = /\+\s*"\s*\r?\n/;

// `writeStatsShardV7` moved out of index.ts into src/stats-store.ts in
// pi-cache-optimizer 2.8.18. Patching only index.ts silently no-ops and the
// EPERM keeps coming back, so try the owning module first.
const WRITER_MODULE_CANDIDATES = [
	"npm/node_modules/pi-cache-optimizer/src/stats-store.ts",
	"npm/node_modules/pi-cache-optimizer/index.ts",
];

function ensureCopyFileImport(content: string): string {
	const match = NODE_FS_IMPORT_PATTERN.exec(content);
	if (!match) return content;
	const names = match[1].split(",").map((name) => name.trim()).filter(Boolean);
	if (names.includes("copyFile")) return content;
	names.push("copyFile");
	names.sort();
	return content.replace(NODE_FS_IMPORT_PATTERN, `import { ${names.join(", ")} } from "node:fs/promises";`);
}

function patchWriterModule(targetPath: string): boolean {
	if (!existsSync(targetPath)) return false;
	let content: string;
	let next: string;
	try {
		content = readFileSync(targetPath, "utf8");
		if (content.includes("safeAtomicRename")) {
			// Already patched, but an older revision could have corrupted the
			// `+"\n"` escape. Rebuild both functions from the known-good text.
			if (!BROKEN_ESCAPE.test(content)) return false;
			next = content.replace(PATCH_REGION, SAFE_RENAME_BLOCK);
		} else {
			// The helper does not exist yet, so insert it together with the
			// replacement writer. Splitting on the function header keeps the
			// `export` keyword outside the match.
			const splitAt = SAFE_RENAME_BLOCK.indexOf("export async function writeStatsShardV7");
			next = content.replace(WRITER_PATTERN, SAFE_RENAME_BLOCK.slice(0, splitAt) + SAFE_RENAME_BLOCK.slice(splitAt));
		}
		next = ensureCopyFileImport(next);
		if (next === content) return false;
		writeFileSync(targetPath, next, "utf8");
		return true;
	} catch {
		// Non-fatal if the package is read-only or temporarily unavailable.
		return false;
	}
}

/**
 * On Windows, NTFS/Win32 rename throws EPERM/EBUSY when the destination shard
 * is briefly held open by a reader. pi-cache-optimizer re-reads the shard
 * directory on every stats refresh, including the shard it is renaming, so
 * the writer needs a retry. Patch the module that owns writeStatsShardV7 and
 * remove only genuinely orphaned `.tmp` shards.
 */
export function patchCacheOptimizerWindows(): boolean {
	if (process.platform !== "win32") return false;

	const agentDir = getAgentDir();
	const patched = WRITER_MODULE_CANDIDATES.map((relative) =>
		patchWriterModule(join(agentDir, relative)),
	).some(Boolean);

	try {
		const shardsDir = join(agentDir, "pi-cache-optimizer-stats.d", "shards");
		if (existsSync(shardsDir)) {
			const orphanCutoff = Date.now() - 60 * 60 * 1000;
			for (const name of readdirSync(shardsDir)) {
				if (!name.endsWith(".tmp")) continue;
				const tmpPath = join(shardsDir, name);
				try {
					// A live writer's tmp file lives for one rename round-trip, so
					// anything older than an hour is an orphan, not a race.
					if (statSync(tmpPath).mtimeMs > orphanCutoff) continue;
					unlinkSync(tmpPath);
				} catch {
					// ignore if currently locked
				}
			}
		}
	} catch {
		// ignore
	}

	return patched;
}

export default function autoCompat(pi: ExtensionAPI) {
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let widgetTimer: ReturnType<typeof setTimeout> | undefined;
	let notifiedThisSession = false;
	// Anti-loop guard: suggestions already written this session are not
	// rewritten even if the registry refresh failed.
	const applied = new Set<string>();

function notify(
		ctx: ExtensionContext | undefined,
		message: string,
		kind: "info" | "warning" | "success" = "info",
	) {
		// ctx getters throw once the session was replaced/reloaded (runner
		// assertActive), so capture the ui object while the ctx is live and
		// guard the deferred dismissal too — an escaped throw from a timer
		// callback crashes Pi (uncaughtException).
		let ui: ExtensionContext["ui"] | undefined;
		try {
			ui = ctx?.ui;
			ui?.setWidget?.("auto-compat", [`auto-compat: ${message}`]);
		} catch {
			return; // stale or non-UI ctx: nothing to show or dismiss
		}
		if (widgetTimer) clearTimeout(widgetTimer);
		widgetTimer = setTimeout(() => {
			widgetTimer = undefined;
			try {
				ui?.setWidget?.("auto-compat", undefined);
			} catch {
				// session was replaced while the widget was up; nothing to dismiss
			}
		}, 10_000);
	}

	async function runFix(
		ctx: ExtensionContext,
		models: RtModel[],
	): Promise<{ changed: boolean; detail: string[] }> {
		const targets = models.filter((m) => {
			const keys = Object.keys(suggestCompat(m)).sort();
			if (!keys.length) return false;
			const sig = `${lower(m.provider)}\0${m.id}\0${keys.join(",")}`;
			if (applied.has(sig)) return false;
			applied.add(sig);
			return true;
		});
		if (!targets.length) return { changed: false, detail: [] };

		const registry = registryOf(ctx);
		const { changed, detail } = fixModelsConfig(
			targets,
			groupByProvider(registryModels(ctx)),
			(provider) => extensionOwnsModels(registry, provider),
		);
		if (!changed) return { changed, detail };

		// No chat/console output — the status is shown via ctx.ui.setWidget() above
		// the chat input, set by the notify() call below.

		let refreshed = true;
		try {
			await registry?.refresh?.({ allowNetwork: false });
		} catch {
			refreshed = false;
		}
		if (!notifiedThisSession) {
			notifiedThisSession = true;
			notify(
				ctx,
				refreshed
					? `models.json auto-fixed (${detail.length} change(s)); registry refreshed.`
					: "models.json auto-fixed. Run /reload to load it.",
				refreshed ? "success" : "warning",
			);
		}
		return { changed: true, detail };
	}

	// Every ctx getter (ui, modelRegistry, model, …) throws once the session
	// was replaced or reloaded (runner assertActive). Deferred calls (debounce
	// timer, file watcher, startup) may fire with a stale captured ctx — never
	// let that throw escape or reject a floating promise.
	function runFixSafe(ctx: ExtensionContext, models?: RtModel[]): void {
		try {
			const list = models ?? scanTargets(ctx);
			runFix(ctx, list).catch(() => undefined);
		} catch {
			// stale ctx — the new session's session_start re-runs the fix
		}
	}

	function scheduleFix(ctx: ExtensionContext) {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			runFixSafe(ctx);
		}, 800);
	}

	function startWatcher(ctx: ExtensionContext) {
		stopWatcher();
		notifiedThisSession = false;
		applied.clear();
		runFixSafe(ctx); // check once at startup

		try {
			watcher = watch(
				MODELS_JSON,
				{ persistent: false },
				() => {
					scheduleFix(ctx);
				},
			);
		} catch {
			// models.json missing / not watchable
		}
	}

	function stopWatcher() {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (widgetTimer) {
			clearTimeout(widgetTimer);
			widgetTimer = undefined;
		}
		if (watcher) {
			try {
				watcher.close();
			} catch {
				// already closed
			}
			watcher = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		patchCacheOptimizerWindows();
		startWatcher(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const model = (event as { model?: RtModel } | undefined)?.model;
		if (model) runFixSafe(ctx, [model]);
	});

	pi.on("session_shutdown", () => {
		stopWatcher();
	});

	pi.registerCommand("auto-compat", {
		description:
			"Check & fix compat/thinkingLevelMap in models.json (detection mirrors pi-cache-optimizer), then refresh the registry",
		handler: async (_args, ctx) => {
			const targets = scanTargets(ctx);
			// Force re-run even if already applied this session.
			for (const m of targets) {
				const keys = Object.keys(suggestCompat(m)).sort();
				if (keys.length)
					applied.delete(`${lower(m.provider)}\0${m.id}\0${keys.join(",")}`);
			}
			const { changed, detail } = await runFix(ctx, targets);
			const patched = patchCacheOptimizerWindows();
			if (patched) {
				detail.push("pi-cache-optimizer Windows file-lock patch applied");
			}
			if (changed || patched) {
				notify(ctx, `fixed:\n  - ${detail.join("\n  - ")}`, "success");
				return;
			}
			notify(ctx, "nothing to fix.", "info");
		},
	});
}
