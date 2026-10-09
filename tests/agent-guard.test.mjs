#!/usr/bin/env node
// Unit test for the agent guard extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-agentguard.ts). Loads it with a fake pi and
// drives its handlers. Needs Node >= 22.6 (runs the .ts directly: it only
// imports types from pi).
//
//   tests/agent-guard.test.mjs [path/to/lets-code-agentguard.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// controllable clock for the time-based rules
const realNow = Date.now; let fakeNow = null;
Date.now = () => (fakeNow ?? realNow());
const advance = (ms) => { fakeNow = (fakeNow ?? realNow()) + ms; };

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-agentguard.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "agentguard-test-")));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0, n = 0;
function check(name, got, want) {
	n++;
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// Each load gets its own copy so module-level env reads see that load's env.
let loads = 0;
async function load(env) {
	for (const k of ["LETS_CODE_AGENT_GUARD_ON", "LETS_CODE_THINKING_AUTO", "LETS_CODE_BASH_TIMEOUT", "LETS_CODE_WRAP_TURNS", "LETS_CODE_WRAP_MINUTES", "LETS_CODE_AGENT_GUARD_LOG", "LETS_CODE_BURST_TURNS", "LETS_CODE_MAX_BURSTS", "LETS_CODE_THINKING_REPLAY", "LETS_CODE_FINAL_REVIEW", "LETS_CODE_PLAN_BURST", "LETS_CODE_PLAN_LEVEL", "LETS_CODE_THINKING_BASE", "LETS_CODE_THINKING_DOWN"]) delete process.env[k];
	Object.assign(process.env, env);
	const f = join(work, `agentguard-${loads++}.ts`);
	writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {};
	const pi = {
		level: "medium",
		on(ev, h) { handlers[ev] = h; return () => {}; },
		getThinkingLevel() { return this.level; },
		setThinkingLevel(l) { this.level = l; },
	};
	mod.default(pi);
	return { mod, pi, handlers, emit: (ev, e) => handlers[ev]?.({ type: ev, ...e }, {}) };
}
const bash = (h, command, input = {}) => { const e = { toolName: "bash", toolCallId: "x", input: { command, ...input } }; h.emit("tool_call", e); return e.input; };
const result = (h, toolName, text, isError = false, input = {}) => h.emit("tool_result", { toolName, toolCallId: "x", input, content: [{ type: "text", text }], isError });
const edit = (h, path, ok = true) => { h.emit("tool_call", { toolName: "edit", toolCallId: "e", input: { path, edits: [{ oldText: "a" + Math.random(), newText: "b" }] } }); return result(h, "edit", ok ? "Successfully replaced 1 block(s)" : "Could not find the exact text", !ok, { path }); };
const turn = (h, msg) => h.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: {} }], ...msg }, toolResults: [] });

// --- inert unless switched on
{
	const h = await load({});
	check("inert: no handlers", Object.keys(h.handlers).length, 0);
}

// --- testStatus parses the formats seen in benchmark sessions
{
	const { mod } = await load({});
	const t = mod.testStatus;
	check("unittest ok", t("....\n----\nRan 4 tests in 0.01s\n\nOK"), 0);
	check("unittest failed", t("Ran 21 tests in 0.02s\n\nFAILED (failures=2, errors=11)"), 13);
	check("unittest errors only", t("Ran 3 tests\n\nFAILED (errors=1)"), 1);
	check("n passed n failed", t("40 passed, 3 failed"), 3);
	check("pytest failed", t("=== 2 failed, 10 passed in 0.1s ==="), 2);
	check("pytest ok", t("============ 12 passed in 0.05s ============"), 0);
	check("FAIL lines", t("FAIL: a\nok b\nFAIL: c\n"), 2);
	check("ALL PASS", t("checked 30 cases\nALL PASS"), 0);
	check("not a test", t("Successfully wrote to calc.py"), null);
	check("mixed summaries: the failure wins", t("value tests: 130 pass, 1 fail\nerror tests: 0 failures"), 1);
	check("unittest line counts are not failures", t("Ran 9 tests in 0.1s\n\nFAILED (failures=4)"), 4);
	check("no pass marker and no count: not a test", t("Traceback ...\nValueError: bad"), null);
	check("key=value counters", t("ERROR MISMATCH x\nchecked=20000 failures=51 skipped=0"), 51);
	check("key=value zero", t("checked=20000 failures=0 skipped=0"), 0);
}

// --- bash timeout: added when missing, model's own value kept
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_BASH_TIMEOUT: "120" });
	check("timeout added", bash(h, "python3 fuzz.py").timeout, 120);
	check("timeout kept", bash(h, "make", { timeout: 900 }).timeout, 900);
	const other = { toolName: "read", toolCallId: "y", input: { path: "a" } };
	h.emit("tool_call", other);
	check("read untouched", other.input.timeout, undefined);
}

// --- cut-off reply without a tool call: continuation, capped at 3
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1" });
	const cut = { stopReason: "length", content: [{ type: "text", text: "long reasoning..." }] };
	const r = await turn(h, cut);
	check("length nudge continues", r?.continue, true);
	check("length nudge message", r?.entries?.[0]?.type, "custom_message");
	await turn(h, cut); await turn(h, cut);
	check("length nudge capped", await turn(h, cut), undefined);
	check("length with tool call: no nudge", await turn(h, { stopReason: "length" }), undefined);
}

// --- wrap-up: once, after tests pass for WRAP_TURNS turns; a failure resets the count
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_WRAP_TURNS: "3" });
	await result(h, "bash", "Ran 5 tests\n\nFAILED (failures=1)");
	for (let i = 0; i < 5; i++) check(`no wrap while failing ${i}`, await turn(h), undefined);
	await result(h, "bash", "Ran 5 tests\n\nOK");
	check("no wrap at pass+1", await turn(h), undefined);
	check("no wrap at pass+2", await turn(h), undefined);
	await result(h, "bash", "Ran 6 tests\n\nFAILED (failures=1)");
	check("failure resets", await turn(h), undefined);
	await result(h, "bash", "Ran 6 tests\n\nOK");
	await turn(h); await turn(h);
	check("3 passing turns within 2 min: no wrap yet", await turn(h), undefined);
	advance(2 * 60_000);
	const r = await turn(h);
	check("wrap after 3 passing turns and 2 min", r?.entries?.[0]?.content?.includes("finish now"), true);
	check("wrap does not force a request", r?.continue, undefined);
	await turn(h);
	check("wrap only once", await turn(h), undefined);
}

// --- dynamic thinking: bursts to the ceiling with a goal, end on resolution / turn cap / passing tests
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_BURST_TURNS: "3" });
	await h.emit("session_start", {});
	check("auto starts off", h.pi.level, "off");
	await edit(h, "calc.py", false);
	check("one failed edit: still off", h.pi.level, "off");
	await edit(h, "calc.py", false);
	check("two failed edits: jumps to the ceiling", h.pi.level, "high");
	const r = await turn(h);
	check("goal message on the next turn end", /Thinking raised to high because: 2 failed edits in a row/.test(r?.entries?.[0]?.content ?? ""), true);
	check("goal message asks for a hypothesis confirmed by running code", /state your best hypothesis.*confirm it by running code/.test(r?.entries?.[0]?.content ?? ""), true);
	check("goal message does not force a request", r?.continue, undefined);
	await turn(h);
	check("unresolved after 1 burst turn: still up", h.pi.level, "high");
	await edit(h, "calc.py");
	await turn(h);
	check("a successful edit resolves the trigger: back to off", h.pi.level, "off");
	await edit(h, "calc.py", false);
	check("counters reset after the burst", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_BURST_TURNS: "3" });
	await h.emit("session_start", {});
	for (const f of [4, 4, 4, 4]) { bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=" + f + ")", true); await edit(h, "calc.py"); }
	check("same failures 3 runs: escalated", h.pi.level, "high");
	await turn(h); await turn(h); await turn(h);
	check("not resolved by 3 turns: still up before the cap", h.pi.level, "high");
	await turn(h);
	check("3 burst turns: back to off", h.pi.level, "off");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=4)", true);
	check("no new signal yet: stays off", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=1)", true);
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=5)", true);
	check("more failures after an edit: regression escalates", h.pi.level, "high");
	await turn(h);
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=1)", true);
	await turn(h);
	check("failures back to the previous best: resolved", h.pi.level, "off");
	// growth of the suite is not a regression: a test-file edit between the runs
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=1)", true);
	await edit(h, "test_calc.py"); await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 14 tests\n\nFAILED (failures=6)", true);
	check("more failures after adding tests: not a regression", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	for (let i = 0; i < 3; i++) { bash(h, "python3 - <<'EOF'\nassert f(" + i + ") == 2\nEOF"); await result(h, "bash", "Traceback (most recent call last):\n  File \"<stdin>\", line 1\nAssertionError\n\nCommand exited with code 1", true); }
	check("3 failing assertion scripts: not tool errors", h.pi.level, "off");
	for (let i = 0; i < 3; i++) { bash(h, "python3 x" + i + ".py"); await result(h, "bash", "Traceback (most recent call last):\n  ...\nImportError: no module\n\nCommand exited with code 1", true); }
	check("3 real crashes: escalated", h.pi.level, "high");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "medium" });
	await h.emit("session_start", {});
	for (let i = 0; i < 4; i++) { bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=" + (4 - i) + ")", true); await edit(h, "calc.py"); }
	check("falling failures never escalate", h.pi.level, "off");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	check("no escalation while tests pass", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_MAX_BURSTS: "1" });
	await h.emit("session_start", {});
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	check("burst 1", h.pi.level, "high");
	await turn(h); await edit(h, "calc.py"); await turn(h);
	check("burst 1 resolved", h.pi.level, "off");
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	check("max bursts reached: no burst 2", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	await turn(h);
	const r = await turn(h, { stopReason: "stop", content: [{ type: "text", text: "I think the fix is..." }] });
	check("thinking turn with no tool call: act nudge continues", r?.continue, true);
	check("act nudge names the reason", /Act on your conclusion/.test(r?.entries?.[0]?.content ?? ""), true);
	check("act nudge once per burst", (await turn(h, { stopReason: "stop", content: [] }))?.continue, undefined);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1" });
	await h.emit("session_start", {});
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	check("fixed level untouched without auto", h.pi.level, "medium");
}

// --- thinking replay window
{
	const { mod } = await load({});
	const strip = mod.stripOldThinking;
	const a = (i) => ({ role: "assistant", content: [{ type: "thinking", thinking: "t" + i }, { type: "text", text: "a" + i }] });
	const msgs = [{ role: "user", content: "q" }, a(1), { role: "toolResult", content: [] }, a(2), a(3)];
	check("replay all: untouched", strip(msgs, Infinity), null);
	const out = strip(msgs, 1);
	check("keep 1: older thinking dropped", out[1].content.length === 1 && out[3].content.length === 1 && out[4].content.length === 2, true);
	check("keep 1: other messages intact", out[0] === msgs[0] && out[2] === msgs[2], true);
	check("keep 0: all thinking dropped", strip(msgs, 0).every((m) => m.role !== "assistant" || m.content.every((c) => c.type !== "thinking")), true);
	check("nothing to strip: null", strip([{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a" }] }], 1), null);
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_REPLAY: "2" });
	const r = await h.emit("context", { messages: msgs });
	check("context hook applies the window", r?.messages?.[1]?.content?.length, 1);
	const h2 = await load({ LETS_CODE_AGENT_GUARD_ON: "1" });
	check("default: context untouched", await h2.emit("context", { messages: msgs }), undefined);
}

// --- v6/v8: final review (after a struggle), heredoc syntax errors ignored
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	check("struggle before the review: burst", h.pi.level, "high");
	await turn(h);
	await edit(h, "calc.py");
	await turn(h);
	check("burst resolved", h.pi.level, "off");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	const r = await h.emit("agent_before_settle", {});
	check("passing and verified at settle: review burst continues", r?.continue, true);
	check("review raises thinking to the ceiling", h.pi.level, "high");
	check("review asks for every rule with its executed test", /list every rule it states.*executed test that covers it/.test(r?.entries?.[0]?.content ?? ""), true);
	check("review is verification only", /verification step, not a refactor.*check its expected value against the task/.test(r?.entries?.[0]?.content ?? ""), true);
	await turn(h);
	check("after the review turn: back to off", h.pi.level, "off");
	const r2 = await h.emit("agent_before_settle", {});
	check("finishing after the review without a run: green-run nudge", /green run after the final review/.test(r2?.entries?.[0]?.content ?? ""), true);
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 12 tests\n\nOK");
	check("green run after the review: settles, review only once", await h.emit("agent_before_settle", {}), undefined);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nFAILED (failures=2)", true);
	const r = await h.emit("agent_before_settle", {});
	check("tests failing at settle: no review, failed-check nudge instead", /reported a failure/.test(r?.entries?.[0]?.content ?? ""), true);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1" });
	await edit(h, "calc.py"); bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	check("fixed level, review auto: no review", await h.emit("agent_before_settle", {}), undefined);
	const h3 = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_FINAL_REVIEW: "on" });
	await edit(h3, "calc.py"); bash(h3, "python3 t.py"); await result(h3, "bash", "Ran 9 tests\n\nOK");
	const r3 = await h3.emit("agent_before_settle", {});
	check("fixed level, review on: review continues", r3?.continue, true);
	check("fixed level, review on: level unchanged", h3.pi.level, "medium");
	bash(h3, "python3 t.py"); await result(h3, "bash", "Ran 9 tests\n\nOK");
	check("fixed level, review on: once", await h3.emit("agent_before_settle", {}), undefined);
	const h2 = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_FINAL_REVIEW: "0" });
	await edit(h2, "calc.py"); bash(h2, "python3 t.py"); await result(h2, "bash", "Ran 9 tests\n\nOK");
	check("review disabled: settles", await h2.emit("agent_before_settle", {}), undefined);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	for (let i = 0; i < 3; i++) { bash(h, "python3 - <<'EOF'\nx(" + i + "\nEOF"); await result(h, "bash", '  File "<stdin>", line 1\n    x(\n     ^\nSyntaxError: unexpected EOF\n\nCommand exited with code 1', true); }
	check("heredoc syntax errors: no burst", h.pi.level, "off");
	await result(h, "bash", '  File "/w/calc.py", line 9\nSyntaxError: invalid syntax', true);
	await result(h, "bash", '  File "/w/calc.py", line 12\nIndentationError: unexpected indent', true);
	check("2 syntax errors in a real file: burst", h.pi.level, "high");
}

// --- v7: plan burst, test-file noise
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_PLAN_BURST: "1" });
	await h.emit("session_start", {});
	check("plan burst: starts at the bounded plan level", h.pi.level, "low");
	const ev = { systemPromptOptions: { sections: {} } };
	await h.emit("before_agent_start", ev);
	check("plan burst: plan section added", /list every rule the task states/.test(ev.systemPromptOptions.sections.lets_code_plan ?? ""), true);
	await turn(h, { content: [{ type: "toolCall", name: "read", arguments: { path: "spec.md" } }] });
	check("plan burst: still on while reading", h.pi.level, "low");
	await turn(h, { content: [{ type: "toolCall", name: "write", arguments: { path: "calc.py" } }] });
	check("plan burst: off once source is written", h.pi.level, "off");
	const h2 = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_PLAN_BURST: "1" });
	await h2.emit("session_start", {});
	await turn(h2); await turn(h2);
	check("plan burst: off after 2 turns at most", h2.pi.level, "off");
	const h3 = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h3.emit("session_start", {});
	check("no plan burst by default", h3.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "test_calc.py", false); await edit(h, "test_calc.py", false); await edit(h, "tests/test_x.py", false);
	check("failed edits to test files: no burst", h.pi.level, "off");
	await result(h, "bash", '  File "/w/test_calc.py", line 41\n    ("$[ \'store\' ].book[ 0 ]", [books[0]]]),\n                                        ^\nSyntaxError: closing parenthesis', true);
	await result(h, "bash", '  File "/w/test3.py", line 9\nSyntaxError: invalid syntax', true);
	check("syntax errors in test files: no burst", h.pi.level, "off");
}

// --- stuck-tests burst after an earlier green run must still be resolvable
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	await edit(h, "test_calc.py");
	for (let i = 0; i < 4; i++) { bash(h, "python3 t.py"); await result(h, "bash", "Ran 12 tests\n\nFAILED (failures=2)", true); await edit(h, "calc.py"); }
	check("stuck after an earlier green run: escalated", h.pi.level, "high");
	const r = await turn(h);
	check("goal names the real failing count", /2 test\(s\) still failing/.test(r?.entries?.[0]?.content ?? ""), true);
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 12 tests\n\nFAILED (failures=1)", true);
	await turn(h);
	check("fewer failures resolves it", h.pi.level, "off");
}

// --- v8: early "draft broadly wrong" burst, review only after a struggle, no bursts after the review
{
	const { mod } = await load({});
	check("total: unittest", mod.testTotal("Ran 12 tests in 0.1s\n\nFAILED (failures=7)"), 12);
	check("total: n passed, m failed", mod.testTotal("5 passed, 7 failed"), 12);
	check("total: pass/fail words", mod.testTotal("value tests: 130 pass, 1 fail"), 131);
	check("total: unknown", mod.testTotal("FAIL: a\nFAIL: b"), null);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 10 tests\n\nFAILED (failures=6)", true);
	check("first run with most tests failing: burst", h.pi.level, "high");
	const hs = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await hs.emit("session_start", {});
	bash(hs, "python3 t.py"); await result(hs, "bash", "Ran 6 tests\n\nFAILED (failures=4)", true);
	check("small suite, 4 of 6 failing: no draft burst", hs.pi.level, "off");
	const r = await turn(h);
	check("draft goal says rethink the design", /6 of 10 tests fail on the first draft.*rewrite that part/.test(r?.entries?.[0]?.content ?? ""), true);
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 10 tests\n\nFAILED (failures=2)", true);
	await turn(h);
	check("down to a quarter failing: resolved", h.pi.level, "off");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 10 tests\n\nFAILED (failures=8)", true);
	check("draft burst fires once per session (no edit in between: no regression either)", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 10 tests\n\nFAILED (failures=2)", true);
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 10 tests\n\nFAILED (failures=7)", true);
	check("a late jump to most failing is a regression, not a draft burst", h.pi.level, "high");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 4 tests\n\nOK");
	check("smooth session: no review", await h.emit("agent_before_settle", {}), undefined);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	await edit(h, "calc.py", false); await edit(h, "calc.py", false); await turn(h); await edit(h, "calc.py"); await turn(h);
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	await h.emit("agent_before_settle", {}); await turn(h);
	await edit(h, "test_rules.py");
	for (let i = 0; i < 4; i++) { bash(h, "python3 t.py"); await result(h, "bash", "Ran 14 tests\n\nFAILED (failures=3)", true); await edit(h, "calc.py"); }
	check("after the review starts: no bursts", h.pi.level, "off");
}

// --- v9: adaptive thinking, resting at medium until the tests pass, off after, bursts to high
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_THINKING_BASE: "medium", LETS_CODE_THINKING_DOWN: "off" });
	await h.emit("session_start", {});
	check("adaptive: starts at base medium", h.pi.level, "medium");
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	check("adaptive: own tests pass -> dial down to off", h.pi.level, "off");
	await edit(h, "test_calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 12 tests\n\nFAILED (failures=1)", true);
	check("adaptive: a new test fails -> back to medium", h.pi.level, "medium");
	const hr = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_THINKING_BASE: "medium" });
	await hr.emit("session_start", {});
	bash(hr, "python3 t.py"); await result(hr, "bash", "Ran 9 tests\n\nOK");
	await edit(hr, "calc.py");
	bash(hr, "python3 t.py"); await result(hr, "bash", "Ran 9 tests\n\nFAILED (failures=2)", true);
	check("adaptive: green then a source edit breaks it -> regression burst to high", hr.pi.level, "high");
	await edit(h, "calc.py", false); await edit(h, "calc.py", false);
	check("adaptive: struggle -> burst to high", h.pi.level, "high");
	await turn(h); await edit(h, "calc.py"); await turn(h);
	check("adaptive: burst resolved while failing -> back to medium, not off", h.pi.level, "medium");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 9 tests\n\nOK");
	check("adaptive: green -> off", h.pi.level, "off");
	await h.emit("agent_before_settle", {});
	check("adaptive: review after a burst runs at the ceiling", h.pi.level, "high");
	await turn(h);
	check("adaptive: after the review -> rest level (off, tests green)", h.pi.level, "off");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_THINKING_BASE: "medium" });
	await h.emit("session_start", {});
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 5 tests\n\nOK");
	check("adaptive, easy task: first run green -> off at once", h.pi.level, "off");
	check("adaptive, easy task: no review without a burst", await h.emit("agent_before_settle", {}), undefined);
}

// --- v10: firm stop after an ignored wrap-up
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_WRAP_TURNS: "2" });
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 5 tests\n\nOK");
	advance(3 * 60_000);
	let w = null;
	for (let i = 0; i < 5 && !w; i++) { const r = await turn(h); if (r?.entries?.some((e) => /finish now/.test(e.content))) w = r; }
	check("wrap-up fires", !!w, true);
	for (let i = 0; i < 5; i++) check(`no stop yet ${i}`, (await turn(h))?.entries?.some((e) => /Stop now/.test(e.content)) ?? false, false);
	const st = await turn(h);
	check("6 turns after the wrap-up without a source change: firm stop", st?.entries?.some((e) => /Stop now/.test(e.content)), true);
	check("firm stop only once", (await turn(h))?.entries?.some((e) => /Stop now/.test(e.content)) ?? false, false);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_WRAP_TURNS: "2" });
	await edit(h, "calc.py");
	bash(h, "python3 t.py"); await result(h, "bash", "Ran 5 tests\n\nOK");
	advance(3 * 60_000);
	await turn(h); await turn(h); await turn(h);
	await edit(h, "calc.py");
	let stopped = false;
	for (let i = 0; i < 6; i++) { const r = await turn(h); if (r?.entries?.some((e) => /Stop now/.test(e.content))) stopped = true; }
	check("a source change after the wrap-up: no firm stop", stopped, false);
	const h2 = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_WRAP_TURNS: "2" });
	await edit(h2, "calc.py");
	bash(h2, "python3 t.py"); await result(h2, "bash", "Ran 5 tests\n\nOK");
	advance(3 * 60_000);
	await turn(h2); await turn(h2); await turn(h2);
	advance(4 * 60_000);
	const st2 = await turn(h2);
	check("4 minutes after the wrap-up without a source change: firm stop", st2?.entries?.some((e) => /Stop now/.test(e.content)), true);
}

// --- v11: test detection for unusual output, 40-turn signal needs a recognised run
{
	const { mod } = await load({});
	check("all inline tests passed", mod.testStatus("checking...\nall inline tests passed"), 0);
	check("All 189 test assertions pass", mod.testStatus("All 189 test assertions pass"), 0);
	check("all checks passed, 0 failures is still green", mod.testStatus("all 30 checks passed, failures=0"), 0);
	check("all tests passed but 2 failed is not green", mod.testStatus("all tests passed except: 2 failed"), 2);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high", LETS_CODE_THINKING_BASE: "medium" });
	await h.emit("session_start", {});
	bash(h, "cd /w && python3 test_jpath.py"); await result(h, "bash", "ran the suite\nlooks good: pass");
	check("test file exits 0 with 'pass': green, dial down", h.pi.level, "off");
	bash(h, "python3 test_jpath.py"); await result(h, "bash", "Traceback (most recent call last):\n  File \"test_jpath.py\", line 9\nAssertionError\n\nCommand exited with code 1", true);
	check("test file ends in AssertionError: red, back to medium", h.pi.level, "medium");
	bash(h, "python3 - <<'EOF'\nassert 1\nEOF"); await result(h, "bash", "pass");
	check("ad-hoc heredoc is not a test run", h.pi.level, "medium");
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1", LETS_CODE_THINKING_AUTO: "high" });
	await h.emit("session_start", {});
	for (let i = 0; i < 41; i++) await turn(h);
	await result(h, "read", "file contents");
	check("40 turns with no recognised test run: no burst", h.pi.level, "off");
	bash(h, "python3 test_x.py"); await result(h, "bash", "Ran 4 tests\n\nFAILED (failures=1)", true);
	check("after a recognised failing run, the 40-turn signal applies", h.pi.level, "high");
}

// --- verification means execution
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1" });
	const ev = { systemPromptOptions: { sections: { tools: "x" } } };
	await h.emit("before_agent_start", ev);
	const sec = ev.systemPromptOptions.sections.lets_code_verification ?? "";
	check("prompt section: run before reasoning", /Run before you reason/.test(sec), true);
	check("prompt section: decide ambiguities once", /Decide ambiguities once/.test(sec), true);
	check("prompt section: edit tools, not rewriting scripts", /edit and write tools/.test(sec), true);
	check("other sections kept", ev.systemPromptOptions.sections.tools, "x");
	check("nothing edited: settles normally", await h.emit("agent_before_settle", {}), undefined);
	await edit(h, "calc.py");
	const r = await h.emit("agent_before_settle", {});
	check("edit then finish: continuation", r?.continue, true);
	check("asks for a real run", /no command has been executed/.test(r?.entries?.[0]?.content ?? ""), true);
	bash(h, "cat calc.py"); await result(h, "bash", "def f(): ...");
	check("reading the file is not execution", (await h.emit("agent_before_settle", {}))?.continue, true);
	check("capped at 2", await h.emit("agent_before_settle", {}), undefined);
}
{
	const h = await load({ LETS_CODE_AGENT_GUARD_ON: "1" });
	await edit(h, "calc.py");
	bash(h, "cd /w && python3 test_calc.py"); await result(h, "bash", "Ran 4 tests\n\nOK");
	check("edit, run, finish: settles", await h.emit("agent_before_settle", {}), undefined);
	await edit(h, "test_calc.py");
	check("test-file edit after the run: settles", await h.emit("agent_before_settle", {}), undefined);
	bash(h, "python3 - <<'EOF'\nimport calc\nEOF"); await result(h, "bash", "Traceback (most recent call last):\n  ...\nAssertionError", true);
	const r = await h.emit("agent_before_settle", {});
	check("last executed check failed: continuation", /reported a failure/.test(r?.entries?.[0]?.content ?? ""), true);
	bash(h, "python3 test_calc.py"); await result(h, "bash", "Ran 4 tests\n\nOK");
	check("rerun passes: settles", await h.emit("agent_before_settle", {}), undefined);
}

rmSync(work, { recursive: true, force: true });
console.log(`${n - fail}/${n} checks passed`);
process.exit(fail ? 1 : 0);
