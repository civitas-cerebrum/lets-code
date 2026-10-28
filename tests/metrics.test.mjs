#!/usr/bin/env node
// Unit test for the footer and metrics extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/footer.ts). Loads it with a fake pi, a
// fake clock and a fake setInterval stepped by hand, renders the footer
// through a fake TUI in both sizes, and drives session_start,
// before_provider_request, message_update, message_end, agent_end and
// /metrics, and checks the JSON lines of LETS_CODE_METRICS_LOG. Needs Node >= 22.6.
//
//   tests/metrics.test.mjs [path/to/lets-code/footer.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/footer.ts");
const work = mkdtempSync(join(tmpdir(), "metrics-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
process.env.PI_CODING_AGENT_DIR = work;          // no settings.json: compaction counts as on

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let clock = 0;
Date.now = () => clock;
let timers = [];
globalThis.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; };
globalThis.clearInterval = (h) => { timers = timers.filter((x) => x !== h); };
const step = () => timers.forEach((h) => h.fn());

const HOME = homedir();
let loads = 0;
async function load(env, { hasUI = true, theme, providers = 1, branch = "main", level = "medium", model } = {}) {
	timers = [];
	delete process.env.LETS_CODE_METRICS_ON; delete process.env.LETS_CODE_METRICS_LOG; delete process.env.LETS_CODE_SUBAGENT_DEPTH; delete process.env.LETS_CODE_METRICS_SAVE;
	Object.assign(process.env, env);
	const f = join(work, `metrics-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, status = new Map(), commands = {}, notes = [];
	const st = { footer: "pi", entries: [], context: { percent: 22.0, contextWindow: 262144 }, renders: 0, setFooterCalls: 0 };
	mod.default({ on(ev, h) { handlers[ev] = h; }, registerCommand(name, o) { commands[name] = o; }, getThinkingLevel: () => level });
	const tui = { requestRender() { st.renders++; } };
	const data = { getExtensionStatuses: () => status, getGitBranch: () => branch, getAvailableProviderCount: () => providers };
	const ctx = {
		hasUI, cwd: join(HOME, "github", "app"),
		ui: {
			setStatus(k, v) { if (v === undefined) status.delete(k); else status.set(k, v); },
			notify(m) { notes.push(m); }, theme,
			setFooter(fac) { st.setFooterCalls++; st.footer = fac ? fac(tui, theme ?? { fg: (_c, s) => s }, data) : "pi"; },
		},
		sessionManager: { getEntries: () => st.entries, getCwd: () => join(HOME, "github", "app"), getSessionName: () => undefined },
		getContextUsage: () => st.context,
		model: model ?? { id: "qwen3.8-27b", provider: "lets-code", reasoning: true, contextWindow: 262144 },
	};
	const cmd = (args) => commands.metrics.handler(args, ctx);
	const ev = (name, e = {}) => handlers[name]?.(e, ctx);
	const delta = (type, text) => ev("message_update", { type: "message_update", assistantMessageEvent: { type, delta: text } });
	const respond = ({ at, ttft, gen, output, text = "" }) => {
		clock = at; ev("before_provider_request");
		clock = at + ttft; delta("thinking_delta", text.slice(0, text.length / 2));
		clock = at + ttft + gen / 2; delta("text_delta", text.slice(text.length / 2));
		clock = at + ttft + gen;
		ev("message_end", { type: "message_end", message: { role: "assistant", usage: { output } } });
	};
	const foot = (w = 200) => (st.footer === "pi" ? "pi" : st.footer.render(w));
	return { mod, handlers, status, commands, notes, ev, delta, respond, cmd, st, foot };
}
const usage = (input, cacheRead, output, cost) => ({ type: "message", message: { role: "assistant", usage: { input, cacheRead, cacheWrite: 0, output, cost: { total: cost ?? 0 } } } });
const stats = (x) => x.foot().at(-1);              // the stats line (no other statuses in these checks)

try {
	let x = await load({});
	t("outside lets-code: nothing registered", [Object.keys(x.handlers), Object.keys(x.commands)], [[], []]);

	// ---------------------------------------------------------- minimal (default)
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("session_start");
	t("replaces pi's footer", typeof x.st.footer, "object");
	t("minimal: empty session", x.foot(), ["22.0%/262k (auto)"]);
	x.st.entries.push(usage(24000, 198000, 25000));
	x.respond({ at: 1000, ttft: 900, gen: 20000, output: 836 });
	t("minimal: one line: sent (cached included), received, speed, context", x.foot(), ["↑222k ↓25k · 41.8 tok/s · 22.0%/262k (auto)"]);
	t("no status line of its own", x.status.size, 0);
	clock = 60000; x.ev("before_provider_request");
	t("minimal: spinner while waiting", x.foot(), ["↑222k ↓25k · ⠋ 41.8 tok/s · 22.0%/262k (auto)"]);
	const r0 = x.st.renders;
	clock = 60300; x.delta("text_delta", "x".repeat(4000));
	clock = 62300; step();
	t("a frame redraws the footer", x.st.renders > r0, true);
	t("minimal: streaming, received counting up", x.foot(), ["↑222k ↓26k · ⠙ 83.5 tok/s · 22.0%/262k (auto)"]);
	x.ev("message_end", { message: { role: "assistant", usage: { output: 1000 } } });
	t("minimal: settles without a glyph", x.foot(), ["↑222k ↓25k · 83.5 tok/s · 22.0%/262k (auto)"]);
	t("interval cleared", timers.length, 0);

	// ---------------------------------------------------------- full, same style
	await x.cmd("");
	t("/metrics: still lets-code's footer", [typeof x.st.footer, x.st.setFooterCalls], ["object", 1]);
	t("full: directory, branch, model, level", x.foot()[0], `~/github/app (main)${" ".repeat(200 - 19 - 20)}qwen3.8-27b • medium`);
	t("full: two lines, the numbers on one", [x.foot().length, x.foot()[1]], [2, "↑222k ↓25k · 22.0%/262k (auto) · cache 198k (89%) · 83.5 tok/s · TTFT 0.3s · 1.0k out"]);
	clock = 70000; x.ev("before_provider_request");
	clock = 71200; step();
	t("full: waiting", x.foot()[1].endsWith(" · ⠙ 83.5 tok/s · TTFT 1.2s…"), true);
	clock = 71300; x.delta("thinking_delta", "y".repeat(400));
	clock = 72300; step();
	t("full: streaming, live output", x.foot().slice(1), ["↑222k ↓25k · 22.0%/262k (auto) · cache 198k (89%) · ⠹ 84.2 tok/s · TTFT 1.3s · 100 out"]);
	x.ev("agent_end");
	t("interrupt: spinner stopped, last finished response back", [timers.length, x.foot()[1].endsWith(" · 83.5 tok/s · TTFT 0.3s · 1.0k out")], [0, true]);
	await x.cmd("");
	t("/metrics again: minimal", x.foot(), ["↑222k ↓25k · 83.5 tok/s · 22.0%/262k (auto)"]);
	await x.cmd("on");
	t("/metrics on: full, two lines", x.foot().length, 2);
	t("full below the one-line width: three lines, as before", x.foot(x.mod.ONE_LINE_MIN - 1).length, 3);
	await x.cmd("off");
	t("/metrics off: minimal", x.foot().length, 1);
	await x.cmd("loud");
	t("/metrics bad argument warns", x.notes.at(-1), "usage: /metrics [on|off]");
	t("/metrics completes on|off", x.commands.metrics.getArgumentCompletions("o").map((c) => c.value), ["on", "off"]);
	t("no save file set: nothing written", existsSync(join(work, "lets-code-state.json")), false);

	// the size picked with /metrics is saved for the next launch, other keys kept
	{
		const st = join(work, "lets-code-state.json");
		writeFileSync(st, JSON.stringify({ thinkingLevels: { "lets-code/q": "low" } }));
		const y = await load({ LETS_CODE_METRICS_ON: "0", LETS_CODE_METRICS_SAVE: st });
		await y.cmd("");
		t("/metrics saves full", JSON.parse(readFileSync(st, "utf8")), { thinkingLevels: { "lets-code/q": "low" }, metrics: true });
		await y.cmd("off");
		t("/metrics off saves minimal", JSON.parse(readFileSync(st, "utf8")).metrics, false);
		writeFileSync(st, "not json");
		await y.cmd("on");
		t("unreadable file: started over", JSON.parse(readFileSync(st, "utf8")), { metrics: true });
		rmSync(st);
		const z = await load({ LETS_CODE_METRICS_ON: "0", LETS_CODE_METRICS_SAVE: st, LETS_CODE_SUBAGENT_DEPTH: "1" });
		await z.cmd("on");
		t("subagent: nothing saved", existsSync(st), false);
	}

	// METRICS=true starts full; cost, providers, thinking off, no branch, estimates
	x = await load({ LETS_CODE_METRICS_ON: "1" }, { providers: 2, branch: null, level: "off" });
	x.ev("session_start");
	x.st.entries.push(usage(500, 0, 300, 0.0123));
	t("full from the start: two lines, speed placeholder", [x.foot().length, x.foot()[1]], [2, "↑500 ↓300 · 22.0%/262k (auto) · $0.012 · – tok/s"]);
	t("full: no branch on the left", x.foot()[0].startsWith("~/github/app "), true);
	t("full: provider with several, thinking off, on the right", x.foot()[0].endsWith(" (lets-code) qwen3.8-27b • thinking off") && x.mod.width(x.foot()[0]) === 200, true);
	{
		// Claude through Claude Code: Anthropic's name and the bare model: (anthropic) haiku, not Anthropic / claude-haiku
		const c = await load({ LETS_CODE_METRICS_ON: "1" }, { providers: 2, model: { id: "claude-haiku", provider: "Anthropic", reasoning: true, contextWindow: 200000 } });
		c.ev("session_start");
		t("full: Claude reads (anthropic) haiku", c.foot()[0].endsWith(" (anthropic) haiku • medium"), true);
	}
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 0, text: "x".repeat(160) });
	t("full: cost; output estimated (~)", x.foot().slice(1), ["↑500 ↓300 · 22.0%/262k (auto) · $0.012 · 40.0 tok/s · TTFT 0.1s · ~40 out"]);
	clock = 5000; x.ev("before_provider_request");
	clock = 6000; x.ev("message_end", { message: { role: "assistant", usage: { output: 0 } } });
	t("full: nothing streamed", x.foot()[1].endsWith(" · 40.0 tok/s · TTFT 1.0s · ~0 out"), true);

	// learned characters per token: 90 tokens for 320 characters
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	x.ev("session_start");
	x.respond({ at: 0, ttft: 1000, gen: 2000, output: 90, text: "z".repeat(320) });
	clock = 10000; x.ev("before_provider_request");
	clock = 10500; x.delta("text_delta", "y".repeat(320));
	clock = 12500; step();
	t("live estimate uses the learned ratio", x.foot().slice(1), ["↓90 · 22.0%/262k (auto) · ⠙ 45.0 tok/s · TTFT 0.5s · 90 out"]);
	x.ev("agent_end");

	// numbers held for a second while streaming, the glyph keeps moving
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("session_start");
	clock = 0; x.ev("before_provider_request");
	clock = 100; x.delta("text_delta", "x".repeat(4000));
	clock = 1100; step();
	t("hold: fresh numbers", x.foot(), ["↓1.0k · ⠙ 1000.0 tok/s · 22.0%/262k (auto)"]);
	clock = 1600; step();
	t("hold: within a second, numbers wait, glyph moves", x.foot(), ["↓1.0k · ⠹ 1000.0 tok/s · 22.0%/262k (auto)"]);
	clock = 2200; step();
	t("hold: after a second, numbers move", x.foot(), ["↓1.0k · ⠸ 476.2 tok/s · 22.0%/262k (auto)"]);
	x.ev("agent_end");

	// full size: two fixed lines; a line too wide loses detail: cache shortens, then cost, cache drop; output, then TTFT drop
	const S0 = { sent: 4_700_000, received: 65_000, cached: 3_700_000, written: 0, hit: 0, cost: 1.5, tps: 53, glyph: "⠼", firstMs: 43200, out: 5, percent: 41, window: 262144, auto: true };
	const L = (w) => x.mod.statsLines(S0, true, undefined, w);
	t("wide: session and moment", L(100), ["↑4.7M ↓65k · 41.0%/262k (auto) · cache 3.7M (0%) · $1.500", "⠼ 53.0 tok/s · TTFT 43.2s · 5 out"]);
	t("narrower: cache shortens to its hit rate first", L(52), ["↑4.7M ↓65k · 41.0%/262k (auto) · cache 0% · $1.500", "⠼ 53.0 tok/s · TTFT 43.2s · 5 out"]);
	t("always two lines", [L(100).length, L(52).length, L(20).length], [2, 2, 2]);
	t("then the cost drops", L(45), ["↑4.7M ↓65k · 41.0%/262k (auto) · cache 0%", "⠼ 53.0 tok/s · TTFT 43.2s · 5 out"]);
	t("very narrow: cache and output drop", L(30), ["↑4.7M ↓65k · 41.0%/262k (auto)", "⠼ 53.0 tok/s · TTFT 43.2s"]);
	t("narrowest: context and speed stay", L(20).join(" | "), "↑4.7M ↓65k · 41.0%/262k (auto) | ⠼ 53.0 tok/s");
	const O = (w) => x.mod.statsLines({ ...S0, runMs: 85000, running: true }, true, undefined, w, true);
	t("one line, wide: everything", O(200), ["↑4.7M ↓65k · 41.0%/262k (auto) · cache 3.7M (0%) · $1.500 · ⠼ 53.0 tok/s · TTFT 43.2s · 5 out · working 1m 25s"]);
	t("one line, a phone's 82: detail drops, tokens, context, speed and clock stay", O(82), ["↑4.7M ↓65k · 41.0%/262k (auto) · cache 0% · ⠼ 53.0 tok/s · working 1m 25s"]);
	t("one line, 100: the TTFT comes back first", O(100), ["↑4.7M ↓65k · 41.0%/262k (auto) · cache 0% · $1.500 · ⠼ 53.0 tok/s · TTFT 43.2s · working 1m 25s"]);
	t("one line at its narrowest width: the shortest form fits", x.mod.width(O(x.mod.ONE_LINE_MIN)[0]) <= x.mod.ONE_LINE_MIN, true);
	const worst = { sent: 999_000_000, received: 999_000_000, cached: 0, written: 0, cost: 0, tps: 9999.9, glyph: "⠼", percent: 100, window: 1_000_000, auto: true, runMs: 59 * 60000 + 59000, stopped: true };
	t("the shortest form fits at its widest", x.mod.width(x.mod.statsLines(worst, true, undefined, x.mod.ONE_LINE_MIN, true)[0]) <= x.mod.ONE_LINE_MIN, true);
	t("statsLine stays one line", x.mod.statsLine(S0, false), "↑4.7M ↓65k · ⠼ 53.0 tok/s · 41.0%/262k (auto)");

	// colors: context warning/error, everything else dim; other statuses
	const th = { fg: (c, s) => `<${c}>${s}</${c}>` };
	x = await load({ LETS_CODE_METRICS_ON: "0" }, { theme: th });
	x.ev("session_start");
	x.st.context = { percent: 75.04, contextWindow: 262144 };
	t("over 70% in warning", x.foot(), ["<warning>75.0%/262k (auto)</warning>"]);
	x.st.context = { percent: 93.2, contextWindow: 262144 };
	t("over 90% in error", x.foot()[0], "<error>93.2%/262k (auto)</error>");
	x.st.context = { percent: null, contextWindow: 262144 };
	t("unknown after compaction", x.foot()[0], "<dim>?/262k (auto)</dim>");
	x.status.set("mandate", "mode: plan");
	t("the mode: dim, at the right of the numbers line", [x.foot().length, x.foot()[0].startsWith("<dim>?/262k (auto)</dim> "), x.foot()[0].endsWith(" <dim>mode: plan</dim>")], [1, true, true]);
	t("the mode: right-aligned to the width", x.mod.width(x.foot(80)[0]), 80);
	t("the mode: its own line, right-aligned, where it does not fit", [x.foot(40).length, x.foot(40)[1], x.mod.width(x.foot(40)[1])], [2, `${" ".repeat(40 - 21)}<dim>mode: plan</dim>`, 40]);
	{
		const f = await load({ LETS_CODE_METRICS_ON: "1" }, { theme: th }); f.ev("session_start"); f.status.set("mandate", "mode: orchestrator");
		t("full: the mode's name before the model, on the top line; two lines", [f.foot().length, f.foot()[0].endsWith("<dim>orchestrator</dim><dim> · </dim><dim>qwen3.8-27b • medium</dim>"), f.foot()[1].includes("orchestrator")], [2, true, false]);
		f.status.set("mandate", "mode: auto");
		t("full: the default mode is not shown", [f.foot().length, f.foot().join("\n").includes("auto</dim><dim> · ")], [2, false]);
		const g = await load({ LETS_CODE_METRICS_ON: "1" }); g.ev("session_start"); g.status.set("mandate", "mode: orchestrator");
		t("full, a phone's width: still two lines, the mode by the model", [g.foot(82).length, g.foot(82)[0].endsWith("orchestrator · qwen3.8-27b • medium"), g.mod.width(g.foot(82)[0])], [2, true, 82]);
	}
	x.status.set("factory", "- intake: 1 criteria"); x.status.set("sandbox", "\x1b[33msandbox: off\x1b[0m");
	t("other statuses: their own line, dim unless colored", x.foot()[1], "<dim>- intake: 1 criteria</dim> \x1b[33msandbox: off\x1b[0m");
	x.status.delete("factory"); x.status.delete("sandbox");
	t("cut to width", x.foot(5).every((l) => x.mod.width(l) <= 5), true);

	// the prompt's clock: agent_start to agent_settled, live once a second (full size only)
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	x.ev("session_start");
	clock = 0; x.ev("agent_start");
	t("run: counts while working", x.foot()[1].endsWith("working 0s"), true);
	clock = 42000; step();
	t("run: live", x.foot()[1].endsWith("working 42s"), true);
	x.respond({ at: 43000, ttft: 500, gen: 2000, output: 100 });
	x.ev("agent_start");                                   // pi continuing on its own: same prompt
	clock = 83000; x.ev("agent_settled");
	t("run: done once pi settles", x.foot()[1].endsWith("done in 1m 23s"), true);
	t("run: interval cleared", timers.length, 0);
	clock = 100000; x.ev("agent_start"); clock = 137000;
	x.ev("message_end", { message: { role: "assistant", stopReason: "aborted", usage: { output: 0 } } });
	x.ev("agent_settled");
	t("run: interrupted", x.foot()[1].endsWith("stopped after 37s"), true);
	await x.cmd("off");
	t("run: not in the minimal footer", /working|done in|stopped after/.test(x.foot().join(" ")), false);
	t("duration", [5000, 83000, 3720000].map(x.mod.duration), ["5s", "1m 23s", "1h 2m"]);

	// no UI
	x = await load({ LETS_CODE_METRICS_ON: "0" }, { hasUI: false });
	x.ev("session_start");
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
	t("no UI: footer untouched, no spinner", [x.st.footer, timers.length], ["pi", 0]);

	// ---------------------------------------------------------- metrics log (JSON lines)
	const logf = join(work, "log", "sub", "metrics.jsonl");        // parent directories created
	const readLog = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	const ts = (ms) => new Date(ms).toISOString();
	const pid = process.pid;
	x = await load({ LETS_CODE_METRICS_ON: "0", LETS_CODE_METRICS_LOG: logf });
	clock = 0; x.ev("session_start");
	t("log: session record", readLog(logf), [{ type: "session", ts: ts(0), model: "qwen3.8-27b", provider: "lets-code", context_window: 262144, thinking_level: "medium", depth: 0, pid }]);
	clock = 1000; x.ev("agent_start"); x.ev("before_provider_request");
	clock = 1500; x.delta("text_delta", "x".repeat(400));
	clock = 3500; x.ev("message_end", { message: { role: "assistant", stopReason: "toolUse", usage: { input: 2000, cacheRead: 8000, cacheWrite: 0, output: 100 },
		content: [{ type: "text", text: "hi" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } },
			{ type: "toolCall", name: "subagent", arguments: { tasks: [{}, {}, {}] } }, { type: "toolCall", name: "subagent", arguments: { chain: [{}, {}] } },
			{ type: "toolCall", name: "subagent", arguments: { agent: "scout", task: "look" } }] } });
	x.ev("message_end", { message: { role: "toolResult", content: [] } });       // not a response
	clock = 4000; x.ev("before_provider_request");
	clock = 4200; x.delta("text_delta", "y".repeat(200));
	clock = 5200; x.ev("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 100, cacheRead: 10000, output: 50 }, content: [{ type: "text", text: "done" }] } });
	x.ev("agent_start");                                   // pi continuing on its own: same prompt
	clock = 5300; x.ev("agent_settled");
	t("log: request, prompt records", readLog(logf).slice(1), [
		{ type: "request", ts: ts(3500), ttft_ms: 500, gen_ms: 2000, output_tokens: 100, input_tokens: 10000, cached_tokens: 8000, cache_hit_pct: 80, tok_s: 50, estimated: false, thinking_level: "medium", stop_reason: "toolUse", depth: 0, pid },
		{ type: "request", ts: ts(5200), ttft_ms: 200, gen_ms: 1000, output_tokens: 50, input_tokens: 10100, cached_tokens: 10000, cache_hit_pct: 99, tok_s: 50, estimated: false, thinking_level: "medium", stop_reason: "stop", depth: 0, pid },
		{ type: "prompt", ts: ts(5300), duration_ms: 4300, requests: 2, tool_calls: 4, subagent_calls: 3, subagent_tasks: 6, outcome: "completed", depth: 0, pid },
	]);
	clock = 6000; x.ev("agent_start"); x.ev("before_provider_request");
	clock = 7000; x.ev("message_end", { message: { role: "assistant", stopReason: "aborted", usage: { output: 0 }, content: [] } });
	clock = 7100; x.ev("agent_settled");
	t("log: interrupted prompt, nothing streamed", readLog(logf).slice(4), [
		{ type: "request", ts: ts(7000), ttft_ms: 1000, gen_ms: 0, output_tokens: 0, input_tokens: 0, cached_tokens: 0, cache_hit_pct: null, tok_s: null, estimated: true, thinking_level: "medium", stop_reason: "aborted", depth: 0, pid },
		{ type: "prompt", ts: ts(7100), duration_ms: 1100, requests: 1, tool_calls: 0, subagent_calls: 0, subagent_tasks: 0, outcome: "interrupted", depth: 0, pid },
	]);
	clock = 8000; x.ev("session_shutdown", { type: "session_shutdown", reason: "quit" });
	t("log: session_end totals", readLog(logf).slice(6), [{ type: "session_end", ts: ts(8000), reason: "quit", duration_ms: 8000, prompts: 2, requests: 3, tool_calls: 4,
		subagent_calls: 3, subagent_tasks: 6, input_tokens: 20100, output_tokens: 150, cached_tokens: 18000, depth: 0, pid }]);
	t("log: the footer still works alongside", stats(x), "50.0 tok/s · 22.0%/262k (auto)");
	t("outcome from the stop reason", ["stop", "toolUse", "aborted", "error", ""].map(x.mod.outcome), ["completed", "completed", "interrupted", "error", "completed"]);

	// shutdown in the middle of a prompt: the prompt is logged as interrupted
	const logc = join(work, "cut.jsonl");
	x = await load({ LETS_CODE_METRICS_ON: "0", LETS_CODE_METRICS_LOG: logc });
	clock = 0; x.ev("session_start"); x.ev("agent_start"); x.ev("before_provider_request");
	clock = 2000; x.ev("session_shutdown", { reason: "quit" });
	t("log: shutdown mid-prompt", readLog(logc).slice(1).map((r) => [r.type, r.outcome ?? r.prompts, r.duration_ms]), [["prompt", "interrupted", 2000], ["session_end", 1, 2000]]);

	// no UI (print mode, --mode json), as a subagent: measured and logged, nothing drawn
	const log2 = join(work, "noui.jsonl");
	x = await load({ LETS_CODE_METRICS_ON: "0", LETS_CODE_METRICS_LOG: log2, LETS_CODE_SUBAGENT_DEPTH: "2" }, { hasUI: false });
	clock = 0; x.ev("session_start"); x.ev("agent_start");
	x.respond({ at: 100, ttft: 400, gen: 1000, output: 80 });
	clock = 2000; x.ev("agent_settled");
	const r2 = readLog(log2);
	t("no UI: session, request, prompt logged", r2.map((r) => r.type), ["session", "request", "prompt"]);
	t("no UI: numbers measured", [r2[1].ttft_ms, r2[1].gen_ms, r2[1].tok_s, r2[2].duration_ms, r2[2].requests], [400, 1000, 80, 2000, 1]);
	t("subagent: its depth in every record", r2.map((r) => r.depth), [2, 2, 2]);
	t("no UI: footer untouched, no timers", [x.st.footer, timers.length], ["pi", 0]);

	// unset: nothing written
	const before = readdirSync(work).filter((f) => !f.endsWith(".ts")).sort();
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	clock = 0; x.ev("session_start"); x.ev("agent_start");
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
	x.ev("agent_settled"); x.ev("session_shutdown", { reason: "quit" });
	t("log unset: nothing written", readdirSync(work).filter((f) => !f.endsWith(".ts")).sort(), before);

	// unwritable: never throws, the footer keeps working
	writeFileSync(join(work, "a-file"), "");
	let threw = false;
	try {
		x = await load({ LETS_CODE_METRICS_ON: "0", LETS_CODE_METRICS_LOG: join(work, "a-file", "metrics.jsonl") });
		clock = 0; x.ev("session_start"); x.ev("agent_start");
		x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
		x.ev("agent_settled"); x.ev("session_shutdown", { reason: "quit" });
	} catch (e) { threw = String(e); }
	t("log unwritable: no throw", threw, false);
	t("log unwritable: footer still drawn", stats(x), "50.0 tok/s · 22.0%/262k (auto)");
	t("appendRecord reports failure", x.mod.appendRecord(join(work, "a-file", "x"), { a: 1 }), false);

	// a subagent's session on screen (/subagents): the footer is that session's
	{
		const REG = Symbol.for("lets-code.subagent-runs");
		x = await load({ LETS_CODE_METRICS_ON: "0" });
		clock = 0; x.ev("session_start");
		x.st.entries.push(usage(1000, 0, 500));
		const run = { id: "r1", agent: "scout", status: "done", started: 0, ended: 83000, input: 10, output: 5,
			stats: { input: 2000, output: 3000, cacheRead: 8000, cacheWrite: 0, cost: 0, hit: 80, contextUsage: { tokens: 13000, contextWindow: 131072, percent: 9.9 },
				model: "child-model", provider: "lets-code", reasoning: true, thinkingLevel: "low", tokPerSec: 55.5, ttftMs: 1200, lastOut: 400 } };
		globalThis[REG] = { runs: [run], view: { viewing: "r1" } };
		t("viewing a subagent, minimal: its name and level first, then its numbers", x.foot(), ["scout • low · ↑10k ↓3.0k · 55.5 tok/s · 9.9%/131k (auto)"]);
		await x.cmd("on");
		const full = x.foot();
		t("viewing a subagent, full: its name after the directory, its model and level", [full[0].startsWith("~/github/app (main) • scout "), full[0].endsWith("child-model • low")], [true, true]);
		t("viewing a subagent, full: its totals, cache, speed, TTFT and clock", full[1], "↑10k ↓3.0k · 9.9%/131k (auto) · cache 8.0k (80%) · 55.5 tok/s · TTFT 1.2s · 400 out · done in 1m 23s");
		run.stats.thinkingLevel = "high";
		t("the child's level changes: the footer shows it", x.foot()[0].endsWith("child-model • high"), true);
		const old = { id: "r2", agent: "worker", status: "running", started: 0, input: 700, output: 90, live: 10 };
		globalThis[REG].runs.push(old); globalThis[REG].view.viewing = "r2"; clock = 5000;
		t("a run without stats (an older one): its own counts", x.foot()[1].startsWith("↑700 ↓100 · ?/0"), true);
		globalThis[REG].view.viewing = undefined;
		const back = x.foot();
		t("back in the main session: its model, level and numbers", [back[0].endsWith("qwen3.8-27b • medium"), /scout|worker/.test(back.join(" ")), back[1].startsWith("↑1.0k ↓500")], [true, false, true]);
		await x.cmd("off");
		t("back in the main session, minimal: no name", /scout|worker/.test(x.foot().join(" ")), false);
		delete globalThis[REG];
	}

	// helpers
	t("compact like pi", [999, 1234, 45200, 1_234_567, 15_000_000].map(x.mod.compact), ["999", "1.2k", "45k", "1.2M", "15M"]);
	t("tilde", [x.mod.tilde(join(HOME, "a/b"), HOME), x.mod.tilde(HOME, HOME), x.mod.tilde("/etc", HOME)], ["~/a/b", "~", "/etc"]);
	t("spread drops the right side when narrow", x.mod.spread("left", "right", 8), "left");
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
