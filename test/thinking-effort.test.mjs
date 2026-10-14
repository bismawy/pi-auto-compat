import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// getAgentDir() is read when the module loads, so point it at a throwaway
// agent dir before the dynamic import below.
const agentDir = mkdtempSync(join(tmpdir(), "auto-compat-effort-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	buildEffortMap,
	nearestEffort,
	probeThinkingEffort,
	default: autoCompat,
} = await import("../extensions/index.ts");

// ── pure mapping ────────────────────────────────────────────────────

test("nearestEffort: prefers the next higher level, ties go lower", () => {
	const accepted = new Set(["low", "high", "max"]);
	assert.equal(nearestEffort("medium", accepted), "high");
	assert.equal(nearestEffort("minimal", accepted), "low");
	assert.equal(nearestEffort("high", accepted), "high");
	// max is above high, so xhigh clamps up to max.
	assert.equal(nearestEffort("xhigh", accepted), "max");
	// low is below minimal, so minimal goes up to low, never down to none.
	assert.equal(nearestEffort("minimal", new Set(["none", "low"])), "low");
});

test("buildEffortMap: rejected levels remap, opt-in levels are followed not invented", () => {
	// Enclave/deepseek-v4.1-flash on Together: minimal + medium are rejected.
	const map = buildEffortMap({ xhigh: "xhigh" }, ["none", "low", "high", "xhigh", "max"]);
	// minimal → low is the nearest active mapping; medium → high is forced
	// because its nearer candidate (low) is already sent by a real level.
	assert.deepEqual(map, { minimal: "low", medium: "high", xhigh: "xhigh" });
});

test("buildEffortMap: a level that works stays unmapped", () => {
	assert.equal(
		buildEffortMap(undefined, ["none", "minimal", "low", "medium", "high"]),
		undefined,
	);
});

test("buildEffortMap: off is only touched where the model declares it", () => {
	// `none` accepted but the user never enabled `off` → leave /thinking alone.
	assert.equal(
		buildEffortMap(undefined, ["none", "minimal", "low", "medium", "high"]),
		undefined,
	);
	// A deliberate opt-out stays an opt-out.
	assert.equal(buildEffortMap({ off: null }, ["none", "minimal", "low", "medium", "high"]), undefined);
	// A declared wire value is validated like any other level.
	assert.deepEqual(
		buildEffortMap({ off: "minimal" }, ["none", "low", "medium", "high"]),
		{ off: "none", minimal: "low" },
	);
});

test("buildEffortMap: a declared xhigh is verified, not guessed", () => {
	const levels = ["none", "minimal", "low", "medium", "high"];
	// No evidence about the declared value yet.
	assert.equal(buildEffortMap({ xhigh: "high" }, levels), undefined);
	// The probe tested xhigh and the channel accepted it verbatim.
	assert.equal(buildEffortMap({ xhigh: "xhigh" }, [...levels, "xhigh"]), undefined);
	// …and rewrites it when the channel rejects it.
	assert.deepEqual(buildEffortMap({ xhigh: "xhigh" }, [...levels, "max"]), {
		xhigh: "max",
	});
});

test("buildEffortMap: nothing answered is not a capability", () => {
	assert.equal(buildEffortMap(undefined, []), undefined);
});

test("buildEffortMap: a complete map means no write", () => {
	assert.equal(
		buildEffortMap(undefined, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
		undefined,
	);
});

test("buildEffortMap: an existing remap is preserved, not undone", () => {
	assert.deepEqual(buildEffortMap({ medium: "high" }, ["none", "low", "high"]), {
		minimal: "low",
		medium: "high",
	});
});

test("buildEffortMap: a map the probe cannot improve is not rewritten", () => {
	assert.equal(
		buildEffortMap({ medium: "high" }, ["none", "minimal", "low", "medium", "high"]),
		undefined,
	);
});

// ── end to end against a local server ───────────────────────────────

const provider = "effortchan";
let server;
let requests = 0;
// Levels this fake upstream rejects with 400 (like Together's subset).
let rejected = new Set(["minimal", "medium"]);

function writeConfig() {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[provider]: {
						baseUrl: `http://127.0.0.1:${server.address().port}`,
						api: "openai-completions",
						apiKey: "dummy",
						models: [{ id: "probe-me", reasoning: true }],
					},
				},
			},
			null,
			2,
		),
	);
}

function registry() {
	const all = [
		{
			provider,
			id: "probe-me",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${server.address().port}`,
			reasoning: true,
		},
	];
	return {
		modelRegistry: {
			getAll: () => all,
			refresh: async () => undefined,
			getRegisteredProviderConfig: () => undefined,
		},
	};
}

test.before(async () => {
	server = createServer((req, res) => {
		requests += 1;
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const parsed = JSON.parse(body);
			res.setHeader("content-type", "application/json");
			if (rejected.has(parsed.reasoning_effort)) {
				res.statusCode = 400;
				res.end(JSON.stringify({ error: { message: "unsupported reasoning_effort" } }));
				return;
			}
			res.end(JSON.stringify({ id: "ok", choices: [] }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	writeConfig();
});

test("probeThinkingEffort: writes remaps for rejected levels and refreshes", async () => {
	const result = await probeThinkingEffort(registry(), true);
	assert.equal(result.changed, true);
	assert.equal(result.errors.length, 0);

	const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	const map = cfg.providers[provider].models[0].thinkingLevelMap;
	assert.equal(map.minimal, "low");
	assert.equal(map.medium, "high");
	// A working level is never pinned to its identity value.
	assert.equal(map.low, undefined);
	assert.equal(map.high, undefined);
});

test("probeThinkingEffort: a deliberate remap is never rewritten", async () => {
	const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	cfg.providers[provider].models[0].thinkingLevelMap = { medium: "high" };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(cfg, null, 2));

	rejected = new Set(["low"]);
	const before = requests;
	const result = await probeThinkingEffort(registry(), true);
	assert.equal(result.changed, false);
	assert.equal(requests, before, "a manual map must not trigger a re-probe");

	const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	assert.deepEqual(after.providers[provider].models[0].thinkingLevelMap, { medium: "high" });
});

test("probeThinkingEffort: a transient 500 never marks a level accepted", async () => {
	const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	cfg.providers[provider].models[0].thinkingLevelMap = { xhigh: "xhigh" };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(cfg, null, 2));

	server.close();
	server = createServer((req, res) => {
		requests += 1;
		res.statusCode = 500;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ error: { message: "internal error" } }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	const result = await probeThinkingEffort(registry(), true);
	assert.equal(result.changed, false);
	assert.equal(result.errors.length, 1);
	assert.deepEqual(result.detail, []);

	const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	assert.deepEqual(after.providers[provider].models[0].thinkingLevelMap, { xhigh: "xhigh" });
});

test("probeThinkingEffort: honors the TTL on a non-forced run", async () => {
	server.close();
	server = createServer((req, res) => {
		requests += 1;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ id: "ok", choices: [] }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	// A fresh "noop" result from the transient test above must not be re-probed.
	const before = requests;
	await probeThinkingEffort(registry(), false);
	assert.equal(requests, before);
});

test("probeThinkingEffort: a channel that never answers is stamped, not re-probed every run", async () => {
	server.close();
	server = createServer((_req, res) => {
		requests += 1;
		res.statusCode = 401;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ error: { message: "unauthorized" } }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	rmSync(join(agentDir, "pi-auto-compat-sync.json"), { force: true });
	writeConfig();

	let before = requests;
	let result = await probeThinkingEffort(registry(), false);
	assert.equal(requests - before, 7, "a never-answered channel costs one probe per level");
	assert.equal(result.errors.length, 1);

	// Without a stamp every model_select would send those 7 requests again.
	before = requests;
	result = await probeThinkingEffort(registry(), false);
	assert.equal(requests, before, "a stamped failure is not re-probed on the next run");
	assert.deepEqual(result.errors, []);

	// The stamp expires, so a recovered channel is discovered again.
	const statePath = join(agentDir, "pi-auto-compat-sync.json");
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	const key = Object.keys(state.efforts)[0];
	assert.equal(state.efforts[key].failed, true);
	state.efforts[key].at = 0;
	writeFileSync(statePath, JSON.stringify(state, null, 2));

	before = requests;
	result = await probeThinkingEffort(registry(), false);
	assert.equal(requests - before, 7, "an expired failure is retried");
	assert.equal(result.errors.length, 1);
});

test.after(() => {
	server?.close();
	rmSync(agentDir, { recursive: true, force: true });
});

// ── reactive path: a failed inference triggers the probe ────────────

// The assistant message Pi emits after a rejected parameter. Only
// `provider`/`model`/`errorMessage` are read by the handler.
function messageEnd(providerId, modelId, errorMessage) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			provider: providerId,
			model: modelId,
			errorMessage,
		},
	};
}

function extensionCtx() {
	const registryCtx = registry();
	return {
		ui: { setWidget: () => undefined },
		model: { provider, id: "probe-me", reasoning: true },
		modelRegistry: {
			...registryCtx.modelRegistry,
			// The regression that `message_end` used to hide: the registry model
			// carries `reasoning`/`api`, the synthetic event payload does not.
		},
	};
}

test("message_end: a parameter rejection re-probes the model", async () => {
	server.close();
	let posted = 0;
	server = createServer((req, res) => {
		posted += 1;
		req.resume();
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ id: "ok", choices: [] }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	const port = server.address().port;
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[provider]: {
						baseUrl: `http://127.0.0.1:${port}`,
						api: "openai-completions",
						apiKey: "dummy",
						models: [{ id: "probe-me", reasoning: true }],
					},
				},
			},
			null,
			2,
		),
	);

	const handlers = new Map();
	autoCompat({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: () => undefined,
	});

	const ctx = extensionCtx();
	ctx.modelRegistry.getAll = () => [
		{
			provider,
			id: "probe-me",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${port}`,
			reasoning: true,
		},
	];

	handlers.get("message_end")(
		messageEnd(provider, "probe-me", "502 provider_error: 400 unsupported reasoning_effort"),
		ctx,
	);

	// The probe runs as a floating promise; poll until all 7 levels went out.
	for (let i = 0; i < 100 && posted < 7; i++) await new Promise((r) => setTimeout(r, 50));
	assert.equal(posted, 7, "a rejected parameter must trigger the probe");

	// Same ctx, an error that indicts nothing: the level is not in doubt.
	const notified = [];
	ctx.ui.setWidget = (id, text) => text && notified.push(text);
	handlers.get("message_end")(messageEnd(provider, "probe-me", "socket hang up"), ctx);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(posted, 7, "an error without a parameter hint must not probe");
	assert.deepEqual(notified, []);
});
