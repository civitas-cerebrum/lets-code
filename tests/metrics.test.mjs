#!/usr/bin/env node
// Unit test for the footer and metrics extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-metrics.ts). Loads it with a fake pi, a
// fake clock and a fake setInterval stepped by hand, renders the footer
// through a fake TUI in both sizes, and drives session_start,
// before_provider_request, message_update, message_end, agent_end and
// /metrics. Needs Node >= 22.6.
//
//   tests/metrics.test.mjs [path/to/lets-code-metrics.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-metrics.ts");
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
async function load(env, { hasUI = true, theme, providers = 1, branch = "main", level = "medium" } = {}) {
	timers = [];
	delete process.env.LETS_CODE_METRICS_ON;
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
		model: { id: "qwen3.8-27b", provider: "lets-code", reasoning: true, contextWindow: 262144 },
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
	t("minimal: spinner while waiting", x.foot(), ["↑222k ↓25k · · 41.8 tok/s · 22.0%/262k (auto)"]);
	const r0 = x.st.renders;
	clock = 60300; x.delta("text_delta", "x".repeat(4000));
	clock = 62300; step();
	t("a frame redraws the footer", x.st.renders > r0, true);
	t("minimal: streaming, received counting up", x.foot(), ["↑222k ↓26k · ✢ 83.5 tok/s · 22.0%/262k (auto)"]);
	x.ev("message_end", { message: { role: "assistant", usage: { output: 1000 } } });
	t("minimal: settles without a glyph", x.foot(), ["↑222k ↓25k · 83.5 tok/s · 22.0%/262k (auto)"]);
	t("interval cleared", timers.length, 0);

	// ---------------------------------------------------------- full, same style
	await x.cmd("");
	t("/metrics: still lets-code's footer", [typeof x.st.footer, x.st.setFooterCalls], ["object", 1]);
	t("full: directory, branch, model, level", x.foot()[0], `~/github/app (main)${" ".repeat(200 - 19 - 20)}qwen3.8-27b • medium`);
	t("full: cache, first token, output", x.foot()[1], "↑222k ↓25k · 198k cached (89% hit) · 83.5 tok/s · 0.3s first token · 1.0k out · 22.0%/262k (auto)");
	clock = 70000; x.ev("before_provider_request");
	clock = 71200; step();
	t("full: waiting", x.foot()[1], "↑222k ↓25k · 198k cached (89% hit) · ✢ 83.5 tok/s · 1.2s to first token · 22.0%/262k (auto)");
	clock = 71300; x.delta("thinking_delta", "y".repeat(400));
	clock = 72300; step();
	t("full: streaming, live output", x.foot()[1], "↑222k ↓25k · 198k cached (89% hit) · ✳ 84.2 tok/s · 1.3s first token · 100 out · 22.0%/262k (auto)");
	x.ev("agent_end");
	t("interrupt: spinner stopped, last finished response back", [timers.length, x.foot()[1]], [0, "↑222k ↓25k · 198k cached (89% hit) · 83.5 tok/s · 0.3s first token · 1.0k out · 22.0%/262k (auto)"]);
	await x.cmd("");
	t("/metrics again: minimal", x.foot(), ["↑222k ↓25k · 83.5 tok/s · 22.0%/262k (auto)"]);
	await x.cmd("on");
	t("/metrics on: full", x.foot().length, 2);
	await x.cmd("off");
	t("/metrics off: minimal", x.foot().length, 1);
	await x.cmd("loud");
	t("/metrics bad argument warns", x.notes.at(-1), "usage: /metrics [on|off]");
	t("/metrics completes on|off", x.commands.metrics.getArgumentCompletions("o").map((c) => c.value), ["on", "off"]);

	// METRICS=true starts full; cost, providers, thinking off, no branch, estimates
	x = await load({ LETS_CODE_METRICS_ON: "1" }, { providers: 2, branch: null, level: "off" });
	x.ev("session_start");
	x.st.entries.push(usage(500, 0, 300, 0.0123));
	t("full from the start", x.foot().length, 2);
	t("full: no branch on the left", x.foot()[0].startsWith("~/github/app "), true);
	t("full: provider with several, thinking off, on the right", x.foot()[0].endsWith(" (lets-code) qwen3.8-27b • thinking off") && x.mod.width(x.foot()[0]) === 200, true);
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 0, text: "x".repeat(160) });
	t("full: cost; output estimated (~)", x.foot()[1], "↑500 ↓300 · $0.012 · 40.0 tok/s · 0.1s first token · ~40 out · 22.0%/262k (auto)");
	clock = 5000; x.ev("before_provider_request");
	clock = 6000; x.ev("message_end", { message: { role: "assistant", usage: { output: 0 } } });
	t("full: nothing streamed", x.foot()[1], "↑500 ↓300 · $0.012 · 40.0 tok/s · 1.0s first token · ~0 out · 22.0%/262k (auto)");

	// learned characters per token: 90 tokens for 320 characters
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	x.ev("session_start");
	x.respond({ at: 0, ttft: 1000, gen: 2000, output: 90, text: "z".repeat(320) });
	clock = 10000; x.ev("before_provider_request");
	clock = 10500; x.delta("text_delta", "y".repeat(320));
	clock = 12500; step();
	t("live estimate uses the learned ratio", x.foot()[1], "↓90 · ✢ 45.0 tok/s · 0.5s first token · 90 out · 22.0%/262k (auto)");
	x.ev("agent_end");

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
	t("other statuses on their own line", x.foot()[1], "mode: plan");
	t("cut to width", x.mod.width(x.foot(5)[0]) <= 5, true);

	// no UI
	x = await load({ LETS_CODE_METRICS_ON: "0" }, { hasUI: false });
	x.ev("session_start");
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
	t("no UI: footer untouched, no spinner", [x.st.footer, timers.length], ["pi", 0]);

	// helpers
	t("compact like pi", [999, 1234, 45200, 1_234_567, 15_000_000].map(x.mod.compact), ["999", "1.2k", "45k", "1.2M", "15M"]);
	t("tilde", [x.mod.tilde(join(HOME, "a/b"), HOME), x.mod.tilde(HOME, HOME), x.mod.tilde("/etc", HOME)], ["~/a/b", "~", "/etc"]);
	t("spread drops the right side when narrow", x.mod.spread("left", "right", 8), "left");
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
