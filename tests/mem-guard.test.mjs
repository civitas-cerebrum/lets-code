#!/usr/bin/env node
// Unit and live test for the RAM watcher and the memory guard
// (~/.pi/agent/extensions/lets-code/memory-guard.ts). Loads it with a fake pi
// (this node process plays pi: its children are the session's processes).
// System memory is faked: LETS_CODE_MEM_INFO points at a made-up meminfo,
// so 80 or 85 % use and a "40 % of RAM" process need only a few MB. Real
// children hold at most 30 MB. Linux only. Needs Node >= 22.6.
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

let fail = 0, n = 0, last = "the start";
function check(name, got, want) {
	n++; last = name;
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// every child this test starts, killed at the end whatever happens
const kids = new Set();
const cleanup = () => { for (const pid of kids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } kids.clear(); };
process.on("exit", () => { cleanup(); rmSync(work, { recursive: true, force: true }); });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(1));
// bounded: past HANG_MS the test fails, naming the last check that ran and the children left
const HANG_MS = Number(process.env.MEM_GUARD_TEST_HANG_MS ?? 180_000);
setTimeout(() => {
	console.log(`FAIL  hung for ${HANG_MS / 1000}s after "${last}"; children still there: ${[...kids].map((p) => { try { return `${p} ${readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " ").trim()}`; } catch { return `${p} (gone)`; } }).join("; ") || "none"}`);
	cleanup(); process.exit(1);
}, HANG_MS).unref();

// a process that touches <mb> MB, says "ready" and sleeps
const hog = join(work, "hog.py");
writeFileSync(hog, "import sys, time\nx = b'a' * (int(sys.argv[1]) << 20)\nprint('ready', flush=True)\ntime.sleep(120)\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^[ZX]$/.test(s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3)); } catch { return false; } };
const rss = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) * 1024;
const childOf = (ppid) => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).find((pid) => { try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]) === ppid; } catch { return false; } });
function start(cmd, args, opts = {}) {
	const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
	kids.add(c.pid);
	c.on("exit", () => kids.delete(c.pid));
	// ready: it said so, it exited, or 15 s went by (never a wait without an end)
	const ready = new Promise((r) => { let out = ""; c.stdout.on("data", (d) => { out += d; if (out.includes("ready")) r(); }); c.on("exit", r); setTimeout(r, 15_000).unref(); });
	return { pid: c.pid, ready };
}
const startHog = async (mb, opts) => { const h = start("python3", [hog, String(mb)], opts); await h.ready; return h.pid; };
async function until(f, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(25); } return f(); }

// the machine's memory, made up: total and used fraction
const meminfo = join(work, "meminfo");
// (available rounded down a kB, so "85 %" is at least 85 %)
const setMem = (total, used) => { const kb = Math.round(total / 1024); writeFileSync(meminfo, `MemTotal:       ${kb} kB\nMemFree:        1 kB\nMemAvailable:   ${Math.floor(kb * (1 - used)) - 1} kB\n`); };
// a total that makes <pid> the given share of RAM
const totalFor = (pid, share) => rss(pid) / share;

// Each load gets its own copy so module-level env reads see that load's env.
let loads = 0;
const sessions = join(work, "sessions"), log = join(work, "guard.log");
async function load(env, ctx = {}) {
	for (const k of Object.keys(process.env)) if (k.startsWith("LETS_CODE_")) delete process.env[k];
	Object.assign(process.env, { LETS_CODE_SESSION: "1", LETS_CODE_MEM_IGNORE_SYSTEM_GUARD: "1", LETS_CODE_MEM_GUARD_POLL_MS: "50",
		LETS_CODE_MEM_GUARD_ABANDON_MS: "100", LETS_CODE_MEM_INFO: meminfo,
		LETS_CODE_SESSIONS_ON: "1", LETS_CODE_SESSIONS_DIR: sessions, LETS_CODE_MEM_GUARD_LOG: log }, env);
	for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
	const f = join(work, `memguard-${loads++}.ts`);
	writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, commands = {};
	mod.default({ on(ev, h) { handlers[ev] = h; }, registerCommand(name, c) { commands[name] = c; } });
	const h = { mod, handlers, commands, emit: (ev, e = {}) => handlers[ev]?.({ type: ev, ...e }, ctx) };
	await h.emit("session_start");
	return h;
}
const stopGuard = async (h) => { await h.emit("session_shutdown"); cleanup(); };
// this process's registry entry: its inbox is where the notices go
const register = (pid) => { mkdirSync(sessions, { recursive: true, mode: 0o700 }); writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid })); };
const inbox = (pid) => { try { return readdirSync(join(sessions, String(pid), "inbox")).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(sessions, String(pid), "inbox", f), "utf8"))); } catch { return []; } };
const resetInbox = () => rmSync(sessions, { recursive: true, force: true });
const logLines = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const MB = 2 ** 20, GB = 2 ** 30;
const noWatch = { LETS_CODE_MEM_WATCH: "false" };   // tests of the guard alone
const fresh = () => { resetInbox(); register(process.pid); rmSync(log, { force: true }); setMem(8 * GB, 0.5); };

// --- inert unless lets-code started this pi
{
	const h = await load({ LETS_CODE_SESSION: undefined });
	check("inert: no handlers without LETS_CODE_SESSION", Object.keys(h.handlers).length, 0);
}

// --- the kill rule, on made-up tables: > 40 % of RAM, only while > 80 % is used
{
	const h = await load({});
	const P = (pid, bytes, cmd = "python3 x.py") => ({ pid, ppid: 1, bytes, start: pid, argv: cmd.split(" "), cmd });
	const T = 100 * MB, pick = (mine, used) => h.mod.overLimit(mine, { total: T, avail: T * (1 - used) }).map((k) => k.p.pid);
	check("rule: 41 % at 81 % used is killed", pick([P(1, 41 * MB), P(2, 10 * MB)], 0.81), [1]);
	check("rule: 41 % at 79 % used is left", pick([P(1, 41 * MB)], 0.79), []);
	check("rule: 41 % at exactly 80 % is left", pick([P(1, 41 * MB)], 0.80), []);
	check("rule: 39 % at 95 % used is left", pick([P(1, 39 * MB)], 0.95), []);
	check("rule: exactly 40 % is left", pick([P(1, 40 * MB)], 0.95), []);
	check("rule: two over 40 %, largest first", pick([P(1, 41 * MB), P(2, 45 * MB)], 0.99), [2, 1]);
	check("constants: 80 / 40 / 85 / 75", [h.mod.GUARD_USED, h.mod.GUARD_PROC, h.mod.WATCH_AT, h.mod.WATCH_RESET], [0.8, 0.4, 0.85, 0.75]);
	check("flags: default, true, false", [h.mod.flag(undefined, false), h.mod.flag("", true), h.mod.flag("true", false), h.mod.flag("1", false), h.mod.flag("false", true), h.mod.flag("off", true)], [false, true, true, true, false, false]);
	check("agents: pi, node running pi, claude, tmux", ["pi", "/usr/bin/node /x/pi-coding-agent/dist/cli.js", "claude -p", "tmux"].map((c) => h.mod.isAgent(c.split(" "))), [true, true, true, true]);
	check("agents: not python, not a plain node script", ["python3 t.py", "node test.js"].map((c) => h.mod.isAgent(c.split(" "))), [false, false]);
	// the session a process belongs to: the nearest registered session above it
	const t = new Map([[10, { ppid: process.pid }], [11, { ppid: 10 }], [12, { ppid: 11 }], [20, { ppid: 1 }]]);
	resetInbox(); register(11);
	check("owner: a registered session in between owns it", h.mod.ownerOf(12, t, sessions), 11);
	check("owner: else this pi", [h.mod.ownerOf(11, t, sessions), h.mod.ownerOf(20, t, sessions)], [process.pid, process.pid]);
	const text = h.mod.killText({ p: P(4242, 3400 * MB, "python3 tests/test_calc.py"), limit: 3277 * MB, used: 0.91 }, 8 * GB);
	check("notice: says what, pid, size, rule and what to do", [/`python3 tests\/test_calc\.py` \(pid 4242\) at 3400 MB: over 40 % of this machine's RAM \(3277 MB of 8\.0 GiB\) while 91 % of it was in use/.test(text), /Don't run it again as it is/.test(text)], [true, true]);
	await stopGuard(h);
}

// --- abandoned, on made-up tables: this run's marker, and its pi gone
{
	const h = await load({});
	const RUN = "1000:5", t = new Map([
		[50, { pid: 50, ppid: 1, bytes: MB, start: 1 }],                 // this run, its pi gone
		[51, { pid: 51, ppid: 1, bytes: MB, start: 1 }],                 // this run, its pi alive
		[52, { pid: 52, ppid: 1, bytes: MB, start: 1 }],                 // another run, its pi gone
		[53, { pid: 53, ppid: 1, bytes: MB, start: 1 }],                 // no markers
		[54, { pid: 54, ppid: 1, bytes: MB, start: 1 }],                 // this run, pi gone, but it is a pi
		[55, { pid: 55, ppid: process.pid, bytes: MB, start: 1 }],       // this run, pi gone, but under this pi
		[56, { pid: 56, ppid: 1, bytes: MB, start: 1 }],                 // unreadable (another user's)
		[57, { pid: 57, ppid: 1, bytes: MB, start: 1 }],                 // only the run marker
	]);
	const env = { 50: { LETS_CODE_RUN: RUN, LETS_CODE_PI: "2000:7" }, 51: { LETS_CODE_RUN: RUN, LETS_CODE_PI: "3000:9" }, 52: { LETS_CODE_RUN: "999:1", LETS_CODE_PI: "2000:7" },
		53: {}, 54: { LETS_CODE_RUN: RUN, LETS_CODE_PI: "2000:7" }, 55: { LETS_CODE_RUN: RUN, LETS_CODE_PI: "2000:7" }, 56: null, 57: { LETS_CODE_RUN: RUN } };
	const argv = (pid) => (pid === 54 ? ["pi"] : ["sleep", "60"]);
	const got = h.mod.abandonedOf(t, RUN, process.pid, (pid) => env[pid], (m) => m === "3000:9", argv).map((p) => p.pid);
	check("abandoned: only this run's process whose pi is gone", got, [50]);
	check("abandoned: piAlive knows this process, not a reused pid", [h.mod.piAlive(h.mod.SELF), h.mod.piAlive(`${process.pid}:1`), h.mod.piAlive("999999999:1")], [true, false, false]);
	await stopGuard(h);
}

// --- off by default; on by env; on and off in the session
{
	fresh();
	const h = await load({ ...noWatch });
	const pid = await startHog(30);
	setMem(totalFor(pid, 0.5), 0.95);
	await sleep(400);
	check("default: the guard is off, a 50 % process at 95 % lives", alive(pid), true);
	check("default: /memguard is there", typeof h.commands.memguard?.handler, "function");
	const said = [];
	await h.commands.memguard.handler("on", { hasUI: true, ui: { notify: (t) => said.push(t) } });
	check("/memguard on: it is killed", await until(() => !alive(pid)), true);
	check("/memguard on: says so", /^memory guard on; RAM 95 % used/.test(said[0] ?? ""), true);
	await h.commands.memguard.handler("off", { hasUI: true, ui: { notify: (t) => said.push(t) } });
	const two = await startHog(30);
	setMem(totalFor(two, 0.5), 0.95);
	await sleep(400);
	check("/memguard off: a 50 % process at 95 % lives again", alive(two), true);
	await h.commands.memguard.handler("maybe", { hasUI: true, ui: { notify: (t) => said.push(t) } });
	check("/memguard: a bad argument is refused", said.at(-1), "usage: /memguard [on|off]");
	check("log: the toggles are logged", logLines().filter((l) => l.event === "toggle").map((l) => l.guard), [true, false]);
	await stopGuard(h);
}
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	const pid = await startHog(30);
	setMem(totalFor(pid, 0.5), 0.95);
	check("env LETS_CODE_MEM_GUARD=true: on from the start", await until(() => !alive(pid)), true);
	await stopGuard(h);
}
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "false", ...noWatch });
	const pid = await startHog(30);
	setMem(totalFor(pid, 0.5), 0.95);
	await sleep(400);
	check("env LETS_CODE_MEM_GUARD=false: off", alive(pid), true);
	await stopGuard(h);
}

// --- live: the kill rule, its notice and log
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	const small = await startHog(5);
	const pid = await startHog(30);
	const T = totalFor(pid, 0.45);
	setMem(T, 0.79);
	await sleep(400);
	check("live: a 45 % process at 79 % used lives", alive(pid), true);
	setMem(T, 0.95);
	check("live: at 95 % used it is killed", await until(() => !alive(pid)), true);
	check("live: the small one is left alone", alive(small), true);
	const msgs = inbox(process.pid);
	check("notice: one message in the owner's inbox", msgs.length, 1);
	const m = msgs[0] ?? {};
	check("notice: from the guard, no hops", [m.from?.kind, m.from?.name, m.hops], ["guard", "lets-code memory guard", 0]);
	check("notice: names the command, pid and the rule", [m.text?.includes(`\`python3 ${hog} 30\``), m.text?.includes(`(pid ${pid}) at `), /over 40 % of this machine's RAM .* while 95 % of it was in use/.test(m.text ?? "")], [true, true, true]);
	const kills = logLines().filter((l) => l.event === "kill");
	check("log: the kill is logged", kills.map((l) => [l.pid, l.rule, l.told]), [[pid, "size", "inbox"]]);
	await stopGuard(h);
}
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	const pid = await startHog(30);
	setMem(totalFor(pid, 0.36), 0.95);
	await sleep(400);
	check("live: a 36 % process at 95 % used lives", alive(pid), true);
	check("live: no message", inbox(process.pid).length, 0);
	await stopGuard(h);
}

// --- live: a process outside the session is never touched
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	// no markers either: env -u, so it is not "abandoned"
	const c = spawn("sh", ["-c", `env -u LETS_CODE_RUN -u LETS_CODE_PI python3 ${hog} 30 >/dev/null 2>&1 & echo $!`], { stdio: ["ignore", "pipe", "ignore"] });
	let out = ""; c.stdout.on("data", (d) => { out += d; });
	await new Promise((r) => c.on("exit", r));
	const outsider = Number(out.trim());
	kids.add(outsider);
	await until(() => { try { return rss(outsider) > 25 * MB; } catch { return false; } });
	const ppid = Number(readFileSync(`/proc/${outsider}/stat`, "utf8").split(") ")[1].split(" ")[1]);
	check("outside: the orphan's parent is not this process", ppid !== process.pid, true);
	setMem(totalFor(outsider, 0.6), 0.97);
	await sleep(500);
	check("outside: a 60 % process outside the session survives 97 % use", alive(outsider), true);
	check("outside: no message", inbox(process.pid).length, 0);
	await stopGuard(h);
}

// --- live: pi and the node running pi are never killed, whatever their size
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	const piHog = await startHog(30, { argv0: "pi" });
	mkdirSync(join(work, "pi-coding-agent"), { recursive: true });
	const nodeScript = join(work, "pi-coding-agent", "cli.js");
	writeFileSync(nodeScript, "globalThis.x = Buffer.alloc(30 << 20, 1); console.log('ready'); setTimeout(() => {}, 120000);\n");
	const nodePi = start(process.execPath, [nodeScript]); await nodePi.ready;
	const other = await startHog(30);
	setMem(Math.min(rss(piHog), rss(nodePi.pid), rss(other)) / 0.45, 0.97);
	check("agents: the guard ran (a plain 45 % child is killed)", await until(() => !alive(other)), true);
	await sleep(300);
	check("agents: a process named pi survives", alive(piHog), true);
	check("agents: node running pi-coding-agent survives", alive(nodePi.pid), true);
	check("agents: this process (pi) is still here", alive(process.pid), true);
	await stopGuard(h);
}

// --- live: the session that owns the process is told, not this one
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	// a "subagent" (a shell registered as a session) runs the hog
	const sh = start("sh", ["-c", `python3 ${hog} 30; exec sleep 30`]);
	register(sh.pid);
	await sh.ready;
	const py = childOf(sh.pid);
	setMem(totalFor(py, 0.5), 0.95);
	check("owner: the hog under the subagent is killed", await until(() => inbox(sh.pid).length > 0), true);
	check("owner: the subagent's inbox has it, this session's has not", [inbox(sh.pid).length, inbox(process.pid).length], [1, 0]);
	await stopGuard(h);
}

// --- live: the same command again is killed, but told once
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", ...noWatch });
	setMem(40 * MB, 0.95);   // a 30 MB hog is far over 40 % of this
	const one = await startHog(30);
	await until(() => !alive(one));
	const two = await startHog(30);
	check("repeat: killed again", await until(() => !alive(two)), true);
	await sleep(200);
	check("repeat: one message for both", inbox(process.pid).length, 1);
	check("repeat: both logged, the second as a repeat", logLines().filter((l) => l.event === "kill").map((l) => l.told), ["inbox", "repeat"]);
	const other = await startHog(29);
	await until(() => !alive(other));
	await sleep(200);
	check("repeat: a different command is told", inbox(process.pid).length, 2);
	await stopGuard(h);
}
{
	fresh();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", LETS_CODE_MEM_GUARD_REPEAT_S: "0", ...noWatch });
	setMem(40 * MB, 0.95);
	for (let i = 0; i < 2; i++) { const p = await startHog(30); await until(() => !alive(p)); }
	await sleep(200);
	check("repeat: with no repeat window, told each time", inbox(process.pid).length, 2);
	await stopGuard(h);
}

// --- live: without sessions, the next tool result says it
{
	fresh(); resetInbox();
	const h = await load({ LETS_CODE_MEM_GUARD: "true", LETS_CODE_SESSIONS_ON: undefined, ...noWatch });
	setMem(40 * MB, 0.95);
	const pid = await startHog(30);
	await until(() => !alive(pid));
	await sleep(100);
	const r = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "Killed" }] });
	const text = (r?.content ?? []).map((c) => c.text).join("");
	check("no sessions: the tool result names the kill", text.includes(`(pid ${pid})`) && text.includes("over 40 % of this machine's RAM"), true);
	check("no sessions: no inbox written", existsSync(sessions), false);
	const r2 = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] });
	check("no sessions: said once", r2, undefined);
	await stopGuard(h);
}

// --- the watcher: suggests at 85 %, once per crossing, kills nothing
{
	fresh();
	const notes = [];
	const h = await load({}, { hasUI: true, ui: { notify: (t, lv) => notes.push([t, lv]) } });
	const pid = await startHog(30);
	setMem(totalFor(pid, 0.6), 0.84);
	await sleep(300);
	check("watcher: nothing at 84 %", [notes.length, inbox(process.pid).length], [0, 0]);
	setMem(totalFor(pid, 0.6), 0.85);
	check("watcher: at 85 % the UI is told", await until(() => notes.length === 1), true);
	check("watcher: the notice suggests /memguard on", /^RAM 85 % used\. \/memguard on turns on the memory guard/.test(notes[0]?.[0] ?? "") && notes[0]?.[1] === "warning", true);
	await until(() => inbox(process.pid).length === 1);
	const m = inbox(process.pid)[0] ?? {};
	check("watcher: the agent's inbox has it, from the watcher", [m.from?.kind, m.from?.name, /RAM is 85 % used .* Memory is tight/.test(m.text ?? "")], ["guard", "lets-code memory watcher", true]);
	check("watcher: kills nothing (a 60 % process lives)", alive(pid), true);
	setMem(totalFor(pid, 0.6), 0.95); await sleep(200);
	setMem(totalFor(pid, 0.6), 0.80); await sleep(200);
	setMem(totalFor(pid, 0.6), 0.90); await sleep(200);
	check("watcher: once per crossing (no reset above 75 %)", [notes.length, inbox(process.pid).length], [1, 1]);
	setMem(totalFor(pid, 0.6), 0.74); await sleep(200);
	setMem(totalFor(pid, 0.6), 0.86);
	check("watcher: below 75 % and back over 85 %: told again", await until(() => notes.length === 2 && inbox(process.pid).length === 2), true);
	check("watcher: still kills nothing", alive(pid), true);
	check("log: watcher notices logged", logLines().filter((l) => l.event === "watch").map((l) => [l.guard, l.told]), [[false, "inbox"], [false, "inbox"]]);
	await h.commands.memguard.handler("on", { hasUI: true, ui: { notify: () => {} } });
	setMem(totalFor(pid, 0.3), 0.70); await sleep(200);
	setMem(totalFor(pid, 0.3), 0.88);
	check("watcher: with the guard on, the notice says it is on", await until(() => notes.length === 3), true);
	check("watcher: ... in the UI and to the agent", [notes[2]?.[0], /The memory guard is on/.test(inbox(process.pid).at(-1)?.text ?? "")], ["RAM 88 % used; the memory guard is on.", true]);
	await stopGuard(h);
}
{
	fresh();
	const notes = [];
	const h = await load({ LETS_CODE_MEM_WATCH: "false" }, { hasUI: true, ui: { notify: (t) => notes.push(t) } });
	setMem(8 * GB, 0.95);
	await sleep(300);
	check("watcher off: nothing at 95 %", [notes.length, inbox(process.pid).length], [0, 0]);
	await stopGuard(h);
}
{
	fresh(); resetInbox();
	const h = await load({ LETS_CODE_SESSIONS_ON: undefined });
	setMem(8 * GB, 0.9);
	await sleep(300);
	const r = await h.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] });
	check("watcher without sessions: the next tool result says it", /\[lets-code memory watcher\] this machine's RAM is 90 % used/.test((r?.content ?? []).map((c) => c.text).join("")), true);
	await stopGuard(h);
}

// --- markers: what this pi starts carries them; a subagent's pi stays out of the way
{
	fresh();
	const h = await load({});
	check("markers: LETS_CODE_PI and LETS_CODE_RUN are this pi", [process.env.LETS_CODE_PI, process.env.LETS_CODE_RUN], [h.mod.SELF, h.mod.SELF]);
	const sub = await load({ LETS_CODE_RUN: "1:1" });
	check("markers: a subagent's pi sets its own LETS_CODE_PI, keeps the run", [process.env.LETS_CODE_PI, process.env.LETS_CODE_RUN], [sub.mod.SELF, "1:1"]);
	check("markers: a subagent's pi runs no watcher or guard", [Object.keys(sub.handlers).length, Object.keys(sub.commands).length], [0, 0]);
	await stopGuard(h);
}

// --- live: abandoned processes
const orphan = async (env, cmd = "sleep 60") => {
	// a shell that plays a pi: it marks what it starts as its own, starts it and exits
	const c = spawn("sh", ["-c", `${env} ${cmd} >/dev/null 2>&1 & echo $!`], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
	let out = ""; c.stdout.on("data", (d) => { out += d; });
	await new Promise((r) => c.on("exit", r));
	const pid = Number(out.trim()); kids.add(pid);
	await until(() => existsSync(`/proc/${pid}/environ`) && readFileSync(`/proc/${pid}/cmdline`, "utf8").length > 0);
	return pid;
};
{
	fresh();
	const h = await load({ ...noWatch });
	const RUN = process.env.LETS_CODE_RUN;
	const deadPi = "999999999:1";
	const left = await orphan(`LETS_CODE_PI=${deadPi}`);
	const stubborn = await orphan(`LETS_CODE_PI=${deadPi}`, `python3 -c "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(60)"`);
	const ownPiAlive = await orphan("");                                                // LETS_CODE_PI = this pi (alive)
	const otherRun = await orphan(`LETS_CODE_RUN=1:1 LETS_CODE_PI=${deadPi}`);
	const unmarked = await orphan("env -u LETS_CODE_RUN -u LETS_CODE_PI");
	const namedPi = await (async () => { const c = spawn("bash", ["-c", `(export LETS_CODE_PI=${deadPi}; exec -a pi sleep 60) >/dev/null 2>&1 & echo $!`], { stdio: ["ignore", "pipe", "ignore"] }); let o = ""; c.stdout.on("data", (d) => { o += d; }); await new Promise((r) => c.on("exit", r)); const p = Number(o.trim()); kids.add(p); return p; })();
	// the stubborn one ignores SIGTERM before the guard looks
	await until(() => { const m = /SigIgn:\s+([0-9a-f]+)/.exec(readFileSync(`/proc/${stubborn}/status`, "utf8")); return !!m && (BigInt(`0x${m[1]}`) & (1n << 14n)) !== 0n; });
	setMem(8 * GB, 0.3);   // abandoned processes go whatever the memory use
	await h.commands.memguard.handler("on", { hasUI: true, ui: { notify: () => {} } });
	check("abandoned: this run's process whose pi is gone is ended", await until(() => !alive(left)), true);
	check("abandoned: one that ignores SIGTERM gets SIGKILL", await until(() => !alive(stubborn)), true);
	await sleep(400);
	check("abandoned: its pi still running: left alone", alive(ownPiAlive), true);
	check("abandoned: another run's: left alone", alive(otherRun), true);
	check("abandoned: no markers: left alone", alive(unmarked), true);
	check("abandoned: a process named pi: left alone", alive(namedPi), true);
	check("abandoned: the run marker is this pi's", RUN, h.mod.SELF);
	const ev = logLines().filter((l) => l.event === "abandoned");
	check("abandoned: logged, SIGTERM then SIGKILL for the stubborn one", [ev.filter((l) => l.pid === left).map((l) => l.signal), ev.filter((l) => l.pid === stubborn).map((l) => l.signal)], [["SIGTERM"], ["SIGTERM", "SIGKILL"]]);
	const msgs = inbox(process.pid).filter((m) => /abandoned/.test(m.text));
	check("abandoned: the agent is told once (rate-limited)", msgs.length, 1);
	check("abandoned: the notice names them", /ended 2 abandoned processes left running by a pi of this session that has exited/.test(msgs[0]?.text ?? ""), true);
	const again = await orphan(`LETS_CODE_PI=${deadPi}`);
	check("abandoned: a later one is ended too", await until(() => !alive(again)), true);
	await sleep(200);
	check("abandoned: ... without a second notice", inbox(process.pid).filter((m) => /abandoned/.test(m.text)).length, 1);
	await stopGuard(h);
}
{
	fresh();
	const h = await load({});
	const left = await orphan("LETS_CODE_PI=999999999:1");
	await sleep(400);
	check("abandoned: with the guard off, left alone", alive(left), true);
	await stopGuard(h);
}

cleanup();
console.log(`${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
