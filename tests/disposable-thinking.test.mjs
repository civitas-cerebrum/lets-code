#!/usr/bin/env node
// Unit test for the disposable thinking extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/disposable-thinking.ts). Loads it with a
// fake pi and drives the context event and the command. Needs Node >= 22.6.
//
//   tests/disposable-thinking.test.mjs [path/to/lets-code/disposable-thinking.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/disposable-thinking.ts");
const work = mkdtempSync(join(tmpdir(), "disposable-thinking-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
const state = join(work, "lets-code-state.json");

let fail = 0, n = 0;
function check(name, got, want) {
	n++;
	if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// Each load gets its own copy so the module reads that load's environment.
let loads = 0;
async function load(env) {
	for (const k of ["LETS_CODE_DISPOSABLE_THINKING_ON", "LETS_CODE_DISPOSABLE_THINKING_PIN", "LETS_CODE_THINKING_REPLAY", "LETS_CODE_SUBAGENT_DEPTH"]) delete process.env[k];
	Object.assign(process.env, { LETS_CODE_METRICS_SAVE: state }, env);
	const f = join(work, `disposable-${loads++}.ts`);
	writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, commands = {}, said = [];
	mod.default({ on(ev, h) { handlers[ev] = h; }, registerCommand(name, c) { commands[name] = c; } });
	const ctx = { hasUI: true, ui: { notify: (m) => said.push(m) } };
	return { mod, said, context: (messages) => handlers.context({ type: "context", messages }, {}), run: (args) => commands["disposable-thinking"].handler(args, ctx) };
}
const a = (i) => ({ role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(4000 * i) }, { type: "text", text: "a" + i }] });
const msgs = [{ role: "user", content: "q" }, a(1), { role: "toolResult", content: [] }, a(2), a(3)];
const thinking = (r) => (r?.messages ?? msgs).map((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "thinking").length : "-")).join("");
const remembered = () => { try { return JSON.parse(readFileSync(state, "utf8")).disposableThinking; } catch { return undefined; } };

try {
	// --- the window
	const { mod } = await load({});
	check("keep 1: older thinking dropped", thinking(mod.stripOldThinking(msgs, 1)), "-0-01");
	check("keep 1: characters left out", mod.stripOldThinking(msgs, 1).chars, 12000);
	check("keep 1: other messages are the same objects", [0, 2, 4].every((i) => mod.stripOldThinking(msgs, 1).messages[i] === msgs[i]), true);
	check("keep 2", thinking(mod.stripOldThinking(msgs, 2)), "-0-11");
	check("keep 0: all thinking dropped", thinking(mod.stripOldThinking(msgs, 0)), "-0-00");
	check("keep more than there are: null", mod.stripOldThinking(msgs, 5), null);
	check("nothing to drop: null", mod.stripOldThinking([{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a" }] }], 1), null);
	check("the input is not changed", thinking(), "-1-11");
	check("turns kept: default", mod.keepTurns(undefined), 1);
	check("turns kept: a number", [mod.keepTurns("3"), mod.keepTurns("0"), mod.keepTurns(" 2 ")], [3, 0, 2]);
	check("turns kept: not a number", [mod.keepTurns("all"), mod.keepTurns("-1"), mod.keepTurns("x")], [1, 1, 1]);

	// --- off unless switched on
	let h = await load({});
	check("off: context untouched", await h.context(msgs), undefined);
	await h.run("status");
	check("off: status says so", /^disposable thinking: off/.test(h.said.at(-1)), true);

	// --- on at launch
	h = await load({ LETS_CODE_DISPOSABLE_THINKING_ON: "1" });
	check("on: the latest turn keeps its thinking", thinking(await h.context(msgs)), "-0-01");
	await h.run("");
	check("on: status names the window and what was left out", h.said.at(-1), "disposable thinking: on, the latest turn keeps its thinking; about 3k tokens of old thinking left out of the last request");
	h = await load({ LETS_CODE_DISPOSABLE_THINKING_ON: "1", LETS_CODE_THINKING_REPLAY: "2" });
	check("on, window 2", thinking(await h.context(msgs)), "-0-11");

	// --- the command
	h = await load({});
	await h.run("on");
	check("/disposable-thinking on: applies to the next request", thinking(await h.context(msgs)), "-0-01");
	check("on: a pi started from here follows", process.env.LETS_CODE_DISPOSABLE_THINKING_ON, "1");
	check("on: remembered", remembered(), true);
	check("on: said", h.said.at(-1), "disposable thinking: on, the latest turn keeps its thinking, for this session, and for later launches");
	await h.run("off");
	check("/disposable-thinking off: context untouched again", await h.context(msgs), undefined);
	check("off: a pi started from here follows", process.env.LETS_CODE_DISPOSABLE_THINKING_ON, undefined);
	check("off: remembered", remembered(), false);
	await h.run("sometimes");
	check("unknown argument: usage", h.said.at(-1), "usage: /disposable-thinking [on|off|status]");
	check("unknown argument: nothing changed", remembered(), false);

	// --- a setting that decides at launch is named
	h = await load({ LETS_CODE_DISPOSABLE_THINKING_ON: "1", LETS_CODE_DISPOSABLE_THINKING_PIN: "true" });
	await h.run("off");
	check("pinned: the choice is taken and the pin named", /^disposable thinking: off for this session, and for later launches \(DISPOSABLE_THINKING=true is set/.test(h.said.at(-1)), true);

	// --- a subagent's choice is its own
	rmSync(state, { force: true });
	h = await load({ LETS_CODE_SUBAGENT_DEPTH: "1" });
	await h.run("on");
	check("subagent: on for its session", thinking(await h.context(msgs)), "-0-01");
	check("subagent: not remembered", remembered(), undefined);
} finally {
	rmSync(work, { recursive: true, force: true });
}
console.log(`${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
