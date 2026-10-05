import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// getAgentDir() is read when the module loads, so point it at a throwaway
// agent dir before the dynamic import below.
const agentDir = mkdtempSync(join(tmpdir(), "auto-compat-ctx-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { parseContextFields, runContextSync } = await import("../extensions/index.ts");

test("parseContextFields: OpenRouter-style context_length", () => {
	assert.deepEqual(parseContextFields({ id: "x", context_length: 1048576 }), {
		contextWindow: 1048576,
	});
});

test("parseContextFields: max_model_len / max_input_tokens / max_output_tokens", () => {
	assert.deepEqual(
		parseContextFields({
			id: "x",
			max_model_len: 262144,
			max_tokens: 262144,
			max_input_tokens: 1048569,
			max_output_tokens: 131072,
		}),
		{ contextWindow: 262144, maxTokens: 131072 },
	);
});

test("parseContextFields: generic max_tokens equal to the window is not an output cap", () => {
	assert.deepEqual(parseContextFields({ context_length: 1000000, max_tokens: 1000000 }), {
		contextWindow: 1000000,
	});
});

test("parseContextFields: numeric strings and negatives are handled", () => {
	assert.deepEqual(parseContextFields({ context_length: "128000" }), { contextWindow: 128000 });
	assert.deepEqual(parseContextFields({ context_length: -1, max_output_tokens: 0 }), {});
});

test("parseContextFields: missing metadata yields nothing", () => {
	assert.deepEqual(parseContextFields({ id: "x", object: "model" }), {});
});

// sync behavior: a channel declares 1M, config starts at Pi's 128k default.
const provider = "ctxsync";
const baseUrl = "http://127.0.0.1:";
let server;
let requests = 0;

function writeConfig() {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[provider]: {
						baseUrl,
						api: "openai-completions",
						apiKey: "dummy",
						models: [
							{ id: "deepseek-v4.1-flash", reasoning: true },
							{ id: "manual-window", reasoning: true, contextWindow: 500000 },
						],
					},
				},
			},
			null,
			2,
		),
	);
}

function registry() {
	const mk = (id) => ({
		provider,
		id,
		api: "openai-completions",
		baseUrl,
		reasoning: true,
	});
	const all = [mk("deepseek-v4.1-flash"), mk("manual-window")];
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
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				data: [
					{ id: "deepseek-v4.1-flash", context_length: 1048576, max_output_tokens: 131072 },
					// small anomaly vs the manual 500000 must be rejected.
					{ id: "manual-window", context_length: 8192 },
				],
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	writeConfig();
});

test("runContextSync: writes network windows and repairs the 128k default", async () => {
	server;
	const target = server.address();
	// rewrite config with the live port
	const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	cfg.providers[provider].baseUrl = `${baseUrl}${target.port}`;
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(cfg, null, 2));

	const result = await runContextSync(registry(), true);
	assert.equal(result.changed, true);
	assert.equal(result.errors.length, 0);
	assert.ok(result.detail.some((d) => d.includes("deepseek-v4.1-flash") && d.includes("contextWindow")));

	const out = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	const models = out.providers[provider].models;
	assert.equal(models.find((m) => m.id === "deepseek-v4.1-flash").contextWindow, 1048576);
	assert.equal(models.find((m) => m.id === "deepseek-v4.1-flash").maxTokens, 131072);
	// unit anomaly rejected: manual window kept.
	assert.equal(models.find((m) => m.id === "manual-window").contextWindow, 500000);
});

test("runContextSync: a hand-edited value is never overwritten twice", async () => {
	const out = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	out.providers[provider].models.find((m) => m.id === "deepseek-v4.1-flash").contextWindow = 200000;
	out.providers[provider].models.find((m) => m.id === "deepseek-v4.1-flash").maxTokens = 32000;
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(out, null, 2));

	const result = await runContextSync(registry(), true);
	const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	assert.equal(after.providers[provider].models.find((m) => m.id === "deepseek-v4.1-flash").contextWindow, 200000);
	assert.equal(after.providers[provider].models.find((m) => m.id === "deepseek-v4.1-flash").maxTokens, 32000);
	assert.equal(result.changed, false);
});

test("runContextSync: non-forced second call honors the TTL (no network)", async () => {
	const before = requests;
	await runContextSync(registry(), false);
	assert.equal(requests, before);
});

test.after(() => {
	server?.close();
	rmSync(agentDir, { recursive: true, force: true });
});
