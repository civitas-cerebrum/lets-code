#!/usr/bin/env node
// Unit test for outside runs in the subagent extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/subagents.ts): a pi another extension
// started inside the main session (an outside child; the sessions module
// registers it with its session file) joins the run list: found in the
// registry under this pid (and under an outside run of its own, nested), its
// events read from its session file as it grows (user, assistant, tool call
// and result, the name from session_info, usage), ended when its process is
// gone (done, or failed on an error), stopped with SIGTERM; subagent status
// shows it with its pid; and opening it never switches the TUI to, or writes
// next to, that file (it is the other tool's). With a fake pi, in a scratch
// agent dir. Needs Node >= 22.6.
//
//   tests/subagent-outside.test.mjs [path/to/lets-code/subagents.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, readdirSync, existsSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/subagents.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "subagent-outside-test-")));
const kids = [];
process.on("exit", () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } } rmSync(work, { recursive: true, force: true }); });
const agentDir = join(work, "agent"); mkdirSync(join(agentDir, "extensions"), { recursive: true }); mkdirSync(join(agentDir, "agents"));
const sdir = join(agentDir, "lets-code-sessions"); mkdirSync(sdir, { recursive: true, mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LETS_CODE_SUBAGENTS_ON = "1";
process.env.LETS_CODE_SESSIONS_ON = "1";
process.env.LETS_CODE_OUTSIDE_POLL_MS = "50";
delete process.env.LETS_CODE_SESSIONS_DIR; delete process.env.LETS_CODE_OUTSIDE_OF; delete process.env.LETS_CODE_SUBAGENT_DEPTH;
{
	let piRoot = "";
	try { piRoot = join(execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "@earendil-works", "pi-coding-agent"); } catch { /* no npm */ }
	const tb = piRoot ? [join(piRoot, "node_modules", "typebox"), join(piRoot, "..", "..", "typebox")].find((p) => existsSync(p)) : undefined;
	const nm = join(agentDir, "extensions", "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	if (tb) { rmSync(nm, { recursive: true }); symlinkSync(tb, nm); }
	else {
		writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
		writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Number: (o) => ({ type: 'number', ...o }), Boolean: (o) => ({ type: 'boolean', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }), Union: (a) => ({ anyOf: a }), Literal: (v) => ({ const: v }) };\n");
	}
}
const src = readFileSync(extPath, "utf8");
const view = join(extPath, "..", "subagent-view.ts");
if (existsSync(view)) writeFileSync(join(agentDir, "extensions", "subagent-view.ts"), readFileSync(view, "utf8"));

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const has = (name, text, part) => t(name, String(text).includes(part) ? part : String(text).slice(0, 300), part);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(20); } return false; };
const livePid = () => { const k = spawn("sleep", ["60"], { stdio: "ignore" }); kids.push(k); return k; };
const deadPid = () => spawnSync("true").pid;
const line = (o) => JSON.stringify(o) + "\n";
const entry = (pid, parentPid, file, agent, startedAt = Date.now()) =>
	writeFileSync(join(sdir, `${pid}.json`), JSON.stringify({ pid, piSessionId: "", tag: "", name: "", cwd: work, repoRoot: "", repoKey: "", mode: "", depth: 0, parentPid, agent, startedAt, busy: true, sessionFile: file, outside: true }));

const f = join(agentDir, "extensions", "subagents-0.ts"); writeFileSync(f, src);
const mod = await import(pathToFileURL(f).href);
const handlers = {}, commands = {}, notices = [];
let switched = 0;
const piApi = { registerTool() {}, on(ev, h) { handlers[ev] = h; return () => {}; }, registerCommand: (name, d) => { commands[name] = d; }, registerShortcut() {},
	sentLog: [], sendMessage(m) { piApi.sentLog.push(["message", m]); }, sendUserMessage(m) { piApi.sentLog.push(["user", m]); }, registerMessageRenderer() {}, getSettings: () => ({}), getThinkingLevel: () => "medium", setThinkingLevel() {} };
mod.default(piApi);
const reg = () => mod.registry();

// --- the registry: under this pid, nested under an outside run, not another session's
const orch = livePid(), expert = livePid(), stranger = livePid();
const fo = join(work, ".achilles", "runs", "qa-1", "sessions", "orch.jsonl"), fe = join(work, ".achilles", "runs", "qa-1", "sessions", "expert.jsonl"), fs3 = join(work, "other.jsonl");
mkdirSync(join(work, ".achilles", "runs", "qa-1", "sessions"), { recursive: true });
writeFileSync(fo, line({ type: "session", id: "o", timestamp: "2026-11-05T10:00:00.000Z" }) + line({ type: "session_info", name: "achilles-orchestrator" }));
writeFileSync(fe, ""); writeFileSync(fs3, "");
entry(orch.pid, process.pid, fo, "achilles-orchestrator");
entry(expert.pid, orch.pid, fe, "achilles-inspector");
entry(stranger.pid, 999999, fs3, "someone-else");
entry(deadPid(), process.pid, fs3, "gone");
t("entries: this session's, and the one nested under it", mod.outsideEntries(process.pid, sdir).map((e) => e.agent), ["achilles-orchestrator", "achilles-inspector"]);

const runOf = (pid) => reg().runs.find((r) => r.outside?.pid === pid);
t("watch: both become runs", await until(() => runOf(orch.pid) && runOf(expert.pid)), true);
t("watch: the stranger and the dead one do not", [!!runOf(stranger.pid), reg().runs.some((r) => r.agent === "gone")], [false, false]);
{
	const r = runOf(orch.pid);
	t("run: running, its name from session_info, nothing persisted", [r.status, r.agent, r.kind, r.sessionFile, existsSync(join(agentDir, "lets-code-runs"))], ["running", "achilles-orchestrator", "subagent", undefined, false]);
}

// --- its session file, read as it grows
appendFileSync(fo, line({ type: "message", timestamp: "2026-11-05T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Re-verify the five J15 bugs" }] } }));
appendFileSync(fo, line({ type: "message", timestamp: "2026-11-05T10:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Dispatching the inspector" }, { type: "toolCall", id: "c1", name: "Agent", arguments: { subagent_type: "achilles-inspector" } }], usage: { input: 1200, output: 80 }, stopReason: "toolUse" } }));
appendFileSync(fo, '{"type":"message","message":{"role":"toolRes');   // a line still being written
await until(() => runOf(orch.pid).events.length >= 3);
{
	const r = runOf(orch.pid);
	t("read: the task", r.task, "Re-verify the five J15 bugs");
	t("read: user, assistant, the tool call pending", r.events.map((e) => `${e.t}${e.t === "tool" ? `:${e.name}:${e.done}` : ""}`), ["user", "assistant", "tool:Agent:false"]);
	t("read: blocks", r.events[1].blocks.map((b) => b.type), ["thinking", "text", "toolCall"]);
	t("read: turns and tokens", [r.turns, r.input, r.output], [1, 1200, 80]);
	has("status: the run with its pid", mod.statusText(reg().runs), `achilles-orchestrator (run ${r.id}, pid ${orch.pid})`);
	has("status: what it last said", mod.statusText(reg().runs), "last said: Dispatching the inspector");
}
appendFileSync(fo, 'ult","toolCallId":"c1","toolName":"Agent","content":[{"type":"text","text":"DONE: 2 still reproduce"}],"isError":false}}\n');
appendFileSync(fo, line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "DONE_WITH_CONCERNS" }], usage: { input: 10, output: 5 }, stopReason: "stop" } }));
await until(() => runOf(orch.pid).events.some((e) => e.t === "tool" && e.done));
{
	const r = runOf(orch.pid), tool = r.events.find((e) => e.t === "tool");
	t("read: the result completes the call (a line split across reads)", [tool.done, tool.output, tool.isError], [true, "DONE: 2 still reproduce", false]);
	t("read: the final answer", r.final, "DONE_WITH_CONCERNS");
}

// --- opening it: shown in place only; never a switch to, or a file next to, its tool's file
{
	const r = runOf(orch.pid);
	const before = readdirSync(join(work, ".achilles", "runs", "qa-1", "sessions")).sort();
	const ctx = { hasUI: true, mode: "tui", cwd: work, ui: { notify: (m) => notices.push(m), setWidget() {}, setStatus() {}, theme: { fg: (_c, s) => s } },
		sessionManager: { getSessionFile: () => join(work, "main.jsonl"), getSessionId: () => "main" }, isIdle: () => true, switchSession: async () => { switched++; return {}; } };
	await commands.subagents.handler(`id:${r.id}`, ctx);
	t("open: no switchSession", switched, 0);
	t("open: nothing written next to its file", readdirSync(join(work, ".achilles", "runs", "qa-1", "sessions")).sort(), before);
	t("open: its file untouched", readFileSync(fo, "utf8").split("\n").filter(Boolean).length, 6);
	has("open: without pi's layout, says so", notices.at(-1), "only in place");
	await commands.subagents.handler("achilles-orchestrator", ctx);
	t("open by name: no switchSession either", switched, 0);
}

// --- in place, with pi's layout: its transcript where the chat was; read-only; back puts pi's chat back
{
	const r = runOf(orch.pid);
	const notes = []; let termHandler, editor = "";
	const ui = { setStatus() {}, notify: (m) => notes.push(m), theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s, italic: (s) => s }, setWidget() {}, getEditorText: () => editor, setEditorText: (x) => { editor = x; },
		getToolsExpanded: () => false, onTerminalInput: (fn) => { termHandler = fn; return () => {}; } };
	const home = join(work, "home.jsonl"); writeFileSync(home, "{}\n");
	await handlers.session_start({ reason: "startup" }, { hasUI: true, ui, sessionManager: { getSessionFile: () => home, getSessionId: () => "main", getEntries: () => [] } });
	const part = (name) => ({ name, render: () => [name], invalidate() {} });
	const chat = part("main chat"), pending = part("main pending"), statusC = part("main status");
	const doc = { children: [part("header"), part("resources"), chat] };
	const ed = { getText: () => editor, onSubmit: () => {}, historyIndex: -1, isShowingAutocomplete: () => false, isEditorEmpty: () => !editor, isOnLastVisualLine: () => true };
	reg().tui = { children: [doc, pending, statusC, part("above"), part("editor"), part("below"), part("footer")], focusedComponent: ed, requestRender() {}, handleTerminalInput() {} };
	const ctx = { hasUI: true, mode: "tui", ui, isIdle: () => true, hasPendingMessages: () => false, switchSession: async () => { switched++; return {}; } };
	await commands.subagents.handler(`id:${r.id}`, ctx);
	t("in place: shown, even with the main session idle, no switch", [reg().view.inplace?.run, doc.children[2] !== chat, switched], [r.id, true, 0]);
	const shown = doc.children[2].render(80).join("\n");
	t("in place: its transcript", [/Re-verify the five J15 bugs/.test(shown), /Dispatching the inspector/.test(shown)], [true, true]);
	const sent0 = piApi.sentLog.length;
	editor = "please hurry";
	t("in place: typed text is consumed, with a notice", [termHandler("\r")?.consume, /read-only/.test(notes.at(-1) ?? "")], [true, true]);
	t("in place: Esc is consumed (it would stop the main session's turn), with a notice", [termHandler("\x1b")?.consume, /read-only/.test(notes.at(-1) ?? "")], [true, true]);
	t("in place: nothing reached the main session", piApi.sentLog.slice(sent0), []);
	editor = "/quit";
	t("in place: other commands go through as anywhere", termHandler("\r"), undefined);
	editor = "/model";
	t("in place: one that would act on the session on screen gets the notice", [termHandler("\r")?.consume, /read-only/.test(notes.at(-1) ?? "")], [true, true]);
	editor = "!ls";
	t("in place: ! is not run for it", termHandler("\r")?.consume, true);
	editor = "";
	await commands.subagents.handler("refresh", ctx);
	t("in place: refresh (a held command) does not switch either", [switched, /read-only/.test(notes.at(-1) ?? "")], [0, true]);
	await commands.subagents.handler("back", ctx);
	t("back: pi's chat back", [reg().view.inplace, doc.children[2] === chat], [undefined, true]);
	t("in place: its file untouched throughout", readFileSync(fo, "utf8").split("\n").filter(Boolean).length, 6);
}

// --- stop: SIGTERM to its process; gone: ended
{
	const r = runOf(expert.pid);
	await commands.subagents.handler("stop achilles-inspector", { hasUI: false });
	t("stop: its process ends", await until(() => expert.exitCode !== null || expert.signalCode !== null), true);
	t("end: done when gone", await until(() => runOf(expert.pid).status !== "running"), true);
	t("end: done (no error), ended set", [r.status, typeof r.ended], ["done", "number"]);
}
{
	appendFileSync(fo, line({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "server gone" } }));
	await sleep(150);
	orch.kill("SIGKILL");
	t("end: failed when its last answer was an error", await until(() => runOf(orch.pid).status === "failed"), true);
}

// --- the same pid again (reused) is a new run
{
	const again = livePid(), fa = join(work, "again.jsonl"); writeFileSync(fa, "");
	entry(again.pid, process.pid, fa, "second", Date.now() + 1);
	t("a new outside child is a new run", await until(() => !!runOf(again.pid)), true);
	t("one run per child", reg().runs.filter((r) => r.outside?.pid === again.pid).length, 1);
	await sleep(200);
	t("still one after more polls", reg().runs.filter((r) => r.outside?.pid === again.pid).length, 1);
}

// --- an outside child or a subagent does not watch (only the main session does)
{
	const reg2 = { ...mod };   // the module is per process: checked through what default() decides
	process.env.LETS_CODE_OUTSIDE_OF = String(process.pid);
	const g = globalThis[Symbol.for("lets-code.subagent-runs")]; const had = g.outsideTimer; delete g.outsideTimer; clearInterval(had);
	const f2 = join(agentDir, "extensions", "subagents-1.ts"); writeFileSync(f2, src);
	(await import(pathToFileURL(f2).href)).default({ ...piApi, on() {}, registerCommand() {} });
	t("an outside child does not watch", g.outsideTimer, undefined);
	delete process.env.LETS_CODE_OUTSIDE_OF;
	void reg2;
}

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
