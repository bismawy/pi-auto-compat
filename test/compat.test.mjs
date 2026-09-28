import test from "node:test";
import assert from "node:assert/strict";
import { suggestCompat, fixModelsConfig } from "../extensions/index.ts";

test("suggestCompat: Anthropic Opus 4.6 enables long cache retention & adaptive thinking", () => {
	const model = {
		id: "claude-3-opus-4.6",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
	};
	const compat = suggestCompat(model);
	assert.equal(compat.supportsLongCacheRetention, true);
	assert.equal(compat.forceAdaptiveThinking, true);
});

test("suggestCompat: Claude model on OpenAI-compatible proxy sets cacheControlFormat to anthropic", () => {
	const model = {
		id: "claude-3-7-sonnet",
		provider: "my-proxy",
		api: "openai-completions",
		baseUrl: "https://proxy.example.com/v1",
	};
	const compat = suggestCompat(model);
	assert.equal(compat.cacheControlFormat, "anthropic");
	assert.equal(compat.sendSessionAffinityHeaders, true);
	assert.equal(compat.supportsLongCacheRetention, false);
});

test("suggestCompat: DeepSeek on OpenAI completions sets deepseek thinking and reasoning format", () => {
	const model = {
		id: "deepseek-r1",
		provider: "openrouter",
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
	};
	const compat = suggestCompat(model);
	assert.equal(compat.requiresReasoningContentOnAssistantMessages, true);
	assert.equal(compat.thinkingFormat, "deepseek");
	assert.equal(compat.sendSessionAffinityHeaders, true);
	assert.equal(compat.supportsLongCacheRetention, false);
});

test("suggestCompat: Official OpenAI endpoint gets supportsLongCacheRetention true", () => {
	const model = {
		id: "gpt-4o",
		provider: "openai",
		api: "openai-completions",
		baseUrl: "https://api.openai.com/v1",
	};
	const compat = suggestCompat(model);
	assert.equal(compat.supportsLongCacheRetention, true);
});

test("suggestCompat: Built-in llama.cpp gets supportsLongCacheRetention false", () => {
	const model = {
		id: "qwen-2.5",
		provider: "llamacpp",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:8080/v1",
	};
	const compat = suggestCompat(model);
	assert.equal(compat.supportsLongCacheRetention, false);
});

test("suggestCompat: Kimi Coding on Anthropic-compatible API gets adaptive thinking & allowEmptySignature", () => {
	const model = {
		id: "kimi-k3-code",
		provider: "kimi-coding",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding/v1",
	};
	const compat = suggestCompat(model);
	assert.equal(compat.forceAdaptiveThinking, true);
	assert.equal(compat.allowEmptySignature, true);
});

test("suggestCompat: returns empty object if all flags are already explicitly defined", () => {
	const model = {
		id: "claude-sonnet-4.6",
		provider: "anthropic",
		api: "anthropic-messages",
		compat: {
			supportsLongCacheRetention: true,
			forceAdaptiveThinking: true,
		},
	};
	const compat = suggestCompat(model);
	assert.deepEqual(compat, {});
});
