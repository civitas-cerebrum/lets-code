#!/usr/bin/env node
// Unit test for the grounding guard extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/grounding.ts). Loads it with a fake pi in
// a scratch project and drives before_agent_start and tool_call.
// Needs Node >= 22.6.
//
//   tests/grounding.test.mjs [path/to/lets-code/grounding.ts]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/grounding.ts");
const work = mkdtempSync(join(tmpdir(), "grounding-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

const proj = join(work, "proj");
mkdirSync(join(proj, "src"), { recursive: true });
for (const f of ["a.txt", "b.txt", "c.txt", "src/d.py", "e.txt"]) writeFileSync(join(proj, f), "x\n");

let loads = 0;
async function load(env) {
	delete process.env.LETS_CODE_GROUNDING_ON;
	Object.assign(process.env, env);
	const f = join(work, `grounding-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {};
	mod.default({ on(ev, h) { handlers[ev] = h; } });
	const ctx = { cwd: proj };
	const call = async (toolName, input) => (await handlers.tool_call?.({ toolName, input }, ctx)) ?? "allowed";
	return { mod, handlers, call };
}
const blocked = (r) => (r && r.block ? "blocked" : r);

try {
	let x = await load({});
	t("off: nothing registered", Object.keys(x.handlers), []);

	x = await load({ LETS_CODE_GROUNDING_ON: "1" });
	const ev = { systemPromptOptions: { sections: { other: "kept" } } };
	await x.handlers.before_agent_start(ev);
	t("prompt section added", Object.keys(ev.systemPromptOptions.sections), ["other", "lets_code_grounding"]);
	t("prompt section text", ev.systemPromptOptions.sections.lets_code_grounding, `${x.mod.SECTION}\n${x.mod.dateLine()}`);
	t("prompt: today's local date", ev.systemPromptOptions.sections.lets_code_grounding.includes(`Today is ${new Date().toLocaleDateString("sv-SE")} (local time, ${Intl.DateTimeFormat().resolvedOptions().timeZone})`), true);
	t("date line: given date, YYYY-MM-DD", /^- Today is 2026-03-04 \(local time, [^)]+\)\./.test(x.mod.dateLine(new Date(2026, 2, 4, 23, 59))), true);
	t("prompt: look, don't guess", x.mod.SECTION.includes("Look, don't guess."), true);
	t("prompt: an empty grep is not absence", /An empty grep is not absence.*com\.google\.android\.gm.*who handles the role/.test(x.mod.SECTION), true);
	t("prompt: accepted needs a control that must fail", /rc=0 is not success.*control that must fail/.test(x.mod.SECTION), true);
	t("prompt: one line per rule", ev.systemPromptOptions.sections.lets_code_grounding.split("\n").every((l, i) => i === 0 || l.startsWith("- ")), true);
	t("no sections: no crash", await x.handlers.before_agent_start({}), undefined);

	// overwrite of an unread existing file: blocked once, then allowed
	const r1 = await x.call("write", { path: "a.txt", content: "y" });
	t("unread existing file: blocked", blocked(r1), "blocked");
	t("block says read first", r1.reason, x.mod.blockText("a.txt"));
	t("written again: allowed", await x.call("write", { path: "a.txt", content: "y" }), "allowed");
	t("and stays allowed", await x.call("write", { path: "a.txt", content: "z" }), "allowed");

	// read first: allowed; relative and absolute paths are the same file
	await x.call("read", { path: "b.txt" });
	t("read first: allowed", await x.call("write", { path: join(proj, "b.txt"), content: "y" }), "allowed");

	// edited before: allowed
	await x.call("edit", { path: join(proj, "src/d.py"), oldText: "x", newText: "y" });
	t("edited first: allowed", await x.call("write", { path: "src/d.py", content: "y" }), "allowed");

	// looked at through bash
	await x.call("bash", { command: "sed -n '1,20p' c.txt | head" });
	t("bash read first: allowed", await x.call("write", { path: "c.txt", content: "y" }), "allowed");

	// new files are never blocked
	t("new file: allowed", await x.call("write", { path: "src/new.py", content: "y" }), "allowed");
	t("then overwriting it: allowed", await x.call("write", { path: "src/new.py", content: "z" }), "allowed");

	// a directory path is not a file to protect
	t("directory: not blocked", await x.call("write", { path: "src", content: "y" }), "allowed");

	// other tools pass untouched
	t("ls passes", await x.call("ls", { path: "." }), "allowed");

	// namedFiles: flags, variables and globs are skipped
	t("namedFiles", x.mod.namedFiles(`cat -n e.txt "src/d.py" $HOME/x *.txt nope.txt`, proj).map((p) => p.slice(proj.length + 1)), ["e.txt", "src/d.py"]);
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
