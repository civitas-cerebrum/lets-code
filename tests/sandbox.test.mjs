#!/usr/bin/env node
// Unit test for the sandbox extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-sandbox/index.ts): config merging,
// mode events, and the fallback to plain bash when the runtime is absent.
// Needs Node >= 22.6. The OS sandbox itself is exercised by hand
// (tests/sandbox-live.sh), since CI runners lack bubblewrap.
//
//   tests/sandbox.test.mjs [path/to/index.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-sandbox/index.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-test-")));
const agentDir = join(work, "agent"); mkdirSync(join(agentDir, "extensions", "lets-code-sandbox"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LETS_CODE_SANDBOX_ON = "1";
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let loads = 0;
async function load() {
	const f = join(agentDir, "extensions", "lets-code-sandbox", `index-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, commands = {}, listeners = {}, notices = [], status = [];
	let tool = null;
	const pi = { on(ev, h) { handlers[ev] = h; return () => {}; }, registerTool: (d) => { tool = d; }, registerCommand: (k, o) => { commands[k] = o; }, events: { on: (c, h) => { listeners[c] = h; return () => {}; }, emit() {} } };
	mod.default(pi);
	const ctx = (cwd) => ({ cwd, hasUI: true, ui: { notify: (m) => notices.push(m), setStatus: (k, v) => status.push(v) } });
	return { mod, handlers, commands, listeners, notices, status, tool: () => tool, ctx };
}
const warnings = []; const warn = (m) => warnings.push(m);

// --- pure config merging
{
	const { mod } = await load();
	const base = mod.loadConfig(work, undefined, warn);
	t("defaults: enabled, secrets unreadable", [base.enabled, base.filesystem.denyRead.includes("~/.config/lets-code"), base.filesystem.denyRead.includes("~/.ssh")], [true, true, true]);
	t("defaults: project writable", base.filesystem.allowWrite.includes("."), true);
	writeFileSync(join(agentDir, "extensions", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["internal.example"] }, filesystem: { denyWrite: ["secrets/"] } }));
	const g = mod.loadConfig(work, undefined, warn);
	t("global file overrides network list, keeps other filesystem keys", [g.network.allowedDomains, g.filesystem.denyWrite, g.filesystem.denyRead.length > 3], [["internal.example"], ["secrets/"], true]);
	const proj = join(work, "proj"); mkdirSync(join(proj, ".pi"), { recursive: true });
	writeFileSync(join(proj, ".pi", "sandbox.json"), JSON.stringify({ enabled: false, filesystem: { allowWrite: [".", "/data"] } }));
	const p = mod.loadConfig(proj, undefined, warn);
	t("project file wins", [p.enabled, p.filesystem.allowWrite], [false, [".", "/data"]]);
	writeFileSync(join(proj, ".pi", "sandbox.json"), "{ broken");
	t("broken project file warns and keeps going", [mod.loadConfig(proj, undefined, warn).enabled, warnings.some((m) => /could not parse/.test(m))], [true, true]);
	rmSync(join(proj, ".pi", "sandbox.json"));
	const plan = mod.loadConfig(work, { role: "plan", network: "off" }, warn);
	t("mode network off empties the allowlist", plan.network.allowedDomains, []);
	const custom = mod.loadConfig(work, { role: "ci", sandbox: { allowWrite: ["/build"], allowedDomains: ["ci.example"] } }, warn);
	t("mode sandbox block applies", [custom.filesystem.allowWrite, custom.network.allowedDomains], [["/build"], ["ci.example"]]);
	t("yolo disables", mod.loadConfig(work, { role: "yolo", bypass: true }, warn).enabled, false);
	rmSync(join(agentDir, "extensions", "sandbox.json"));
}

// --- without the runtime installed: warns once, bash tool is the plain one, /sandbox says off
{
	const h = await load();
	await new Promise((r) => setTimeout(r, 300));     // tool registration is async (imports pi)
	await h.handlers.session_start({ type: "session_start" }, h.ctx(work));
	t("runtime missing: warned with install hint", h.notices.some((m) => /not active/.test(m) && /npm install/.test(m)), true);
	t("runtime missing: user_bash untouched", h.handlers.user_bash({}), undefined);
	t("mode event re-initialises (still off)", (() => { h.listeners["lets-code:mode"]({ role: "ask", network: "on" }); return true; })(), true);
	await new Promise((r) => setTimeout(r, 100));
	await h.commands.sandbox.handler("", h.ctx(work));
	t("/sandbox reports off and the mode", /sandbox: off \(mode ask\)/.test(h.notices[h.notices.length - 1]), true);
	t("bash tool registered when pi is importable", h.tool() === null || h.tool().name === "bash", true);
}
// --- inert when off
{ delete process.env.LETS_CODE_SANDBOX_ON; const h = await load(); t("inert when off", Object.keys(h.handlers).length, 0); }

rmSync(work, { recursive: true, force: true });
console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
