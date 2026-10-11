#!/usr/bin/env node
// Unit test for the response metrics extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-metrics.ts). Loads it with a fake pi and
// a fake clock, then drives before_provider_request, message_update and
// message_end, agent_end, the /metrics command and the spinner (with a fake
// setInterval stepped by hand). Needs Node >= 22.6.
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
// fake timers: the spinner's interval is stepped by hand
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
	// one response: request at `at`, first token after `ttft` ms, streamed over `gen` ms
	const respond = ({ at, ttft, gen, output, text = "" }) => {
		clock = at; ev("before_provider_request", { type: "before_provider_request" });
		ev("message_start", { type: "message_start", message: { role: "assistant" } });
		clock = at + ttft;
		ev("message_update", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: text.slice(0, text.length / 2) } });
		clock = at + ttft + gen / 2;
		ev("message_update", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(text.length / 2) } });
		clock = at + ttft + gen;
		ev("message_end", { type: "message_end", message: { role: "assistant", usage: { output } } });
		return status["lets-code-metrics"];
	};
	return { mod, handlers, status, commands, notes, ev, respond, cmd };
}

try {
	let x = await load({});
	t("outside lets-code: nothing registered", [Object.keys(x.handlers), Object.keys(x.commands)], [[], []]);

	x = await load({ LETS_CODE_METRICS_ON: "1" });
	t("first response", x.respond({ at: 1000, ttft: 900, gen: 20000, output: 836 }), "✦ 41.8 tok/s · 0.9s first token · 836 out · avg 41.8 tok/s");
	t("session average", x.respond({ at: 60000, ttft: 300, gen: 10000, output: 200 }), "✦ 20.0 tok/s · 0.3s first token · 200 out · avg 34.5 tok/s");
	t("no usage: estimated", x.respond({ at: 90000, ttft: 100, gen: 1000, output: 0, text: "x".repeat(160) }), "✦ ~40.0 tok/s · 0.1s first token · ~40 out · avg 34.7 tok/s");

	// a user message ending does not touch the footer
	const before = x.status["lets-code-metrics"];
	x.ev("message_end", { type: "message_end", message: { role: "user" } });
	t("user message ignored", x.status["lets-code-metrics"], before);

	// a response with no streamed delta (e.g. an empty reply) has no rate
	clock = 200000; x.ev("before_provider_request", {});
	clock = 201000; x.ev("message_end", { type: "message_end", message: { role: "assistant", usage: { output: 0 } } });
	t("no tokens: no rate", x.status["lets-code-metrics"], "✦ – tok/s · ~0 out · avg 34.7 tok/s");

	// /metrics: off hides, on shows the last line again, bad args warn
	await x.cmd("off");
	t("/metrics off hides", x.status["lets-code-metrics"], undefined);
	x.respond({ at: 300000, ttft: 100, gen: 1000, output: 30 });
	t("hidden: footer stays clear", x.status["lets-code-metrics"], undefined);
	await x.cmd("");
	t("/metrics toggles back on with the last response", x.status["lets-code-metrics"], "✦ 30.0 tok/s · 0.1s first token · 30 out · avg 34.6 tok/s");
	await x.cmd("loud");
	t("/metrics bad argument warns", x.notes.at(-1), "usage: /metrics [on|off]");
	t("/metrics completes on|off", x.commands.metrics.getArgumentCompletions("o").map((c) => c.value), ["on", "off"]);

	// started off (METRICS unset): measured but hidden until /metrics on
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	t("started off: /metrics registered", Object.keys(x.commands), ["metrics"]);
	x.respond({ at: 0, ttft: 500, gen: 2000, output: 100 });
	t("started off: footer clear", x.status["lets-code-metrics"], undefined);
	await x.cmd("on");
	t("/metrics on shows what was measured", x.status["lets-code-metrics"], "✦ 50.0 tok/s · 0.5s first token · 100 out · avg 50.0 tok/s");
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	await x.cmd("on");
	t("/metrics on before any response", x.status["lets-code-metrics"], "✦ metrics on: shown after the next response");

	// the spinner: elapsed time before the first token, a live estimate after
	x = await load({ LETS_CODE_METRICS_ON: "1" });
	clock = 10000; x.ev("before_provider_request", {}, );
	t("spinner: starts at once", x.status["lets-code-metrics"], "· 0.0s");
	t("spinner: one interval", timers.length, 1);
	clock = 11200; step();
	t("spinner: waiting shows elapsed", x.status["lets-code-metrics"], "✢ 1.2s");
	clock = 11300; x.ev("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) } });
	clock = 11400; step();
	t("spinner: streaming, too early for a rate", x.status["lets-code-metrics"], "✳ ~10 out");
	clock = 13300; x.ev("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x".repeat(280) } });
	step();
	t("spinner: streaming, live estimate", x.status["lets-code-metrics"], "✶ ~40 tok/s · ~80 out");
	for (let i = 0; i < 6; i++) step();
	t("spinner: frames ping-pong", x.status["lets-code-metrics"].split(" ")[0], "✢");
	step();
	t("spinner: and loop", x.status["lets-code-metrics"].split(" ")[0], "·");
	clock = 13300; x.ev("message_end", { message: { role: "assistant", usage: { output: 90 } } });
	t("spinner: settles on ✦ with the exact numbers", x.status["lets-code-metrics"], "✦ 45.0 tok/s · 1.3s first token · 90 out · avg 45.0 tok/s");
	t("spinner: interval cleared", timers.length, 0);

	// interrupted: agent_end without message_end stops it and keeps the last line
	clock = 20000; x.ev("before_provider_request", {});
	t("interrupt: spinning", timers.length, 1);
	x.ev("agent_end", {});
	t("interrupt: stopped", timers.length, 0);
	t("interrupt: last finished line back", x.status["lets-code-metrics"], "✦ 45.0 tok/s · 1.3s first token · 90 out · avg 45.0 tok/s");

	// /metrics off while streaming stops the spinner, on starts it again
	clock = 30000; x.ev("before_provider_request", {});
	await x.cmd("off");
	t("off while streaming: stopped and cleared", [timers.length, x.status["lets-code-metrics"]], [0, undefined]);
	await x.cmd("on");
	t("on while streaming: spinning again", [timers.length, x.status["lets-code-metrics"]], [1, "· 0.0s"]);
	x.ev("agent_end", {});

	// started hidden: no spinner at all
	x = await load({ LETS_CODE_METRICS_ON: "0" });
	x.ev("before_provider_request", {});
	t("hidden: no spinner", [timers.length, x.status["lets-code-metrics"]], [0, undefined]);

	// theme: the whole line in dim gray
	const theme = { fg: (c, s) => `<${c}>${s}</${c}>` };
	x = await load({ LETS_CODE_METRICS_ON: "1" }, true, theme);
	t("theme colors", x.respond({ at: 0, ttft: 500, gen: 2000, output: 100 }), "<dim>✦ 50.0 tok/s · 0.5s first token · 100 out · avg 50.0 tok/s</dim>");

	// no UI (print mode, subagents): nothing set
	x = await load({ LETS_CODE_METRICS_ON: "1" }, false);
	x.respond({ at: 0, ttft: 100, gen: 1000, output: 50 });
	t("no UI: footer untouched", x.status, {});

	t("tokens: 12400 -> 12.4k", x.mod.tokens(12400), "12.4k");
	t("tokens: 20000 -> 20k", x.mod.tokens(20000), "20k");
	t("tokens: 812 -> 812", x.mod.tokens(812), "812");
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
