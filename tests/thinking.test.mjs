#!/usr/bin/env node
// Unit test for the thinking memory extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/thinking.ts). Loads it with a fake pi
// and drives thinking_level_select. Needs Node >= 22.6.
//
//   tests/thinking.test.mjs [path/to/lets-code/thinking.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/thinking.ts");
const work = mkdtempSync(join(tmpdir(), "thinking-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
const state = join(work, "lets-code-state.json");
const KEY = "lets-code/qwen";

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const saved = () => existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;

let loads = 0;
async function load(env) {
	for (const k of ["LETS_CODE_THINKING_SAVE", "LETS_CODE_STATE_FILE", "LETS_CODE_SUBAGENT_DEPTH"]) delete process.env[k];
	Object.assign(process.env, env);
	const f = join(work, `thinking-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {};
	mod.default({ on(ev, h) { handlers[ev] = h; } });
	const pick = (level, model = { provider: "lets-code", id: "qwen" }) => handlers.thinking_level_select?.({ type: "thinking_level_select", level, previousLevel: "medium" }, { model });
	return { handlers, pick };
}

try {
	let x = await load({ LETS_CODE_STATE_FILE: state });
	t("no key (auto/adaptive): no handler", Object.keys(x.handlers), []);
	x = await load({ LETS_CODE_THINKING_SAVE: KEY, LETS_CODE_STATE_FILE: state, LETS_CODE_SUBAGENT_DEPTH: "1" });
	t("subagent: no handler", Object.keys(x.handlers), []);

	x = await load({ LETS_CODE_THINKING_SAVE: KEY, LETS_CODE_STATE_FILE: state });
	x.pick("xhigh");
	t("pick saved", saved(), { thinkingLevels: { [KEY]: "xhigh" } });
	x.pick("low");
	t("later pick replaces it", saved().thinkingLevels[KEY], "low");
	x.pick("high", { provider: "lets-code-openrouter", id: "qwen/qwen3.8-27b" });
	t("other model: not saved", saved(), { thinkingLevels: { [KEY]: "low" } });
	x.pick("high", null);
	t("no model: not saved", saved().thinkingLevels[KEY], "low");

	writeFileSync(state, JSON.stringify({ other: 1, thinkingLevels: { "lets-code-x/m": "off" } }));
	x.pick("medium");
	t("other keys kept", saved(), { other: 1, thinkingLevels: { "lets-code-x/m": "off", [KEY]: "medium" } });
	writeFileSync(state, "not json");
	x.pick("high");
	t("unreadable file: started over", saved(), { thinkingLevels: { [KEY]: "high" } });
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
