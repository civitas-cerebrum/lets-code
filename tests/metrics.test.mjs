#!/usr/bin/env node
// Unit test for the footer and metrics extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-metrics.ts). Loads it with a fake pi, a
// fake clock and a fake setInterval stepped by hand, renders the minimal
// footer through a fake TUI, and drives session_start,
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
process.env.PI_CODING_AGENT_DIR = work;          // settings.json: compaction on (absent = on)

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let clock = 0;
Date.now = () => clock;
let timers = [];
globalThis.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; };
globalThis.clearInterval = (h) => { timers = timers.filter((x) => x !== h); };
const step = () => timers.forEach((h) => h.fn());

let loads = 0;
async function load(env, { hasUI = true, theme } = {}) {
	timers = [];
	delete process.env.LETS_CODE_METRICS_ON;
	Object.assign(process.env, env);
	const f = join(work, `metrics-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, status = new Map(), commands = {}, notes = [];
	const st = { footer: "pi", entries: [], context: { percent: 22.0, contextWindow: 262144 }, renders: 0 };
	mod.default({ on(ev, h) { handlers[ev] = h; }, registerCommand(name, o) { commands[name] = o; } });
	const tui = { requestRender() { st.renders++; } };
	const ctx = {
		hasUI,
		ui: {
			setStatus(k, v) { if (v === undefined) status.delete(k); else status.set(k, v); },
			notify(m) { notes.push(m); }, theme,
			setFooter(fac) { st.footer = fac ? fac(tui, theme ?? { fg: (_c, s) => s }, { getExtensionStatuses: () => status }) : "pi"; },
		},
		sessionManager: { getEntries: () => st.entries },
		getContextUsage: () => st.context,
		model: { contextWindow: 262144 },
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
		return status.get("lets-code-metrics");
	};
	const foot = (w = 200) => (st.footer === "pi" ? "pi" : st.footer.render(w));
	return { mod, handlers, status, commands, notes, ev, delta, respond, cmd, st, foot };
}
const S = (x) => x.status.get("lets-code-metrics");
const usage = (input, cacheRead, output) => ({ type: "message", message: { role: "assistant", usage: { input, cacheRead, cacheWrite: 0, output } } });

try {
	let x = await load({});
	t("outside lets-code: nothing registered", [Object.keys(x.handlers), Object.keys(x.commands)], [[], []]);

	// ---------------------------------------------------------- minimal (default)
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("session_start");
	t("minimal: replaces pi's footer", typeof x.st.footer, "object");
	t("minimal: empty session", x.foot(), ["22.0%/262k (auto)"]);
	x.st.entries.push(usage(1000, 221000, 25000));
	x.respond({ at: 1000, ttft: 900, gen: 20000, output: 836 });
	t("minimal: sent (cached included), received, speed, context", x.foot(), ["↑222k ↓25k · 41.8 tok/s · 22.0%/262k (auto)"]);
	t("minimal: no status line of its own", S(x), undefined);
	// streaming: spinner glyph, received counting up, speed live
	clock = 60000; x.ev("before_provider_request");
	t("minimal: spinner while waiting", x.foot(), ["↑222k ↓25k · · 41.8 tok/s · 22.0%/262k (auto)"]);
	const r0 = x.st.renders;
	clock = 60300; x.delta("text_delta", "x".repeat(4000));
	clock = 62300; step();
	t("minimal: frame redraws the footer", x.st.renders > r0, true);
	t("minimal: streaming", x.foot(), ["↑222k ↓26k · ✢ 83.5 tok/s · 22.0%/262k (auto)"]);
	x.ev("message_end", { message: { role: "assistant", usage: { output: 1000 } } });
	t("minimal: settles without a glyph", x.foot(), ["↑222k ↓25k · 83.5 tok/s · 22.0%/262k (auto)"]);
	// context colors, other extensions' statuses
	const th = { fg: (c, s) => `<${c}>${s}</${c}>` };
	x = await load({ LETS_CODE_METRICS_ON: "0" }, { theme: th });
	x.ev("session_start");
	x.st.context = { percent: 75.04, contextWindow: 262144 };
	t("minimal: over 70% in warning", x.foot(), ["<warning>75.0%/262k (auto)</warning>"]);
	x.st.context = { percent: 93.2, contextWindow: 262144 };
	t("minimal: over 90% in error", x.foot()[0], "<error>93.2%/262k (auto)</error>");
	x.st.context = { percent: null, contextWindow: 262144 };
	t("minimal: unknown after compaction", x.foot()[0], "<dim>?/262k (auto)</dim>");
	x.status.set("mandate", "mode: plan");
	t("minimal: other statuses on a second line", x.foot()[1], "mode: plan");
	t("minimal: cut to width", x.foot(5)[0].replace(/<[^>]+>/g, "").length <= 5 + 1, true);

	// ---------------------------------------------------------- /metrics switches
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("session_start");
	x.respond({ at: 0, ttft: 500, gen: 2000, output: 100 });
	await x.cmd("");
	t("/metrics: pi's full footer", x.st.footer, "pi");
	t("/metrics: plus the detailed line", S(x), "✦ 50.0 tok/s avg · 0.5s first token · 100 out");
	await x.cmd("");
	t("/metrics again: minimal, detailed line gone", [typeof x.st.footer, S(x)], ["object", undefined]);
	await x.cmd("on");
	t("/metrics on: full", x.st.footer, "pi");
	await x.cmd("off");
	t("/metrics off: minimal", typeof x.st.footer, "object");
	await x.cmd("loud");
	t("/metrics bad argument warns", x.notes.at(-1), "usage: /metrics [on|off]");
	t("/metrics completes on|off", x.commands.metrics.getArgumentCompletions("o").map((c) => c.value), ["on", "off"]);
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("session_start");
	await x.cmd("on");
	t("/metrics on before any response", S(x), "✦ metrics: shown with the next response");

	// ---------------------------------------------------------- full (METRICS=true)
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	x.ev("session_start");
	t("full: pi's footer kept", x.st.footer, "pi");
	t("first response", x.respond({ at: 1000, ttft: 900, gen: 20000, output: 836 }), "✦ 41.8 tok/s avg · 0.9s first token · 836 out");
	t("session average over both", x.respond({ at: 60000, ttft: 300, gen: 10000, output: 200 }), "✦ 34.5 tok/s avg · 0.3s first token · 200 out");
	t("no usage: estimated", x.respond({ at: 90000, ttft: 100, gen: 1000, output: 0, text: "x".repeat(160) }), "✦ 34.7 tok/s avg · 0.1s first token · ~40 out");
	const before = S(x);
	x.ev("message_end", { message: { role: "user" } });
	t("user message ignored", S(x), before);
	clock = 200000; x.ev("before_provider_request");
	clock = 201000; x.ev("message_end", { message: { role: "assistant", usage: { output: 0 } } });
	t("nothing streamed", S(x), "✦ 34.7 tok/s avg · 1.0s to first token · ~0 out");

	x = await load({ LETS_CODE_METRICS_ON: "1" });
	x.ev("session_start");
	clock = 10000; x.ev("before_provider_request");
	t("live: starts at once", S(x), "· 0.0s to first token");
	t("live: one interval", timers.length, 1);
	clock = 11200; step();
	t("live: waiting", S(x), "✢ 1.2s to first token");
	clock = 11300; x.delta("text_delta", "x".repeat(40));
	clock = 11400; step();
	t("live: streaming", S(x), "✳ 100.0 tok/s avg · 1.3s first token · 10 out");
	clock = 13300; x.delta("text_delta", "x".repeat(280));
	step();
	t("live: updates as tokens stream", S(x), "✶ 40.0 tok/s avg · 1.3s first token · 80 out");
	for (let i = 0; i < 6; i++) step();
	t("live: frames ping-pong", S(x).split(" ")[0], "✢");
	step();
	t("live: and loop", S(x).split(" ")[0], "·");
	x.ev("message_end", { message: { role: "assistant", usage: { output: 90 } } });
	t("done: exact numbers under ✦", S(x), "✦ 45.0 tok/s avg · 1.3s first token · 90 out");
	t("done: interval cleared", timers.length, 0);
	clock = 20000; x.ev("before_provider_request");
	t("next request: the average so far while waiting", S(x), "· 45.0 tok/s avg · 0.0s to first token");
	clock = 20500; x.delta("thinking_delta", "y".repeat(320));
	clock = 22500; step();
	t("live: learned characters per token", S(x), "✢ 45.0 tok/s avg · 0.5s first token · 90 out");
	x.ev("agent_end");
	t("interrupt: stopped", timers.length, 0);
	t("interrupt: last finished line back", S(x), "✦ 45.0 tok/s avg · 1.3s first token · 90 out");
	clock = 30000; x.ev("before_provider_request");
	await x.cmd("off");
	t("off while streaming: minimal, still spinning there", [typeof x.st.footer, S(x), timers.length], ["object", undefined, 1]);
	await x.cmd("on");
	t("on while streaming: detailed line spinning", S(x).startsWith("· 45.0 tok/s avg"), true);
	x.ev("agent_end");

	x = await load({ LETS_CODE_METRICS_ON: "1" }, { theme: { fg: (c, s) => `<${c}>${s}</${c}>` } });
	x.ev("session_start");
	t("full: line in dim gray", x.respond({ at: 0, ttft: 500, gen: 2000, output: 100 }), "<dim>✦ 50.0 tok/s avg · 0.5s first token · 100 out</dim>");

	// ---------------------------------------------------------- no UI
	x = await load({ LETS_CODE_METRICS_ON: "0" }, { hasUI: false });
	x.ev("session_start");
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
	t("no UI: footer and status untouched", [x.st.footer, timers.length, x.status.size], ["pi", 0, 0]);

	t("compact like pi", ["999", "1.2k", "45k", "1.2M", "15M"].join(), [999, 1234, 45200, 1_234_567, 15_000_000].map(x.mod.compact).join());
	t("tokens: 12400 -> 12.4k", x.mod.tokens(12400), "12.4k");
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
