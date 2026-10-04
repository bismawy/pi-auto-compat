import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT_DIR = join(HERE, "__fake-agent");
const RUN_DIR = join(HERE, "__patch-run");

const SHIPPED_IMPORT = `import { lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";`;

// Minimal stand-in for the real module. The patcher replaces the writer
// wholesale and rewrites the import line, so both must match the shipped file.
const SHIPPED_WRITER = `${SHIPPED_IMPORT}

export async function writeStatsShardV7(path: string, shard: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, JSON.stringify(shard, null, 2) + "\\n", "utf8");
  await rename(tempPath, path);
}`;

const PATCHER_HREF = pathToFileURL(join(HERE, "..", "extensions", "index.ts")).href;
const FIXTURE = "npm/node_modules/pi-cache-optimizer/src/stats-store.ts";

after(() => {
	for (const dir of [FAKE_AGENT_DIR, RUN_DIR]) rmSync(dir, { recursive: true, force: true });
});

function seedShippedModule() {
	execFileSync(process.execPath, ["--input-type=module", "-e", `
		const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
		const file = join(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(FIXTURE)});
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, ${JSON.stringify(SHIPPED_WRITER)});
	`], { env: { ...process.env, PI_CODING_AGENT_DIR: FAKE_AGENT_DIR } });
}

function applyPatch() {
	const out = execFileSync(
		process.execPath,
		["--experimental-transform-types", "--input-type=module", "-e", `
			import { readFileSync } from "node:fs";
			import { join } from "node:path";
			const { patchCacheOptimizerWindows } = await import(${JSON.stringify(PATCHER_HREF)});
			const file = join(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(FIXTURE)});
			const first = patchCacheOptimizerWindows();
			const second = patchCacheOptimizerWindows();
			console.log(JSON.stringify({ first, second, text: readFileSync(file, "utf8") }));
		`],
		{ env: { ...process.env, PI_CODING_AGENT_DIR: FAKE_AGENT_DIR }, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
	);
	return JSON.parse(out.trim().split("\n").pop());
}

test("patchCacheOptimizerWindows patches the module that owns writeStatsShardV7", { skip: process.platform !== "win32" }, () => {
	seedShippedModule();
	const { first, second, text } = applyPatch();
	assert.equal(first, true);
	assert.equal(second, false, "second pass must be a no-op");
	assert.match(text, /export async function safeAtomicRename/, "helper must be exported");
	assert.match(text, /export async function writeStatsShardV7/, "writeStatsShardV7 must stay exported for index.ts");
	assert.match(text, /await safeAtomicRename\(tempPath, path\)/, "writer must delegate to the retrying rename");
	const imported = /import \{([^}]*)\} from "node:fs\/promises"/.exec(text)?.[1].split(",").map((n) => n.trim()) ?? [];
	assert.ok(imported.includes("copyFile"), "copyFile must be imported for the fallback path");
	assert.ok(imported.includes("rename"), "the original imports must survive");
});

test("injected writer persists every shard despite a concurrent reader", { skip: process.platform !== "win32" }, async () => {
	seedShippedModule();
	const { text } = applyPatch();
	const runModule = join(RUN_DIR, "injected-writer.ts");
	// The patched import line is replaced by the runner's own, so only the
	// function bodies are injected here and the real fs primitives are used.
	const body = text.slice(text.indexOf("export async function safeAtomicRename"));
	execFileSync(process.execPath, ["--input-type=module", "-e", `
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(${JSON.stringify(RUN_DIR)}, { recursive: true });
		writeFileSync(${JSON.stringify(runModule)},
			'import { rename, copyFile, unlink, mkdir, writeFile } from "node:fs/promises";\\n' +
			'import { dirname } from "node:path";\\n' +
			'import { randomUUID } from "node:crypto";\\n' +
			'type PersistedStatsShardV7 = unknown;\\n\\n' +
			${JSON.stringify(body)});
	`]);
	const { writeStatsShardV7 } = await import(pathToFileURL(runModule).href);

	const dest = join(RUN_DIR, "shard.json");
	writeFileSync(dest, "{}");
	let failures = 0;
	let stale = 0;
	for (let i = 0; i < 100; i++) {
		let stop = false;
		const reader = (async () => {
			const { readFile } = await import("node:fs/promises");
			while (!stop) await readFile(dest).catch(() => {});
		})();
		try {
			await writeStatsShardV7(dest, { i });
		} catch {
			failures++;
		}
		stop = true;
		await reader;
		const { readFile } = await import("node:fs/promises");
		try {
			if (JSON.parse(await readFile(dest, "utf8")).i !== i) stale++;
		} catch {
			stale++;
		}
	}
	const { readdir } = await import("node:fs/promises");
	const leftovers = (await readdir(RUN_DIR)).filter((f) => f.endsWith(".tmp")).length;

	assert.equal(failures, 0, "every write must persist despite the reader");
	assert.equal(stale, 0, "destination must always hold the latest shard");
	assert.equal(leftovers, 0, "no temporary file may be left behind");
});