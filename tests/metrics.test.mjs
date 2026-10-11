#!/usr/bin/env node
// Unit test for the response metrics extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-metrics.ts). Loads it with a fake pi, a
// fake clock and a fake setInterval stepped by hand, then drives
// before_provider_request, message_update, message_end, agent_end and the
// /metrics command. Needs Node >= 22.6.
//
//   tests/metrics.test.mjs [path/to/lets-code-metrics.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-metrics.ts");
const work = mkdtempSync(join(tmpdir(), "metrics-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let clock = 0;
Date.now = () => clock;
let timers = [];
globalThis.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; };
globalThis.clearInterval = (h) => { timers = timers.filter((x) => x !== h); };
const step = () => timers.forEach((h) => h.fn());

let loads = 0;
async function load(env, hasUI = true, theme) {
	timers = [];
	delete process.env.LETS_CODE_METRICS_ON;
	Object.assign(process.env, env);
	const f = join(work, `metrics-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, status = {}, commands = {}, notes = [];
	mod.default({ on(ev, h) { handlers[ev] = h; }, registerCommand(name, o) { commands[name] = o; } });
	const ctx = { hasUI, ui: { setStatus(k, v) { status[k] = v; }, notify(m) { notes.push(m); }, theme } };
	const cmd = (args) => commands.metrics.handler(args, ctx);
	const ev = (name, e) => handlers[name]?.(e, ctx);
	const delta = (type, text) => ev("message_update", { type: "message_update", assistantMessageEvent: { type, delta: text } });
	// one response: request at `at`, first token after `ttft` ms, streamed over `gen` ms
	const respond = ({ at, ttft, gen, output, text = "" }) => {
		clock = at; ev("before_provider_request", { type: "before_provider_request" });
		clock = at + ttft; delta("thinking_delta", text.slice(0, text.length / 2));
		clock = at + ttft + gen / 2; delta("text_delta", text.slice(text.length / 2));
		clock = at + ttft + gen;
		ev("message_end", { type: "message_end", message: { role: "assistant", usage: { output } } });
		return status["lets-code-metrics"];
	};
	return { mod, handlers, status, commands, notes, ev, delta, respond, cmd };
}
const S = (x) => x.status["lets-code-metrics"];

try {
	let x = await load({});
	t("outside lets-code: nothing registered", [Object.keys(x.handlers), Object.keys(x.commands)], [[], []]);

	// finished responses: the session average, this response's first token and output
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	t("first response", x.respond({ at: 1000, ttft: 900, gen: 20000, output: 836 }), "✦ 41.8 tok/s avg · 0.9s first token · 836 out");
	t("session average over both", x.respond({ at: 60000, ttft: 300, gen: 10000, output: 200 }), "✦ 34.5 tok/s avg · 0.3s first token · 200 out");
	t("no usage: estimated", x.respond({ at: 90000, ttft: 100, gen: 1000, output: 0, text: "x".repeat(160) }), "✦ 34.7 tok/s avg · 0.1s first token · ~40 out");
	const before = S(x);
	x.ev("message_end", { type: "message_end", message: { role: "user" } });
	t("user message ignored", S(x), before);
	clock = 200000; x.ev("before_provider_request", {});
	clock = 201000; x.ev("message_end", { type: "message_end", message: { role: "assistant", usage: { output: 0 } } });
	t("nothing streamed", S(x), "✦ 34.7 tok/s avg · 1.0s to first token · ~0 out");

	// /metrics
	await x.cmd("off");
	t("/metrics off hides", S(x), undefined);
	x.respond({ at: 300000, ttft: 100, gen: 1000, output: 30 });
	t("hidden: footer stays clear", S(x), undefined);
	await x.cmd("");
	t("/metrics toggles back on with the latest line", S(x), "✦ 34.6 tok/s avg · 0.1s first token · 30 out");
	await x.cmd("loud");
	t("/metrics bad argument warns", x.notes.at(-1), "usage: /metrics [on|off]");
	t("/metrics completes on|off", x.commands.metrics.getArgumentCompletions("o").map((c) => c.value), ["on", "off"]);
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	t("started off: /metrics registered", Object.keys(x.commands), ["metrics"]);
	x.respond({ at: 0, ttft: 500, gen: 2000, output: 100 });
	t("started off: footer clear", S(x), undefined);
	await x.cmd("on");
	t("/metrics on shows what was measured", S(x), "✦ 50.0 tok/s avg · 0.5s first token · 100 out");
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	await x.cmd("on");
	t("/metrics on before any response", S(x), "✦ metrics on: shown with the next response");

	// live: the spinner, the session average including the response on its way
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	clock = 10000; x.ev("before_provider_request", {});
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

	// the live estimate learns characters per token from the exact counts (90 / 320)
	clock = 20000; x.ev("before_provider_request", {});
	t("next request: the average so far while waiting", S(x), "· 45.0 tok/s avg · 0.0s to first token");
	clock = 20500; x.delta("thinking_delta", "y".repeat(320));
	clock = 22500; step();
	t("live: learned ratio", S(x), "✢ 45.0 tok/s avg · 0.5s first token · 90 out");

	// interrupted: agent_end without message_end stops it and keeps the last finished line
	x.ev("agent_end", {});
	t("interrupt: stopped", timers.length, 0);
	t("interrupt: last finished line back", S(x), "✦ 45.0 tok/s avg · 1.3s first token · 90 out");

	// /metrics off/on while a response is on its way
	clock = 30000; x.ev("before_provider_request", {});
	await x.cmd("off");
	t("off while streaming: stopped and cleared", [timers.length, S(x)], [0, undefined]);
	await x.cmd("on");
	t("on while streaming: spinning again", [timers.length, S(x)], [1, "· 45.0 tok/s avg · 0.0s to first token"]);
	x.ev("agent_end", {});

	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("before_provider_request", {});
	t("hidden: no spinner", [timers.length, S(x)], [0, undefined]);

	// theme: the whole line in dim gray
	x = await load({ LETS_CODE_METRICS_ON: "1" }, true, { fg: (c, s) => `<${c}>${s}</${c}>` });
	t("theme: dim", x.respond({ at: 0, ttft: 500, gen: 2000, output: 100 }), "<dim>✦ 50.0 tok/s avg · 0.5s first token · 100 out</dim>");

	// no UI (print mode, subagents): nothing set
	x = await load({ LETS_CODE_METRICS_ON: "1" }, false);
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
	t("no UI: footer untouched", [timers.length, x.status], [0, {}]);

	t("tokens: 12400 -> 12.4k", x.mod.tokens(12400), "12.4k");
	t("tokens: 20000 -> 20k", x.mod.tokens(20000), "20k");
	t("tokens: 812 -> 812", x.mod.tokens(812), "812");
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
