import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// getAgentDir() is read when the module loads, so point it at a throwaway
// agent dir before the dynamic import below. Keeps the test off the real
// ~/.pi/agent/models.json.
const agentDir = mkdtempSync(join(tmpdir(), "auto-compat-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const fixture = {
	providers: {
		enclave: {
			baseUrl: "https://router.enclave.ai/v1",
			api: "openai-completions",
			apiKey: "test-key",
			models: [
				{ id: "cyberouter/glm-5.3", reasoning: true, thinkingLevelMap: { low: "low" } },
				{ id: "cyberouter/kimi-k3", reasoning: true, thinkingLevelMap: { low: "low" } },
			],
		},
	},
};
writeFileSync(join(agentDir, "models.json"), JSON.stringify(fixture, null, 2));

const { fixModelsConfig } = await import("../extensions/index.ts");

test("fixModelsConfig: developer-role opt-out is written provider-level", () => {
	const models = [
		{
			provider: "enclave",
			id: "cyberouter/glm-5.3",
			api: "openai-completions",
			baseUrl: "https://router.enclave.ai/v1",
			reasoning: true,
		},
		{
			provider: "enclave",
			id: "cyberouter/kimi-k3",
			api: "openai-completions",
			baseUrl: "https://router.enclave.ai/v1",
			reasoning: true,
		},
	];
	const { changed, detail } = fixModelsConfig(
		models,
		new Map([["enclave", models]]),
	);

	assert.equal(changed, true);
	assert.ok(detail.some((d) => d.includes("supportsDeveloperRole")));

	const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	assert.equal(cfg.providers.enclave.compat.supportsDeveloperRole, false);
	// channel capability → provider level, not per-model
	assert.equal(cfg.providers.enclave.models[0].compat, undefined);
	assert.equal(cfg.providers.enclave.models[1].compat, undefined);
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
