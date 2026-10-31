#!/usr/bin/env node
// Unit and live test for the memory guard's size limits
// (~/.pi/agent/extensions/lets-code/memory-guard.ts). Loads it with a fake pi
// (this node process plays pi: its children are the session's processes) and
// real children that hold a few tens of MB, against tiny limits. Linux only;
// never more than ~200 MB in all. Needs Node >= 22.6.
//
//   tests/mem-guard.test.mjs [path/to/lets-code/memory-guard.ts]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "linux") { console.log("skipped: the memory guard is Linux only"); process.exit(0); }
const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/memory-guard.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "memguard-test-")));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0, n = 0;
function check(name, got, want) {
	n++;
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// every child this test starts, killed at the end whatever happens
const kids = new Set();
const cleanup = () => { for (const pid of kids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } kids.clear(); };
process.on("exit", () => { cleanup(); rmSync(work, { recursive: true, force: true }); });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(1));

// a process that touches <mb> MB, says "ready" and sleeps
const hog = join(work, "hog.py");
writeFileSync(hog, "import sys, time\nx = b'a' * (int(sys.argv[1]) << 20)\nprint('ready', flush=True)\ntime.sleep(120)\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^[ZX]$/.test(s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3)); } catch { return false; } };
const rssMb = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
function start(cmd, args, opts = {}) {
	const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
	kids.add(c.pid);
	c.on("exit", () => kids.delete(c.pid));
	const ready = new Promise((r) => { let out = ""; c.stdout.on("data", (d) => { out += d; if (out.includes("ready")) r(); }); c.on("exit", r); });
	return { pid: c.pid, ready };
}
const startHog = async (mb, opts) => { const h = start("python3", [hog, String(mb)], opts); await h.ready; return h.pid; };
async function until(f, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(25); } return f(); }

// Each load gets its own copy so module-level env reads see that load's env.
let loads = 0;
const sessions = join(work, "sessions"), log = join(work, "guard.log");
const quiet = { LETS_CODE_MEM_WARN: "0", LETS_CODE_MEM_CRITICAL: "0", LETS_CODE_MEM_STOP: "0", LETS_CODE_MEM_EMERGENCY: "0" };  // no pressure rule here
async function load(env) {
	for (const k of Object.keys(process.env)) if (k.startsWith("LETS_CODE_")) delete process.env[k];
	Object.assign(process.env, { LETS_CODE_SESSION: "1", LETS_CODE_MEM_IGNORE_SYSTEM_GUARD: "1", LETS_CODE_MEM_GUARD_POLL_MS: "50",
		LETS_CODE_SESSIONS_ON: "1", LETS_CODE_SESSIONS_DIR: sessions, LETS_CODE_MEM_GUARD_LOG: log, ...quiet }, env);
	for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
	const f = join(work, `memguard-${loads++}.ts`);
	writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {};
	mod.default({ on(ev, h) { handlers[ev] = h; } });
	const h = { mod, handlers, emit: (ev, e = {}) => handlers[ev]?.({ type: ev, ...e }, {}) };
	await h.emit("session_start");
	return h;
}
const stopGuard = async (h) => { await h.emit("session_shutdown"); cleanup(); };
// this process's registry entry: its inbox is where the guard's notices go
const register = (pid) => { mkdirSync(sessions, { recursive: true, mode: 0o700 }); writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid })); };
const inbox = (pid) => { try { return readdirSync(join(sessions, String(pid), "inbox")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(sessions, String(pid), "inbox", f), "utf8"))); } catch { return []; } };
const resetInbox = () => rmSync(sessions, { recursive: true, force: true });
const logLines = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const MB = 2 ** 20, GB = 2 ** 30;

// --- inert unless lets-code started this pi
{
	const h = await load({ LETS_CODE_SESSION: undefined });
	check("inert: no handlers without LETS_CODE_SESSION", Object.keys(h.handlers).length, 0);
}

// --- the limits: defaults scale with RAM, sizes, off
{
	const h = await load({});
	const L = h.mod.limitsOf;
	check("limits: default 20 % / 45 % of RAM", L(8 * GB, {}), { proc: 0.2 * 8 * GB, session: 0.45 * 8 * GB });
	check("limits: a size and a %", L(8 * GB, { LETS_CODE_MEM_GUARD_PROCESS: "1600M", LETS_CODE_MEM_GUARD_SESSION: "50%" }), { proc: 1600 * MB, session: 4 * GB });
	check("limits: 0 and off turn a rule off", L(8 * GB, { LETS_CODE_MEM_GUARD_PROCESS: "0", LETS_CODE_MEM_GUARD_SESSION: "off" }), { proc: 0, session: 0 });
	check("limits: empty is the default", L(10 * GB, { LETS_CODE_MEM_GUARD_PROCESS: "" }).proc, 2 * GB);
	await stopGuard(h);
}

// --- what is killed, on a made-up table
{
	const h = await load({});
	const P = (pid, mb, cmd = "python3 x.py") => ({ pid, ppid: 1, bytes: mb * MB, start: pid, argv: cmd.split(" "), cmd, cgroup: "" });
	const pick = (mine, lim) => h.mod.overLimits(mine, lim).map((k) => [k.p.pid, k.rule]);
	check("decide: over the per-process limit", pick([P(1, 10), P(2, 120)], { proc: 100 * MB, session: 0 }), [[2, "process"]]);
	check("decide: under every limit, nothing", pick([P(1, 10), P(2, 90)], { proc: 100 * MB, session: 1000 * MB }), []);
	check("decide: together over the session limit, the largest", pick([P(1, 40), P(2, 70), P(3, 30)], { proc: 0, session: 100 * MB }), [[2, "session"]]);
	check("decide: after the per-process kills, the session rule sees the rest", pick([P(1, 60), P(2, 200), P(3, 50)], { proc: 150 * MB, session: 100 * MB }), [[2, "process"], [1, "session"]]);
	check("decide: both off, nothing", pick([P(1, 9999)], { proc: 0, session: 0 }), []);
	check("agents: pi, node running pi, claude, tmux", ["pi", "/usr/bin/node /x/pi-coding-agent/dist/cli.js", "claude -p", "tmux"].map((c) => h.mod.isAgent(c.split(" "))), [true, true, true, true]);
	check("agents: not python, not a plain node script", ["python3 t.py", "node test.js"].map((c) => h.mod.isAgent(c.split(" "))), [false, false]);
	// the session a process belongs to: the nearest registered session above it
	const t = new Map([[10, { ppid: process.pid }], [11, { ppid: 10 }], [12, { ppid: 11 }], [20, { ppid: 1 }]]);
	resetInbox(); register(11);
	check("owner: a registered session in between owns it", h.mod.ownerOf(12, t, sessions), 11);
	check("owner: else this pi", [h.mod.ownerOf(11, t, sessions), h.mod.ownerOf(20, t, sessions)], [process.pid, process.pid]);
	const text = h.mod.killText({ p: P(4242, 1534, "python3 tests/test_calc.py"), rule: "process", limit: 1600 * MB, total: 1534 * MB }, 8 * GB);
	check("notice: says what, pid, size, limit and what to do", [/`python3 tests\/test_calc\.py` \(pid 4242\) at 1534 MB: over the per-process limit of 1600 MB/.test(text), /Don't run it again as it is/.test(text)], [true, true]);
	resetInbox();
	await stopGuard(h);
}

// --- live: an over-limit child is killed, the agent is told, the kill is logged
{
	resetInbox(); register(process.pid); rmSync(log, { force: true });
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off" });
	const small = await startHog(5);
	const pid = await startHog(50);
	check("kill: the 50 MB child is killed", await until(() => !alive(pid)), true);
	check("kill: the 5 MB child is left alone", alive(small), true);
	const msgs = inbox(process.pid);
	check("notice: one message in the owner's inbox", msgs.length, 1);
	const m = msgs[0] ?? {};
	check("notice: from the guard, no hops", [m.from?.kind, m.from?.name, m.hops], ["guard", "lets-code memory guard", 0]);
	check("notice: names the command, pid, size and limit", [m.text?.includes(`\`python3 ${hog} 50\``), m.text?.includes(`(pid ${pid}) at `), /at \d+ MB: over the per-process limit of 30 MB/.test(m.text ?? "")], [true, true, true]);
	const kills = logLines().filter((l) => l.event === "kill");
	check("log: the kill is logged", kills.map((l) => [l.pid, l.rule, l.limit, l.told]), [[pid, "process", 30 * MB, "inbox"]]);
	await stopGuard(h);
}

// --- live: under the limit nothing happens
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "100M", LETS_CODE_MEM_GUARD_SESSION: "200M" });
	const pid = await startHog(40);
	await sleep(500);
	check("under: a 40 MB child under 100M is left alone", alive(pid), true);
	check("under: no message", inbox(process.pid).length, 0);
	await stopGuard(h);
}

// --- live: a process outside the session is never touched
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off" });
	const c = spawn("sh", ["-c", `python3 ${hog} 50 >/dev/null 2>&1 & echo $!`], { stdio: ["ignore", "pipe", "ignore"] });
	let out = ""; c.stdout.on("data", (d) => { out += d; });
	await new Promise((r) => c.on("exit", r));
	const outsider = Number(out.trim());
	kids.add(outsider);
	await until(() => { try { return rssMb(outsider) > 40; } catch { return false; } });
	const ppid = Number(readFileSync(`/proc/${outsider}/stat`, "utf8").split(") ")[1].split(" ")[1]);
	check("outside: the orphan's parent is not this process", ppid !== process.pid, true);
	await sleep(500);
	check("outside: a 50 MB process outside the session survives a 30M limit", alive(outsider), true);
	check("outside: no message", inbox(process.pid).length, 0);
	await stopGuard(h);
}

// --- live: together over the session limit, the largest goes
{
	resetInbox(); register(process.pid); rmSync(log, { force: true });
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "off", LETS_CODE_MEM_GUARD_SESSION: "60M" });
	const a = await startHog(20);
	const b = await startHog(40);
	check("session: the largest (40 MB) is killed", await until(() => !alive(b)), true);
	await sleep(300);
	check("session: the smaller one stays once the total is under", alive(a), true);
	check("session: the notice names the session limit", /over the session limit of 60 MB/.test(inbox(process.pid)[0]?.text ?? ""), true);
	check("session: logged as the session rule", logLines().filter((l) => l.event === "kill").map((l) => [l.pid, l.rule]), [[b, "session"]]);
	await stopGuard(h);
}

// --- live: pi and the node running pi are never killed, whatever their size
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off" });
	const piHog = await startHog(50, { argv0: "pi" });
	mkdirSync(join(work, "pi-coding-agent"), { recursive: true });
	const nodeScript = join(work, "pi-coding-agent", "cli.js");
	writeFileSync(nodeScript, "globalThis.x = Buffer.alloc(50 << 20, 1); console.log('ready'); setTimeout(() => {}, 120000);\n");
	const nodePi = start(process.execPath, [nodeScript]); await nodePi.ready;
	const other = await startHog(50);
	check("agents: the guard ran (a plain 50 MB child is killed)", await until(() => !alive(other)), true);
	await sleep(300);
	check("agents: a process named pi survives", alive(piHog), true);
	check("agents: node running pi-coding-agent survives", alive(nodePi.pid), true);
	check("agents: this process (pi) is still here", alive(process.pid), true);
	await stopGuard(h);
}

// --- live: the session that owns the process is told, not this one
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off" });
	// a "subagent" (a shell registered as a session) runs the hog
	const sh = start("sh", ["-c", `python3 ${hog} 50; exec sleep 30`]);
	register(sh.pid);
	await sh.ready;
	check("owner: the hog under the subagent is killed", await until(() => inbox(sh.pid).length > 0), true);
	check("owner: the subagent's inbox has it, this session's has not", [inbox(sh.pid).length, inbox(process.pid).length], [1, 0]);
	await stopGuard(h);
}

// --- live: the same command again is killed, but told once
{
	resetInbox(); register(process.pid); rmSync(log, { force: true });
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off" });
	const one = await startHog(50);
	await until(() => !alive(one));
	const two = await startHog(50);
	check("repeat: killed again", await until(() => !alive(two)), true);
	await sleep(200);
	check("repeat: one message for both", inbox(process.pid).length, 1);
	check("repeat: both logged, the second as a repeat", logLines().filter((l) => l.event === "kill").map((l) => l.told), ["inbox", "repeat"]);
	const other = await startHog(51);
	await until(() => !alive(other));
	await sleep(200);
	check("repeat: a different command is told", inbox(process.pid).length, 2);
	await stopGuard(h);
}
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off", LETS_CODE_MEM_GUARD_REPEAT_S: "0" });
	for (let i = 0; i < 2; i++) { const p = await startHog(50); await until(() => !alive(p)); }
	await sleep(200);
	check("repeat: with no repeat window, told each time", inbox(process.pid).length, 2);
	await stopGuard(h);
}

// --- live: without sessions, the next tool result says it
{
	resetInbox();
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "30M", LETS_CODE_MEM_GUARD_SESSION: "off", LETS_CODE_SESSIONS_ON: undefined });
	const pid = await startHog(50);
	await until(() => !alive(pid));
	await sleep(100);
	const r = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "Killed" }] });
	const text = (r?.content ?? []).map((c) => c.text).join("");
	check("no sessions: the tool result names the kill", text.includes(`(pid ${pid})`) && text.includes("per-process limit of 30 MB"), true);
	check("no sessions: no inbox written", existsSync(sessions), false);
	const r2 = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] });
	check("no sessions: said once", r2, undefined);
	await stopGuard(h);
}

// --- live: both limits off, nothing is killed
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_MEM_GUARD_PROCESS: "off", LETS_CODE_MEM_GUARD_SESSION: "0" });
	const pid = await startHog(50);
	await sleep(500);
	check("off: a 50 MB child lives with both limits off", alive(pid), true);
	await stopGuard(h);
}

// --- off: no guard, nothing is killed
{
	resetInbox(); register(process.pid);
	const h = await load({ LETS_CODE_SESSION: undefined, LETS_CODE_MEM_GUARD_PROCESS: "30M" });
	const pid = await startHog(50);
	await sleep(500);
	check("disabled: a 50 MB child lives when the guard is off", alive(pid), true);
	await stopGuard(h);
}

cleanup();
console.log(`${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
