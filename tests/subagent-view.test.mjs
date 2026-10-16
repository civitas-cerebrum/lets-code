#!/usr/bin/env node
// Unit test for the /subagents view lets-code writes next to the subagents
// module (~/.pi/agent/extensions/lets-code/subagent-view.ts): the list's
// order and layout at phone (70) and wide (120) widths, the run screen's
// header and transcript, and the keys, with a fake TUI and the plain
// helpers (no pi, no terminal). Needs Node >= 22.6.
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
	run({ id: "b", agent: "reviewer", task: "Review the parser change for missed edge cases", status: "running", started: now - 20_000, parent: { tool: "subagent", callId: "call_0123456789abcdef", mode: "parallel", index: 1, of: 2 } }),
	run({ id: "c", agent: "scout", task: "Find where the CLI flags are parsed", status: "running", started: now - 25_000, parent: { tool: "subagent", callId: "call_0123456789abcdef", mode: "parallel", index: 0, of: 2 } }),
	run({ id: "d", agent: "termux-device", kind: "expert", task: "Brief for the termux-device expert.\n\n## Goal\nopen the PDF in Files", status: "failed", exitCode: 3, started: now - 300_000, ended: now - 290_000 }),
	run({ id: "e", agent: "worker", task: "Add the --dry-run flag", status: "aborted", started: now - 60_000, ended: now - 10_000 }),
];

// --- formatting and order
t("elapsed", [v.elapsed(5_400), v.elapsed(63_000), v.elapsed(3_723_000)], ["5s", "1m 03s", "1h 02m"]);
t("compact", [v.compact(999), v.compact(1234), v.compact(45_600), v.compact(2_300_000)], ["999", "1.2k", "46k", "2.3M"]);
t("order: running first (as they started), then finished newest first", v.order(runs).map((r) => r.id), ["c", "b", "e", "a", "d"]);
t("summary: an expert brief loses its preamble and headings", v.summary(runs[3].task), "open the PDF in Files");
t("status labels", runs.map(v.statusLabel), ["done", "running", "running", "failed (exit 3)", "stopped"]);

// --- the list at 120 and 70 columns
for (const width of [120, 70]) {
	const lines = v.listLines(runs, { width, now, selected: "b" });
	t(`list ${width}: every line fits`, lines.every((l) => W(l) <= width), true);
	const rows = lines.filter((l) => /[●✓✗■]/.test(l)).map(strip);
	t(`list ${width}: one row per run, running first`, rows.map((l) => l.replace(/^. . /, "").split(/\s+/)[0]), ["scout", "reviewer", "worker", "scout", "termux-device"]);
	t(`list ${width}: the selected row has the cursor`, rows[1].startsWith("❯ ● reviewer"), true);
	t(`list ${width}: elapsed and tokens right-aligned in one column`, new Set(rows.map((l) => W(l))).size, 1);
	t(`list ${width}: elapsed of a running run counts to now`, /25s/.test(rows[0]), true);
	t(`list ${width}: tokens`, /1\.5k$/.test(rows[0]), true);
	t(`list ${width}: title counts`, strip(lines[0]), "Subagents  2 running · 3 finished");
}
{
	const wide = v.listLines(runs, { width: 120, now }).map(strip).find((l) => /Map the config/.test(l));
	const narrow = v.listLines(runs, { width: 70, now }).map(strip).find((l) => /Map the config/.test(l));
	t("list 120: the whole task fits", /report the files/.test(wide), true);
	t("list 70: the task is cut with an ellipsis", /…/.test(narrow) && !/report the files/.test(narrow), true);
	const tiny = v.listLines(runs, { width: 40, now }).map(strip);
	t("list 40: two lines per run (name and time, then the task)", tiny.some((l) => /^ {4}Map the config/.test(l)) && tiny.some((l) => /^  ✓ scout  1m 00s · 1\.5k$/.test(l)), true);
	t("list 40: every line fits", tiny.every((l) => W(l) <= 40), true);
	t("empty list says so", v.listLines([], { width: 70, now }).map(strip).some((l) => /No subagent or expert runs/.test(l)), true);
}

// --- header and transcript
{
	const h = v.headerLines(runs[1], { width: 70, now, index: 1, count: 5 }).map(strip);
	t("header: agent, status, elapsed, tokens; position on the right", [/^● reviewer  running  20s · ↑1\.2k ↓340/.test(h[0]), h[0].endsWith("2/5"), W(h[0])], [true, true, 70]);
	t("header: the parent tool call and the task's place in it", h[1], "subagent call …89abcdef · task 2/2 · 1 turn");
	const e = v.headerLines(runs[3], { width: 120, now, index: 4, count: 5 }).map(strip);
	t("header: an expert is marked", /^✗ termux-device expert  failed \(exit 3\)/.test(e[0]), true);
	const narrow = v.headerLines({ ...runs[1], agent: "a-very-long-agent-name-indeed" }, { width: 30, now, index: 0, count: 1 });
	t("header: fits a narrow terminal", narrow.every((l) => W(l) <= 30), true);
}
{
	const flags = { expanded: false, thinking: true };
	const out = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
	const bash = v.plainEvent(ev({ t: "tool", id: "1", name: "bash", args: { command: "npm test" }, done: true, output: out, cut: 0 }), 70, flags).map(strip);
	t("tool: title with the command", bash[0], "● bash npm test");
	t("bash collapsed: the last lines, how many are hidden", [bash[1], bash[bash.length - 1]], ["  … 34 earlier lines (o expands)", "  line 40"]);
	const read = v.plainEvent(ev({ t: "tool", id: "2", name: "read", args: { path: "src/a.ts" }, done: true, output: out, cut: 0 }), 70, flags).map(strip);
	t("read collapsed: the first lines", [read[0], read[1], read[read.length - 1]], ["● read src/a.ts", "  line 1", "  … 34 more lines (o expands)"]);
	t("expanded: everything", v.plainEvent(ev({ t: "tool", id: "1", name: "bash", args: { command: "x" }, done: true, output: out, cut: 0 }), 70, { ...flags, expanded: true }).length, 41);
	t("running tool without output", v.plainEvent(ev({ t: "tool", id: "3", name: "grep", args: { pattern: "TODO", path: "src" }, done: false, output: "", cut: 0 }), 70, flags).map(strip), ["● grep TODO in src", "  running…"]);
	const long = v.plainEvent(ev({ t: "tool", id: "4", name: "bash", args: { command: "x".repeat(200) }, done: true, output: "y".repeat(300), cut: 0 }), 70, flags);
	t("long command and output lines are cut to the width", long.every((l) => W(l) <= 70), true);
	const a = ev({ t: "assistant", done: true, blocks: [{ type: "thinking", text: "I should look at the parser first." }, { type: "text", text: "The parser drops trailing commas. " + "word ".repeat(30) }] });
	const shown = v.plainEvent(a, 70, flags).map(strip);
	t("thinking shown (dimmed), then the text, wrapped", [shown[0], shown.slice(1).every((l) => W(l) <= 70), shown.length > 2], ["  I should look at the parser first.", true, true]);
	t("thinking hidden: one line", v.plainEvent(a, 70, { ...flags, thinking: false }).map(strip)[0], "  Thinking… (t shows it)");
	t("assistant error", v.plainEvent(ev({ t: "assistant", done: true, blocks: [], error: "500 upstream" }), 70, flags).map(strip), ["  Error: 500 upstream"]);
	t("user task", v.plainEvent(ev({ t: "user", text: "Find the bug" }), 70, flags).map(strip), ["› Find the bug"]);
	const end = v.endLines(runs[0], 70, now).map(strip)[0];
	t("end line: how it finished, centred", [/done after 1m 00s · 1 turn · ↑1\.2k ↓340/.test(end), W(end) <= 70, end.startsWith("─")], [true, true, true]);
	t("no end line while running", v.endLines(runs[1], 70, now), []);
	const tr = new v.Transcript(v.plainDeps(), { fg: (_c, s) => s }, {});
	const r = run({ id: "x", agent: "scout", status: "done", started: now - 1000, ended: now, dropped: 3, events: [ev({ t: "user", text: "task" }), a] });
	const ls = tr.lines(r, 70, flags, now);
	t("transcript: dropped events are noted after the task", ls.some((l) => /3 earlier events not kept/.test(l)), true);
	t("transcript: cached per version", tr.lines(r, 70, flags, now)[2] === ls[2] && tr.cache.size === 2, true);
}

// --- the view: keys, scrolling, live updates (fake TUI, plain keys)
function harness(width, rows = 20, start) {
	const reg = { runs: runs.map((r) => ({ ...r, events: [...r.events] })), listeners: new Set() };
	const renders = { n: 0 }; let closed = 0; const stops = [];
	const tui = { requestRender: () => { renders.n++; }, terminal: { rows } };
	const view = v.createView({ tui, theme: { fg: (_c, s) => s }, deps: v.plainDeps(), registry: reg, start, key: "alt+s", stop: (id) => stops.push(id), done: () => { closed++; } });
	return { view, reg, renders, stops, closed: () => closed, draw: () => view.render(width).map(strip) };
}
const K = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", tab: "\t", stab: "\x1b[Z", pgup: "\x1b[5~", pgdn: "\x1b[6~", end: "\x1b[F", home: "\x1b[H", alts: "\x1bs" };
for (const width of [70, 120]) {
	const h = harness(width);
	let lines = h.draw();
	t(`view ${width}: opens on the list, the first run selected`, [lines[0].startsWith("Subagents"), lines.some((l) => l.startsWith("❯ ● scout"))], [true, true]);
	t(`view ${width}: exactly the terminal's rows, each within the width`, [lines.length, h.view.render(width).every((l) => W(l) <= width)], [20, true]);
	h.view.handleInput(K.down);
	t(`view ${width}: down moves the cursor`, h.draw().some((l) => l.startsWith("❯ ● reviewer")), true);
	h.view.handleInput(K.enter);
	lines = h.draw();
	t(`view ${width}: enter opens the run`, [h.view.screen, /^● reviewer  running/.test(lines[0]), lines[1].startsWith("subagent call")], ["run", true, true]);
	t(`view ${width}: key hints at the bottom, within the width`, [/esc back/.test(lines[19]), W(lines[19]) <= width], [true, true]);
	h.view.handleInput(K.tab); t(`view ${width}: tab -> next run`, h.view.current().id, "e");
	h.view.handleInput(K.right); t(`view ${width}: right -> next run`, h.view.current().id, "a");
	h.view.handleInput(K.left); h.view.handleInput(K.stab); t(`view ${width}: left and shift+tab -> previous`, h.view.current().id, "b");
	h.view.handleInput(K.alts); t(`view ${width}: the shortcut moves on too`, h.view.current().id, "e");
	h.view.handleInput("l"); t(`view ${width}: l -> the list, same run selected`, [h.view.screen, h.draw().some((l) => l.startsWith("❯ ■ worker"))], ["list", true]);
	h.view.handleInput(K.esc); t(`view ${width}: esc closes`, h.closed(), 1);
	t(`view ${width}: closing unsubscribes`, h.reg.listeners.size, 0);
}
{
	// a long, still-running transcript: follows the end, stops following when scrolled up
	const h = harness(70, 12, { screen: "run", id: "b" });
	const r = h.reg.runs.find((x) => x.id === "b");
	for (let i = 0; i < 30; i++) r.events.push(ev({ t: "tool", id: `t${i}`, name: "bash", args: { command: `step ${i}` }, done: true, output: `out ${i}`, cut: 0, v: 1 }));
	let lines = h.draw();
	t("run: opened directly by id", h.view.current().id, "b");
	t("run: follows the end", lines.some((l) => /step 29/.test(l)), true);
	h.view.handleInput(K.pgup);
	lines = h.draw();
	t("pgup: scrolled up, no longer at the end", [h.view.follow, lines.some((l) => /step 29/.test(l)), /more · end follows/.test(lines[11])], [false, false, true]);
	r.events.push(ev({ t: "tool", id: "new", name: "bash", args: { command: "step 30" }, done: true, output: "", cut: 0 }));
	h.reg.listeners.forEach((l) => l(r));
	t("a new event repaints", h.renders.n > 0, true);
	t("scrolled up: stays put when the run grows", h.draw().some((l) => /step 30/.test(l)), false);
	h.view.handleInput(K.end);
	t("end: follows again", [h.view.follow, h.draw().some((l) => /step 30/.test(l))], [true, true]);
	h.view.handleInput(K.home); t("home: the top (the task)", h.draw()[3].startsWith("›"), true);
	h.view.handleInput(K.pgdn); h.view.handleInput(K.down); t("pgdn/down scroll", h.view.top > 0, true);
	h.view.handleInput("x");
	t("x on a running run asks first", [h.view.confirm, /Stop reviewer\? y stops it/.test(h.draw()[11])], [true, true]);
	h.view.handleInput("n"); t("any other key keeps it running", [h.view.confirm, h.stops], [false, []]);
	h.view.handleInput("x"); h.view.handleInput("y"); t("x then y stops that child", h.stops, ["b"]);
	h.view.handleInput(K.tab); h.view.handleInput("x"); t("x on a finished run does nothing", h.view.confirm, false);
	h.view.handleInput("t"); t("t toggles thinking", h.view.flags.thinking, false);
	h.view.handleInput("o"); t("o toggles tool output", h.view.flags.expanded, true);
	t("the run screen fits 70 columns", h.view.render(70).every((l) => W(l) <= 70), true);
	h.view.handleInput("q"); t("q closes", h.closed(), 1);
}
{
	// resize: the same view reflows to the new width
	const h = harness(120, 16, { screen: "run", id: "a" });
	const wide = h.view.render(120), narrow = h.view.render(70);
	t("reflow on resize", [wide.every((l) => W(l) <= 120), narrow.every((l) => W(l) <= 70), wide.length, narrow.length], [true, true, 16, 16]);
	h.view.dispose();
}
{
	// keys the plain parser knows (pi's own matchesKey replaces it inside pi)
	const m = v.plainMatchesKey;
	t("plain keys", [m("\x1b", "escape"), m("\x1b[A", "up"), m("\x1bOA", "up"), m("\x1b[Z", "shift+tab"), m("\x1bs", "alt+s"), m("\x03", "ctrl+c"), m("q", "q"), m("\x1b[5~", "pageUp"), m("x", "q")], [true, true, true, true, true, true, true, true, false]);
	t("plain truncate keeps the width", [v.plainWidth(v.plainTruncate("\x1b[2mhello world\x1b[0m", 6)), strip(v.plainTruncate("hello world", 6))], [6, "hello…"]);
	t("plain wrap", v.plainWrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
	t("plain wrap breaks long words", v.plainWrap("x".repeat(10), 4), ["xxxx", "xxxx", "xx"]);
}

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
