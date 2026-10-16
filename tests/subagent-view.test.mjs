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

// --- the footer list (/subagents toggle)
{
	t("footer: nothing without runs", v.footerLines([], { width: 120, now }), []);
	const six = [...runs, run({ id: "f", agent: "worker", task: "Write the tests", status: "done", started: now - 400_000, ended: now - 399_000 })];
	const wide = v.footerLines(six, { width: 120, now, current: "b" }).map(strip);
	t("footer: at most FOOTER_ROWS lines, the last says how many more", [wide.length, /… 2 more · \/subagents/.test(wide.at(-1))], [v.FOOTER_ROWS, true]);
	t("footer: running first, each with its mark and name", wide.slice(0, 4).map((l) => l.slice(1, 3) + l.slice(3).trim().split(/\s+/)[0]), ["● scout", "● reviewer", "■ worker", "✓ scout"]);
	t("footer wide: the task, the elapsed time and ↑in ↓out", [/Find where the CLI flags/.test(wide[0]), /25s/.test(wide[0]), /↑1\.2k ↓340/.test(wide[0])], [true, true, true]);
	t("footer: the open session's run is marked", [wide[1].startsWith("▸"), wide[0].startsWith(" ")], [true, true]);
	const mid = v.footerLines(runs, { width: 90, now }).map(strip);
	t("footer under 100 columns: no task, the clock and tokens stay", [/Find where/.test(mid[0]), /25s/.test(mid[0]), /↑1\.2k ↓340/.test(mid[0])], [false, true, true]);
	const phone = v.footerLines(runs, { width: 70, now }).map(strip);
	t("footer at 70 columns: one total for the tokens", [/25s · 1\.5k$/.test(phone[0].trimEnd()), phone.every((l) => W(l) <= 70)], [true, true]);
	t("footer: every line fits, at any width", [40, 70, 90, 120].every((w) => v.footerLines(runs, { width: w, now }).every((l) => W(l) <= w)), true);
	t("footer: no more lines than runs when they fit", [v.footerLines(runs.slice(0, 2), { width: 120, now }).length, v.footerLines(runs, { width: 120, now }).length], [2, 5]);
}

// --- the picker
{
	const rows = v.pickerRows(runs);
	t("picker rows: the main session, then the runs in order", rows.map((r) => r.id ?? r.kind), ["main", "c", "b", "e", "a", "d"]);
	for (const width of [70, 120]) {
		const lines = v.pickerLines(runs, { width, now, selected: 1, current: "main" }).map(strip);
		t(`picker ${width}: title counts, every line fits`, [/^Subagents {2}2 running · 3 finished/.test(lines[0]), lines.every((l) => W(l) <= width)], [true, true]);
		t(`picker ${width}: the main row says it is here, the cursor on the first run`, [/◯ main\s+\(here\) the main session/.test(lines[1]), lines[2].startsWith("❯ ● scout")], [true, true]);
		t(`picker ${width}: the keys, x only for a running run`, [/enter switch · x stop/.test(lines.at(-1)), /x stop/.test(v.pickerLines(runs, { width, now, selected: 3 }).map(strip).at(-1))], [true, false]);
	}
	const wide = v.pickerLines(runs, { width: 120, now, selected: 1 }).map(strip), phone = v.pickerLines(runs, { width: 70, now, selected: 1 }).map(strip);
	t("picker: wide rows split the tokens, narrow ones give a total", [/↑1\.2k ↓340/.test(wide[2]), /1\.5k$/.test(phone[2])], [true, true]);
	t("picker: the run whose session is open says here", /\(here\) Review the parser/.test(v.pickerLines(runs, { width: 120, now, selected: 0, current: "b" }).map(strip)[3]), true);
	t("picker: the stop asks first", /Stop scout\? x again stops it/.test(strip(v.pickerLines(runs, { width: 70, now, selected: 1, confirm: true }).at(-1))), true);
	const many = Array.from({ length: 14 }, (_, i) => run({ id: `m${i}`, agent: `w${i}`, task: `job ${i}`, status: "done", started: now - 1000 * i, ended: now - 500 * i }));
	const sel = v.pickerLines(many, { width: 70, now, selected: 12 }).map(strip);
	t("picker: a window around the selection when there are many", [sel.length <= v.PICKER_ROWS + 3, sel.some((l) => l.startsWith("❯")), sel.some((l) => /↑ \d+ more/.test(l))], [true, true, true]);
}
{
	const reg = { runs: runs.map((r) => ({ ...r })), listeners: new Set() };
	let renders = 0, result = "none"; const stopped = [];
	const tui = { requestRender: () => { renders++; } };
	const p = new v.Picker({ tui, theme: { fg: (_c, s) => s }, deps: v.plainDeps(), registry: reg, current: "main", key: "alt+s", stop: (id) => stopped.push(id), done: (row) => { result = row; } });
	t("picker: starts on the first run in the main session", p.selected, 1);
	t("picker: listens to the runs while open", reg.listeners.size, 1);
	p.handleInput("\x1b[B"); p.handleInput("\x1b[B");
	t("picker: down moves", p.selected, 3);
	p.handleInput("\x1b[A");
	t("picker: up moves", p.selected, 2);
	p.handleInput("x");
	t("picker: x asks first", [p.confirm, stopped], [true, []]);
	p.handleInput("n");
	t("picker: any other key keeps it running", [p.confirm, stopped], [false, []]);
	p.handleInput("x"); p.handleInput("x");
	t("picker: x twice stops the selected running run", stopped, ["b"]);
	p.handleInput("\r");
	t("picker: enter returns the row and closes", [result, reg.listeners.size], [{ kind: "run", id: "b" }, 0]);
	const p2 = new v.Picker({ tui, theme: { fg: (_c, s) => s }, deps: v.plainDeps(), registry: reg, current: "c", key: "alt+s", done: (row) => { result = row; } });
	t("picker in a run's session: starts on the main row", p2.selected, 0);
	p2.handleInput("\x1bs");
	t("picker: the shortcut closes it with nothing picked", result, undefined);
	const p3 = new v.Picker({ tui, theme: { fg: (_c, s) => s }, deps: v.plainDeps(), registry: reg, current: "main", done: (row) => { result = row; } });
	p3.handleInput("\x1b");
	t("picker: esc closes it", result, undefined);
	t("picker: the line count stays small", p3.render(70).length <= v.PICKER_ROWS + 3, true);
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
