#!/usr/bin/env node
// Unit test for the drawing side of the subagent sessions, which lets-code
// writes next to the subagents module
// (~/.pi/agent/extensions/lets-code/subagent-view.ts): the order and
// formatting of runs, the footer list (/subagents toggle) and the picker
// (/subagents, alt+s) at phone (70) and wide (120) widths, the picker's
// keys, and the live part of a running child's session (what its session
// file does not hold yet), with a fake TUI and the plain helpers (no pi, no
// terminal). Needs Node >= 22.6.
//
//   tests/subagent-view.test.mjs [path/to/lets-code/subagents.ts]
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/subagents.ts");
const viewPath = join(dirname(extPath), "subagent-view.ts");
if (!existsSync(viewPath)) { console.log(`no ${viewPath}`); process.exit(1); }
const v = await import(pathToFileURL(viewPath).href);

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const W = (s) => v.plainWidth(s);
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const now = 1_000_000_000;
const ev = (o) => ({ v: 0, at: now, ...o });
const run = (o) => ({ v: 1, kind: "subagent", cwd: "/work", session: "s1", turns: 1, input: 1200, output: 340, dropped: 0, ver: 0, events: [ev({ t: "user", text: o.task ?? "task" })], ...o });
const runs = [
	run({ id: "a", agent: "scout", task: "Map the config loader in src/config and report the files", status: "done", started: now - 90_000, ended: now - 30_000 }),
	run({ id: "b", agent: "reviewer", task: "Review the parser change for missed edge cases", status: "running", started: now - 20_000 }),
	run({ id: "c", agent: "scout", task: "Find where the CLI flags are parsed", status: "running", started: now - 25_000 }),
	run({ id: "d", agent: "termux-device", kind: "expert", task: "Brief for the termux-device expert.\n\n## Goal\nopen the PDF in Files", status: "failed", exitCode: 3, started: now - 300_000, ended: now - 290_000 }),
	run({ id: "e", agent: "worker", task: "Add the --dry-run flag", status: "aborted", started: now - 60_000, ended: now - 10_000 }),
];

// --- formatting and order
t("elapsed", [v.elapsed(5_400), v.elapsed(63_000), v.elapsed(3_723_000)], ["5s", "1m 03s", "1h 02m"]);
t("compact", [v.compact(999), v.compact(1234), v.compact(45_600), v.compact(2_300_000)], ["999", "1.2k", "46k", "2.3M"]);
t("order: running first (as they started), then finished newest first", v.order(runs).map((r) => r.id), ["c", "b", "e", "a", "d"]);
t("summary: an expert brief loses its preamble and headings", v.summary(runs[3].task), "open the PDF in Files");
t("status labels", runs.map(v.statusLabel), ["done", "running", "running", "failed (exit 3)", "stopped"]);

// --- the footer list, which is also the navigator
{
	t("footer: nothing without runs", v.footerLines([], { width: 120, now }), []);
	t("nav rows: the main session, then the runs in order", v.navRows(runs).map((r) => r.id ?? r.kind), ["main", "c", "b", "e", "a", "d"]);
	const wide = v.footerLines(runs, { width: 120, now, current: "b" }).map(strip);
	t("footer: the main session first, then the runs, running first, then a line of keys", [wide.length, wide[0].slice(1, 8), wide.slice(1, 5).map((l) => l.slice(1, 3) + l.slice(3).trim().split(/\s+/)[0]), /alt\+s: switch session$/.test(wide.at(-1))], [v.FOOTER_ROWS + 1, "◂ main ", ["● scout", "● reviewer", "■ worker", "✓ scout"], true]);
	t("footer: at most FOOTER_ROWS rows; the keys line says how many more", /↓1 more · alt\+s: switch session/.test(wide.at(-1)), false);
	t("footer: the open session is marked", [wide[2].startsWith("▸"), wide[0].startsWith(" "), v.footerLines(runs, { width: 120, now }).map(strip)[0].startsWith("▸")], [true, true, true]);
	t("footer wide: the task, the elapsed time and ↑in ↓out", [/Find where the CLI flags/.test(wide[1]), /25s/.test(wide[1]), /↑1\.2k ↓340/.test(wide[1])], [true, true, true]);
	const mid = v.footerLines(runs, { width: 90, now }).map(strip);
	t("footer under 100 columns: no task, the clock and tokens stay", [/Find where/.test(mid[1]), /25s/.test(mid[1]), /↑1\.2k ↓340/.test(mid[1])], [false, true, true]);
	const phone = v.footerLines(runs, { width: 70, now }).map(strip);
	t("footer at 70 columns: one total for the tokens", [/25s · 1\.5k$/.test(phone[1].trimEnd()), phone.every((l) => W(l) <= 70)], [true, true]);
	t("footer: every line fits, at any width, navigating or not", [40, 70, 90, 120].every((w) => [undefined, 0, 3].every((sel) => v.footerLines(runs, { width: w, now, selected: sel }).every((l) => W(l) <= w))), true);
	const many = Array.from({ length: 14 }, (_, i) => run({ id: `m${i}`, agent: `w${i}`, task: `job ${i}`, status: "done", started: now - 1000 * i, ended: now - 500 * i }));
	const still = v.footerLines(many, { width: 70, now }).map(strip);
	t("footer: more runs than rows: the first rows and how many more", [still.length, /↓9 more · ↓ or alt\+s: switch session/.test(still.at(-1))], [v.FOOTER_ROWS + 1, true]);
	const nav = v.footerLines(many, { width: 70, now, selected: 10 }).map(strip);
	t("navigating: a window around the selection, the same height, the keys", [nav.length, nav.length > 0 && !nav.some((l) => l.includes("→")), /^↑\d+ ↓\d+ more · ↑↓ select · enter switch · esc back$/.test(nav.at(-1))], [v.FOOTER_ROWS + 1, true, true]);
	const nav0 = v.footerLines(runs, { width: 70, now, selected: 0, current: "b" }).map(strip);
	t("navigating: the main row selectable; x only offered on a running run", [nav0[0].startsWith(" ◂ main"), /x stop/.test(nav0.at(-1)), /x stop/.test(v.footerLines(runs, { width: 70, now, selected: 1 }).map(strip).at(-1))], [true, false, true]);
	t("navigating: the stop asks first", strip(v.footerLines(runs, { width: 70, now, selected: 1, confirm: true }).at(-1)), "Stop scout? x again stops it");
	const accent = { fg: (c, x) => `<${c}>${x}</${c}>` };
	const focA = v.footerLines(runs, { width: 70, now, selected: 2, current: "c", theme: accent });
	t("focused: the selected row in the accent only (pi's list colour), no marker of its own, no inversion, no other colour inside", [/^<accent> ● reviewer/.test(focA[2]), (focA[2].match(/<[a-z]+>/g) ?? []).join(), focA.some((l) => l.includes("\x1b[7m"))], [true, "<accent>", false]);
	const both = v.footerLines(runs, { width: 70, now, selected: 2, current: "b" }).map(strip), bothW = v.footerLines(runs, { width: 120, now, selected: 2, current: "b" }).map(strip);
	t("selected and open: ▸ stays, with every cue, with every cue (mark, name, elapsed, tokens)", [both[2].startsWith("▸● reviewer"), /20s · 1\.5k$/.test(both[2].trimEnd()), bothW[2].startsWith("▸● reviewer"), /Review the parser/.test(bothW[2]), /20s/.test(bothW[2]), /↑1\.2k ↓340/.test(bothW[2])], [true, true, true, true, true, true]);
	t("selected, not open: the cues stay too", [v.footerLines(runs, { width: 70, now, selected: 3, current: "b" }).map(strip)[3].startsWith(" ■ worker"), /50s · 1\.5k$/.test(v.footerLines(runs, { width: 70, now, selected: 3, current: "b" }).map(strip)[3].trimEnd())], [true, true]);
	t("the columns stay put as the selection moves: every row the same width up to the name", [0, 1, 2, 3].every((sel) => v.footerLines(runs, { width: 70, now, selected: sel, current: "b" }).slice(0, -1).map(strip).every((l) => /^[▸ ][●✓✗■◂] /.test(l) && !l.includes("→"))), true);
	t("focused: the other rows keep their colours; the open session keeps ▸", [/^<accent>▸<\/accent><accent>●<\/accent> scout/.test(focA[1]), /<success>✓<\/success>/.test(focA.join("\n"))], [true, true]);
	const unf = v.footerLines(runs, { width: 70, now, theme: accent }), foc = v.footerLines(runs, { width: 70, now, selected: 1, theme: accent });
	t("not focused: dim names, no accent row; the keys line says ↓ or alt+s", [unf.slice(0, -1).every((l) => !/^<accent> |^<accent>▸.*<\/accent>$/.test(l)), /<muted>scout/.test(unf[1]), /↓ or alt\+s: switch session/.test(unf.at(-1))], [true, true, true]);
	t("focused: the keys line in the accent", /^<accent>.*esc back<\/accent>$/.test(foc.at(-1)), true);
	t("footer: the same height navigating or not (no jump when focus moves)", [v.footerLines(runs, { width: 70, now }).length, v.footerLines(runs, { width: 70, now, selected: 2 }).length], [v.FOOTER_ROWS + 1, v.FOOTER_ROWS + 1]);
}

// --- the part on its way: what the session file does not hold yet
{
	const cmd = { command: "sleep 25" };
	const live = run({ id: "l", agent: "scout", task: "Task: look", status: "running", started: now - 30_000, events: [
		ev({ t: "user", text: "Task: look" }),
		ev({ t: "assistant", done: true, blocks: [{ type: "thinking", text: "first the sleep" }, { type: "toolCall", id: "c1", name: "bash", text: "", args: cmd }] }),
		ev({ t: "tool", id: "c1", name: "bash", args: cmd, done: true, output: "", cut: 0 }),
		ev({ t: "assistant", done: true, blocks: [{ type: "toolCall", id: "c2", name: "read", text: "", args: { path: "calc.py" } }, { type: "toolCall", id: "c3", name: "bash", text: "", args: { command: "ls" } }] }),
		ev({ t: "tool", id: "c2", name: "read", args: { path: "calc.py" }, done: true, output: "def add", cut: 0 }),
		ev({ t: "tool", id: "c3", name: "bash", args: { command: "ls" }, done: false, output: "", cut: 0 }),
		ev({ t: "note", text: "retrying (attempt 1/3)", error: true }),
		ev({ t: "assistant", done: false, blocks: [{ type: "text", text: "Found it" }] }),
	] });
	const entries = (msgs) => [{ type: "session" }, { type: "model_change" }, ...msgs.map((m) => ({ type: "message", message: m }))];
	const file0 = v.loadedOf(entries([]));
	t("tail: an empty file: everything", v.tailEvents(live, file0).length, live.events.length);
	const file2 = v.loadedOf(entries([{ role: "user", content: "Task: look" }, { role: "assistant", content: [{ type: "toolCall", id: "c1" }] }]));
	t("tail: past the loaded messages; a loaded call with no output yet is pi's to draw", v.tailEvents(live, file2).map((e) => e.t + (e.id ? `:${e.id}` : "")), ["tool:c1", "assistant", "tool:c2", "tool:c3", "note", "assistant"]);
	const file4 = v.loadedOf(entries([{ role: "user", content: "Task: look" }, { role: "assistant", content: [{ type: "toolCall", id: "c1" }] }, { role: "toolResult", toolCallId: "c1" },
		{ role: "assistant", content: [{ type: "toolCall", id: "c2" }, { type: "toolCall", id: "c3" }] }, { role: "toolResult", toolCallId: "c2" }]));
	t("tail: the file caught up: the running tool (its call is drawn by pi), the note and the message on its way", v.tailEvents(live, file4).map((e) => e.t), ["note", "assistant"]);
	live.events[5].output = "calc.py\n";
	t("tail: once it streams output, the running tool shows", v.tailEvents(live, file4).map((e) => e.t + (e.id ? `:${e.id}` : "")), ["tool:c3", "note", "assistant"]);
	const lines = v.liveLines(live, file4, { width: 70, now }).map(strip);
	const q = v.liveLines(live, file4, { width: 70, now, queued: [{ text: "go left", kind: "steer" }, { text: "then right " + "x".repeat(90), kind: "followUp" }] }).map(strip);
	t("live: sent and not yet taken, one line each, as pi labels them", [q.includes(" Steering: go left"), q.some((l) => l.startsWith(" Follow-up: then right") && W(l) <= 70)], [true, true]);
	t("live: the streaming text and the working line, in 70 columns", [lines.some((l) => /Found it/.test(l)), /● scout working · 30s · ↑1\.2k ↓340 · live/.test(lines.at(-1)), lines.every((l) => W(l) <= 70)], [true, true, true]);
	const done = { ...live, status: "done", ended: now, events: live.events.map((e) => ({ ...e, done: true })) };
	const full = v.loadedOf(entries([{ role: "user" }, { role: "assistant" }, { role: "toolResult", toolCallId: "c1" }, { role: "assistant" }, { role: "toolResult", toolCallId: "c2" }, { role: "toolResult", toolCallId: "c3" }, { role: "assistant" }]));
	t("live: a finished run whose file has it all draws nothing", v.liveLines(done, full, { width: 120, now }), []);
	const shown = new WeakSet(live.events.slice(0, 7));
	t("live: what is already in the chat is not drawn again", v.liveLines(live, file0, { width: 120, now, added: shown }).map(strip).filter((l) => /Task: look|hmm|first the sleep|calc\.py/.test(l)).length, 0);
}

// --- the transcript: pi's components when they load, else the plain lines
{
	const r = run({ id: "x", agent: "scout", status: "running", started: now });
	const evs = [ev({ t: "user", text: "Task: look" }), ev({ t: "assistant", done: false, blocks: [{ type: "thinking", text: "hmm" }, { type: "text", text: "Hello there" }] }), ev({ t: "tool", id: "c", name: "bash", args: { command: "ls" }, done: true, output: "a\nb", cut: 0 })];
	const tr = new v.Transcript(v.plainDeps(), { fg: (_c, s) => s }, {});
	const plain = tr.lines(evs, r, 60, { expanded: false, thinking: true });
	t("plain: task, thinking, text, the tool and its output", [plain.some((l) => /› Task: look/.test(l)), plain.some((l) => /hmm/.test(l)), plain.some((l) => /Hello there/.test(l)), plain.some((l) => /● bash ls/.test(l)), plain.some((l) => /^ {2}b$/.test(l))], [true, true, true, true, true]);
	const boom = { ...v.plainDeps(), pi: { UserMessageComponent: class { constructor() { throw new Error("no"); } }, AssistantMessageComponent: class {}, ToolExecutionComponent: class {}, tools: {} } };
	const tr2 = new v.Transcript(boom, { fg: (_c, s) => s }, {});
	t("pi's components failing: the plain lines take over", [tr2.lines(evs, r, 60, { expanded: false, thinking: true }).some((l) => /Hello there/.test(l)), tr2.piFailed], [true, true]);
	const fake = { ...v.plainDeps(), pi: {
		UserMessageComponent: class { constructor(text) { this.text = text; } render() { return [`USER ${this.text}`]; } },
		AssistantMessageComponent: class { updateContent(m, streaming) { this.m = m; this.s = streaming; } render() { return [`ASSISTANT ${this.m.content.map((c) => c.text ?? c.thinking).join("|")}${this.s ? " …" : ""}`]; } },
		ToolExecutionComponent: class { constructor(name, id, args) { this.name = name; this.args = args; } updateResult(res) { this.res = res; } render() { return [`TOOL ${this.name} ${this.args.command} -> ${this.res?.content?.[0]?.text ?? ""}`]; } },
		tools: {} } };
	const tr3 = new v.Transcript(fake, { fg: (_c, s) => s }, {});
	t("pi's components: each event drawn by them", tr3.lines(evs, r, 60, { expanded: false, thinking: true }), ["USER Task: look", "ASSISTANT hmm|Hello there …", "TOOL bash ls -> a\nb"]);
}

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
