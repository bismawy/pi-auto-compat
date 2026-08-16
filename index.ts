/**
 * auto-compat — Pi extension
 *
 * Universal auto-compat fixer for models.json — registry-driven.
 *
 * Detection & suggestions mirror pi-cache-optimizer (same priority chain),
 * so every source of the ⚠️ compat footer marker / model_select warnings
 * is covered:
 *
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

/**
 * Compat suggestion for one merged model — priority chain & semantics
 * identical to pi-cache-optimizer's describeMissingCacheCompatForModel +
 * adapter warningText. Deliberate deviation: sendSessionAffinityHeaders is
 * only set when undefined (explicit false = anti-403 opt-out; see the
 * comment on describeMissingOpenAICompatibleProxyCompat in cache-optimizer).
 */
function suggestCompat(m: RtModel): Compat {
	const api = lower(m.api);
	const compat = m.compat ?? {};
	const tokens = tokensOf(m);
	const out: Compat = {};

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
		if (compat.supportsLongCacheRetention !== true)
			out.supportsLongCacheRetention = true;
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
	const placement = decidePlacement(keys, siblings, modelEntry, overrideCompat);

	if (placement === "provider") {
		const pc = (entry.compat ??= {});
		Object.assign(pc, suggestion);
		return `providers["${model.provider}"].compat += ${keys.join(", ")}`;
	}

	if (modelEntry) {
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
		const line = applyModelFix(cfg, m, siblings, suggestion);
		if (line) detail.push(line);
	}

	if (detail.length === 0) return { changed: false, detail };

	const err = writeModelsConfig(cfg);
	if (err) return { changed: false, detail: [`WRITE FAILED: ${err}`] };
	return { changed: true, detail };
}

// ── Extension ───────────────────────────────────────────────────────

interface RegistryLike {
	getAll?: () => unknown[];
}

function registryModels(ctx: ExtensionContext | undefined): RtModel[] {
	const registry = (ctx as { modelRegistry?: RegistryLike } | undefined)
		?.modelRegistry;
	const all = registry?.getAll?.() ?? [];
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
 * models.json entry (channels the user opted into) + the active model of any
 * provider. Models of providers without an entry get patched when selected/
 * active — no entries are created for dozens of unused built-in providers.
 */
function scanTargets(ctx: ExtensionContext | undefined): RtModel[] {
	const known = new Set(
		Object.keys(loadModelsConfig()?.providers ?? {}).map(lower),
	);
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
		if (known.has(lower(m.provider))) push(m);
	}
	push(ctx?.model as RtModel | undefined);
	return out;
}

export default function autoCompat(pi: ExtensionAPI) {
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let notifiedThisSession = false;
	// Anti-loop guard: suggestions already written this session are not
	// rewritten even if the registry refresh failed.
	const applied = new Set<string>();

	function notify(
		ctx: ExtensionContext | undefined,
		message: string,
		kind: "info" | "warning" | "success" = "info",
	) {
		try {
			// Render in the footer/status bar (like the git branch/ponytail indicators),
			// not the chat area. setStatus is a persistent dim line in the status bar.
			ctx?.ui?.setStatus?.("auto-compat", message);
		} catch {
			// non-UI mode: ignore
		}
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

		const { changed, detail } = fixModelsConfig(
			targets,
			groupByProvider(registryModels(ctx)),
		);
		if (!changed) return { changed, detail };

		// No chat/console output — the status is shown via ctx.ui.setStatus() in the
		// footer status bar, set by the notify() call below.

		let refreshed = true;
		try {
			await ctx.modelRegistry?.refresh?.({ allowNetwork: false });
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

	function scheduleFix(ctx: ExtensionContext) {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void runFix(ctx, scanTargets(ctx));
		}, 800);
	}

	function startWatcher(ctx: ExtensionContext) {
		stopWatcher();
		notifiedThisSession = false;
		applied.clear();
		void runFix(ctx, scanTargets(ctx)); // check once at startup

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
		startWatcher(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const model = (event as { model?: RtModel } | undefined)?.model;
		if (model) void runFix(ctx, [model]);
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
			if (changed) {
				notify(ctx, `fixed:\n  - ${detail.join("\n  - ")}`, "success");
				return;
			}
			notify(ctx, "nothing to fix.", "info");
		},
	});
}
