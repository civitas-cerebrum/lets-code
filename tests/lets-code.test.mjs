#!/usr/bin/env node
// Unit test for the index of the one pi extension lets-code writes
// (~/.pi/agent/extensions/lets-code/index.ts), which loads each feature
// module next to it. With fake modules in a scratch copy: each present
// module (<feature>.ts or <feature>/index.ts, sync or async) loads once, in
// order; one that throws on import or in setup is reported by name, with a
// UI and without, and the others still load; missing ones are skipped.
// Needs Node >= 22.6.
//
//   tests/lets-code.test.mjs [path/to/lets-code/index.ts]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/index.ts");
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

const work = mkdtempSync(join(tmpdir(), "lets-code-index-test-"));
let n = 0;
// a scratch extension dir: the index plus the given modules ({ path: source })
async function load(modules, ui) {
	const dir = join(work, `ext-${n++}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.ts"), src);
	for (const [p, body] of Object.entries(modules)) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		writeFileSync(join(dir, p), body);
	}
	globalThis.__loaded = [];
	const handlers = {};
	const pi = { on(ev, h) { (handlers[ev] ??= []).push(h); } };
	const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
	await mod.default(pi);
	const notes = [], errs = [];
	const origErr = console.error;
	console.error = (m) => errs.push(String(m));
	try {
		for (const h of handlers.session_start ?? []) await h({}, ui ? { hasUI: true, ui: { notify: (m, k) => notes.push([m, k]) } } : { hasUI: false });
	} finally { console.error = origErr; }
	return { mod, loaded: globalThis.__loaded, handlers, notes, errs };
}
const ok = (name) => `export default function (pi) { globalThis.__loaded.push(${JSON.stringify(name)}); pi.on("x-${name}", () => {}); }\n`;

{
	const r = await load({ "footer.ts": ok("footer"), "agent-guard.ts": ok("agent-guard"), "subagents.ts": ok("subagents"),
		"sandbox/index.ts": `export default async function (pi) { await new Promise((r) => setTimeout(r, 5)); globalThis.__loaded.push("sandbox"); }\n`,
		"grounding.ts": `export default function (pi) { globalThis.__loaded.push("grounding"); throw new Error("setup broke"); }\n`,
		"mandate.ts": `import "./no-such-module.ts";\nexport default function () { globalThis.__loaded.push("mandate"); }\n`,
		"unknown.ts": ok("unknown") }, true);
	t("present modules load once each, in order (async waited for)", r.loaded, ["agent-guard", "footer", "grounding", "sandbox", "subagents"]);
	t("each module got the real pi", Object.keys(r.handlers).filter((k) => k.startsWith("x-")).sort(), ["x-agent-guard", "x-footer", "x-subagents"]);
	t("one notification with a UI", r.notes.length, 1);
	t("  as an error", r.notes[0]?.[1], "error");
	t("  naming the setup that threw", /grounding \(setup broke\)/.test(r.notes[0]?.[0] ?? ""), true);
	t("  naming the module that failed to import", /mandate \(/.test(r.notes[0]?.[0] ?? ""), true);
	t("  and not the ones that loaded", /footer|sandbox|agent-guard/.test(r.notes[0]?.[0] ?? ""), false);
	t("nothing on stderr with a UI", r.errs, []);
	t("a file that is not a feature is not loaded", r.loaded.includes("unknown"), false);
	t("the feature list", r.mod.FEATURES, ["agent-guard", "backend", "claude", "claude-code", "core-memory", "footer", "git-guard", "grounding", "mandate", "memory-guard", "sandbox", "session-tag", "sessions", "experts", "factory", "subagents", "thinking"]);
}
{
	const r = await load({ "backend.ts": `export default function () { throw "plain"; }\n`, "session-tag.ts": ok("session-tag") }, false);
	t("without a UI: the failure goes to stderr", r.errs.length === 1 && /backend \(plain\)/.test(r.errs[0]), true);
	t("without a UI: the others still load", r.loaded, ["session-tag"]);
}
{
	const r = await load({ "git-guard.ts": `export const x = 1;\n`, "memory-guard.ts": ok("memory-guard") }, true);
	t("a module without a default function is reported", /git-guard \(no default export function\)/.test(r.notes[0]?.[0] ?? ""), true);
	t("  and the rest load", r.loaded, ["memory-guard"]);
}
{
	const r = await load({}, true);
	t("no modules: nothing loads, nothing reported", [r.loaded, r.notes, r.handlers.session_start], [[], [], undefined]);
}
{
	const r = await load({ "footer.ts": ok("footer"), "footer/index.ts": ok("footer-dir") }, true);
	t("<feature>.ts wins over <feature>/index.ts", r.loaded, ["footer"]);
}

// --- lineage: who an outside child is (a headless pi below another lets-code pi, not one of its subagents)
{
	const r = await load({});
	const { lineage } = r.mod ?? await import(pathToFileURL(join(work, `ext-${n - 1}`, "index.ts")).href);
	const up = () => true, down = () => false;
	t("lineage: a json pi under a live owner is its outside child, named by --name", lineage({ LETS_CODE_OWNER_PID: "100" }, ["node", "pi", "--mode", "json", "-p", "--name", "achilles-inspector"], 200, up), { outsideOf: 100, name: "achilles-inspector" });
	t("lineage: --name=x, and no name is pi", [lineage({ LETS_CODE_OWNER_PID: "100" }, ["pi", "-p", "--name=qa"], 200, up), lineage({ LETS_CODE_OWNER_PID: "100" }, ["pi", "--print"], 200, up)], [{ outsideOf: 100, name: "qa" }, { outsideOf: 100, name: "pi" }]);
	t("lineage: one of lets-code's own subagents is not", lineage({ LETS_CODE_OWNER_PID: "100", LETS_CODE_SUBAGENT_DEPTH: "1" }, ["pi", "--mode", "rpc"], 200, up), {});
	t("lineage: an interactive pi is not", lineage({ LETS_CODE_OWNER_PID: "100" }, ["pi"], 200, up), {});
	t("lineage: no owner, itself, or a dead one: not", [lineage({}, ["pi", "-p"], 200, up), lineage({ LETS_CODE_OWNER_PID: "200" }, ["pi", "-p"], 200, up), lineage({ LETS_CODE_OWNER_PID: "100" }, ["pi", "-p"], 200, down)], [{}, {}, {}]);
	t("lineage: a name is cleaned", lineage({ LETS_CODE_OWNER_PID: "100" }, ["pi", "-p", "--name", "a b;c\n"], 200, up).name, "a-b-c-");
	t("lineage: this process names itself the owner of what it starts", process.env.LETS_CODE_OWNER_PID, String(process.pid));
}

// --- /extensions: a menu of lets-code's optional extensions, toggled through the launcher
{
	const r = await load({});
	const m = r.mod;
	const fake = join(work, "fake-launcher"), calls = join(work, "launcher-calls"), state = join(work, "hook-on");
	writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${calls}\ncase "$2" in status) [ -e ${state} ] && { echo installed; exit 0; }; echo "not installed"; exit 3 ;; install) touch ${state}; echo "installed in settings"; exit 0 ;; uninstall) rm -f ${state}; echo "removed"; exit 0 ;; esac\n`, { mode: 0o755 });
	process.env.LETS_CODE_LAUNCHER = fake; process.env.LETS_CODE_SESSIONS_ON = "1";
	const commands = {};
	await m.default({ on() {}, registerCommand: (name, c) => { commands[name] = c; } });
	t("extensions: /extensions is registered", typeof commands.extensions?.handler, "function");
	t("extensions: claude-hook is one", m.EXTENSIONS.map((x) => x.id), ["claude-hook"]);
	const logs = []; const origLog = console.log; console.log = (x) => logs.push(String(x));
	await commands.extensions.handler("", { hasUI: false });
	console.log = origLog;
	t("extensions: without a UI, the list with its state", logs.at(-1), "○ Claude Code messages (claude-hook): off");
	const notes = [];
	const ui = (answers) => ({ hasUI: true, ui: { notify: (msg, ty) => notes.push([ty, msg]), select: async (_title, opts) => { const a = answers.shift(); return typeof a === "number" ? opts[a] : a; } } });
	await commands.extensions.handler("", ui([0, 0]));
	t("extensions: menu, pick, confirm: turned on through the launcher", [readFileSync(calls, "utf8").includes("claude-hook install"), notes.at(-1)], [true, ["info", "installed in settings"]]);
	await commands.extensions.handler("", ui([0, 1]));
	t("extensions: leave it: nothing changes", [readFileSync(calls, "utf8").includes("uninstall"), (await m.extensionState(m.EXTENSIONS[0]))], [false, "on"]);
	await commands.extensions.handler("claude-hook off", ui([]));
	t("extensions: /extensions claude-hook off", [readFileSync(calls, "utf8").includes("claude-hook uninstall"), await m.extensionState(m.EXTENSIONS[0])], [true, "off"]);
	await commands.extensions.handler("nope on", ui([]));
	t("extensions: an unknown name says so", notes.at(-1)[0], "warning");
	process.env.LETS_CODE_SESSIONS_ON = "";
	await commands.extensions.handler("claude-hook on", ui([]));
	t("extensions: claude-hook needs sessions on", [notes.at(-1)[1], await m.extensionState(m.EXTENSIONS[0])], ["Claude Code messages needs sessions (SESSIONS=true).", "off"]);
	process.env.LETS_CODE_LAUNCHER = join(work, "missing");
	t("extensions: no launcher: unknown, not a crash", await m.extensionState(m.EXTENSIONS[0]), "unknown");
	delete process.env.LETS_CODE_LAUNCHER; delete process.env.LETS_CODE_SESSIONS_ON;
	const subCommands = {};
	process.env.LETS_CODE_SUBAGENT_DEPTH = "1";
	await m.default({ on() {}, registerCommand: (name, c) => { subCommands[name] = c; } });
	t("extensions: not in a subagent", "extensions" in subCommands, false);
	delete process.env.LETS_CODE_SUBAGENT_DEPTH;
}

rmSync(work, { recursive: true, force: true });
process.exit(fail);
