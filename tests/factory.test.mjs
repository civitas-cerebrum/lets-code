#!/usr/bin/env node
// Unit test for the software factory's engine that lets-code writes
// (~/.pi/agent/extensions/lets-code/factory.ts): the parsers, the ledger, the
// briefs, every verdict path, the fix-loop limit, the repeat stop, the three
// checkpoints with and without a UI, resume, and that no conversation reaches
// a stage. The stages are fake experts (scripted replies); git is real, on a
// scratch repo. Then the /factory command in a fake session, with fake
// subagents and experts modules next to it. Needs Node >= 22.6, git.
//
//   tests/factory.test.mjs [path/to/lets-code/factory.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/factory.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "factory-test-")));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const agentDir = join(work, "agent"); mkdirSync(join(agentDir, "extensions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
const modFile = join(agentDir, "extensions", "factory.ts"); writeFileSync(modFile, src);
const F = await import(pathToFileURL(modFile).href);

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();

// ------------------------------------------------------------------ parsers
t("status: first line", F.lineValue("STATUS: DONE\n## Changes", "STATUS"), "DONE");
t("status: after a remark, in backticks", F.lineValue("All set.\n\n`STATUS: PLAN`\nmore", "STATUS"), "PLAN");
t("verdict: bold, lower case", F.lineValue("Review done\n**VERDICT: revise**", "VERDICT"), "REVISE");
t("verdict: none", F.lineValue("I think it is fine", "VERDICT"), null);
t("verdict: only at a line start", F.lineValue("the VERDICT: APPROVE is mine", "VERDICT"), null);
const rv = "VERDICT: REVISE\n## Findings\n`R1 | blocker | src/cart.js:10 | confirmed | Expiry is 31 days`\n  why: off by one\n  fix: use 30\n\n`R2 | nit | src/cart.js:2 | suspected | a name`\n## Checked\nall";
const fr = F.parseFindings(rv, "R");
t("findings: ids, severity, where, title", fr.map((f) => [f.id, f.severity, f.where, f.title]), [["R1", "blocker", "src/cart.js:10", "Expiry is 31 days"], ["R2", "nit", "src/cart.js:2", "a name"]]);
t("findings: the detail lines", fr[0].detail, "why: off by one\nfix: use 30");
t("findings: design format (no confirmed column)", F.parseFindings("D3 | major | a.js:1 | two jobs in one module\n  why: x", "D").map((f) => [f.id, f.title, f.detail]), [["D3", "two jobs in one module", "why: x"]]);
t("findings: another prefix ignored", F.parseFindings(rv, "D"), []);
const jt = "## Verdict\nREJECT, C2 fails.\n## Criteria\nC1: PASS the total\nC2: FAIL expired codes accepted\n  evidence: rc=0\nC3: UNVERIFIABLE no test\n## Missing\nx";
const j = F.parseJudge(jt);
t("judge: verdict", j.verdict, "REJECT");
t("judge: failing criteria as findings", j.failing.map((f) => [f.id, f.title]), [["C2", "FAIL expired codes accepted"], ["C3", "UNVERIFIABLE no test"]]);
t("judge: detail", j.failing[0].detail, "evidence: rc=0");
t("judge: accept", F.parseJudge("## Verdict\n`ACCEPT` every criterion passes").verdict, "ACCEPT");
t("criteria: under the heading", F.parseCriteria("# T\nintro\n## Acceptance criteria\n1. one\n2. two\n   continued\n- three\n## Notes\n- not this"), ["one", "two continued", "three"]);
t("criteria: bold label, checkboxes", F.parseCriteria("**Acceptance criteria:**\n- [ ] a\n- [x] b"), ["a", "b"]);
t("criteria: none", F.parseCriteria("just do it"), []);
t("criteria from edited text", F.criteriaFromText("C1. one\n\n2) two\n- three\n"), ["one", "two", "three"]);
t("body without the status line", F.bodyOf("ok\nSTATUS: PLAN\n## Plan\n1. x", "STATUS"), "## Plan\n1. x");
t("body: the status line last, a remark first", F.bodyOf("I have enough to plan.\n\n## Plan\n1. x\n## Risks\nnone\n\nSTATUS: PLAN", "STATUS"), "## Plan\n1. x\n## Risks\nnone");
t("body: no heading, all but the status line", F.bodyOf("STATUS: DONE\nchanged a.js", "STATUS"), "changed a.js");

// the brief a model sent in a live run (its own field names, lists): nothing lost
{
	const live = { ticket: "Build a simple two-player local chess game that runs in the terminal.", goal: "A terminal chess game, `python3 -m chess`.",
		acceptance_criteria: ["1. Shows the board in text.", "2. Players alternate turns."], test_command: "python3 -m unittest",
		constraints: ["Python 3 standard library only.", "No computer opponent."], language: "Python 3" };
	const r = F.ticketFrom(live, "/");
	t("brief: criteria from acceptance_criteria", F.parseCriteria(r.ticket), ["Shows the board in text.", "Players alternate turns."]);
	t("brief: how_to_run from test_command", r.howToRun, "python3 -m unittest");
	t("brief: a list of constraints as lines, not JSON", r.constraints, "Python 3 standard library only.\nNo computer opponent.");
	t("brief: the goal and any other field reach the ticket", [r.ticket.includes("Goal: A terminal chess game"), r.ticket.includes("- language: Python 3")], [true, true]);
	t("brief: criteria the ticket already lists are not added twice", F.parseCriteria(F.ticketFrom({ ticket: "# T\n## Acceptance criteria\n1. a", criteria: "1. a" }, "/").ticket), ["a"]);
	t("brief: the schema's own names win", F.ticketFrom({ ticket: "x", how_to_run: "make test", test_command: "other" }, "/").howToRun, "make test");
}

// ------------------------------------------------------------------ a scratch repo
function makeRepo(name) {
	const r = join(work, name); mkdirSync(join(r, "src"), { recursive: true });
	git(work, "init", "-q", "-b", "main", r);
	git(r, "config", "user.name", "t"); git(r, "config", "user.email", "t@example.com");
	writeFileSync(join(r, "src", "a.txt"), "ok\n");
	writeFileSync(join(r, "TICKET.md"), "# SHOP-1: a feature\nAdd feature.txt.\n\n## Acceptance criteria\n1. feature.txt exists\n2. a.txt still says ok\n");
	git(r, "add", "-A"); git(r, "commit", "-qm", "base");
	return r;
}
const SECRET = "SECRET-CONVERSATION-7731";
// a fake expert per stage, scripted: each call pops the next reply of its stage
function fakeDeps(script, { decisions = {}, available = () => false } = {}) {
	const calls = []; const asked = [];
	const deps = {
		calls, asked,
		available,
		exec: (cmd, cwd, ms) => F.shellExec(cmd, cwd, ms),
		async dispatch(expert, brief, cwd, meta) {
			calls.push({ expert, brief, cwd, meta });
			const list = script[meta.stage] ?? []; const reply = list.length > 1 ? list.shift() : list[0];
			if (typeof reply === "function") return reply({ expert, brief, cwd, meta });
			return { text: reply ?? "", exitCode: 0, input: 100, output: 20, seconds: 1 };
		},
		async checkpoint(kind, L) {
			asked.push(kind);
			const d = decisions[kind]; const v = Array.isArray(d) ? (d.length > 1 ? d.shift() : d[0]) : d;
			if (v === undefined) return { action: kind === "result" ? "commit" : kind === "stuck" ? "stop" : "approve" };
			return typeof v === "function" ? v(L) : v;
		},
	};
	return deps;
}
const build = (content = "feature\n") => ({ cwd }) => { writeFileSync(join(cwd, "feature.txt"), content); return { text: "Done.\nSTATUS: DONE\n## Changes\n`feature.txt`: new\n## Tests\nnone", exitCode: 0, input: 300, output: 50, seconds: 2 }; };
const PLAN = "STATUS: PLAN\n## Plan\n1. add feature.txt (C1)\n## Tests\n## Risks\nnone";
const OK = { plan: [PLAN], build: [build()], "expert-review": ["VERDICT: APPROVE\n## Findings\nnone"], "design-review": ["VERDICT: APPROVE\n## Findings\nnone"], judge: ["## Verdict\nACCEPT all pass\n## Criteria\nC1: PASS x\nC2: PASS y"] };
const root = join(agentDir, "lets-code-factory");
const opts = (repo, extra = {}) => ({ ticket: readFileSync(join(repo, "TICKET.md"), "utf8"), repo, howToRun: "grep -q ok src/a.txt", root, ...extra });

// ------------------------------------------------------------------ stage briefs sized to the model's window
{
	const cb = F.contextBudget;
	const B = (w, files, lines, steps, write) => ({ window: w, files, lines, steps, write });
	t("budget: 32k window, 8k cap", cb(32768, 8192), B(32768, 2, 619, 6, 409));
	t("budget: 128k window", cb(131072, 32768), B(131072, 10, 3076, 12, 1600));
	t("budget: 1M window: capped", cb(1000000, 32000), B(1000000, 15, 6000, 12, 1600));
	t("budget: no cap given: a quarter of the window", cb(32768), B(32768, 2, 619, 6, 409));
	t("budget: a cap as large as the window: a quarter instead", cb(32768, 40000), B(32768, 2, 619, 6, 409));
	t("budget: a window too small for room: the floor", cb(8192, 4096), B(8192, 1, 150, 3, 204));
	t("budget: shrink halves the reading", cb(32768, 8192, 1), B(32768, 1, 309, 6, 409));
	t("budget: shrink never below the floor", cb(32768, 8192, 3), B(32768, 1, 150, 6, 409));
	t("budget: the write limit follows the reply cap, not the window", [cb(32768, 2000).write, cb(262144, 4096).write, cb(32768, 8192, 2).write], [100, 204, 409]);
	t("budget: no window, no budget", [cb(0, 8192), cb(undefined), cb(-5), cb("x")], [null, null, null, null]);
	// sized: each stage told its part
	const repo = makeRepo("budget"); const fd = fakeDeps({ ...OK, build: [build()] });
	const L = await F.startRun(opts(repo, { window: 32768, outCap: 8192 }), fd);
	const brief = (stage) => fd.calls.find((c) => c.meta.stage === stage)?.brief.context_budget ?? "";
	t("budget: the run keeps the window", [L.window, L.outCap, L.shrink], [32768, 8192, undefined]);
	t("budget: the plan in steps that fit, a split named past the step count", [/Plan the build in steps of at most 2 files changed and about 619 lines read each/.test(brief("plan")), /more than 6 such steps, say so at the top of the plan/.test(brief("plan"))], [true, true]);
	t("budget: the plan and the build told to write in parts", [/One reply holds about 409 lines: write a larger file in parts/.test(brief("plan")), /One reply holds about 409 lines/.test(brief("build"))], [true, true]);
	const tst = fakeDeps({ ...OK, build: [build()] }, { available: () => true }); const rt = makeRepo("tester-ticket");
	await F.startRun(opts(rt, { tester: "on" }), tst);
	const tgoal = tst.calls.find((c) => c.meta.stage === "test")?.brief.goal ?? "";
	t("tester: the goal carries the ticket and the every-example rule", [/Ticket \(Check every example and rule in the ticket too/.test(tgoal), tgoal.includes(readFileSync(join(rt, "TICKET.md"), "utf8").trim().split("\n")[0])], [true, true]);
	t("budget: the reviewers, tester and judge start with the verdict", ["expert-review", "design-review", "judge"].map((x) => /start your final reply with the verdict line, then one line per finding/.test(brief(x))), [true, true, true]);
	t("budget: the build a step at a time", /Build the plan one step at a time, reading only what the current step needs: about 619 lines/.test(brief("build")), true);
	t("budget: the reviewers and the judge read the change file by file", ["expert-review", "design-review", "judge"].map((s) => brief(s).includes(`git -C ${L.work} diff ${L.base} -- <file>`)), [true, true, true]);
	t("budget: nothing cut when nothing ran short", [/already cut/.test(brief("build")), L.entries.some((e) => e.short)], [false, false]);
	// not sized: no window given
	const r2 = makeRepo("nobudget"); const fd2 = fakeDeps({ ...OK, build: [build()] });
	const L2 = await F.startRun(opts(r2), fd2);
	t("no window: no context_budget in any brief", [L2.window, fd2.calls.some((c) => "context_budget" in c.brief)], [undefined, false]);
	t("no window: a shrink alone adds no sizes", F.budgetFor("build", { ...L2, shrink: 1 }), "");
	// a stage that ran short: the stages after it get smaller sizes, and say why
	const r3 = makeRepo("short"); const fd3 = fakeDeps({ ...OK, plan: [() => ({ text: PLAN, exitCode: 0, input: 1, output: 1, seconds: 1, compactions: 1 })], build: [build()] });
	const L3 = await F.startRun(opts(r3, { window: 32768, outCap: 8192 }), fd3);
	const b3 = (stage) => fd3.calls.find((c) => c.meta.stage === stage)?.brief.context_budget ?? "";
	t("ran short: the plan stage marked, the run shrunk once", [L3.entries.find((e) => e.stage === "plan").short, L3.shrink], [true, 1]);
	t("ran short: the build after it is cut and says so", [/about 309 lines/.test(b3("build")), /An earlier stage of this run ran short of context/.test(b3("build"))], [true, true]);
	t("ran short: the plan before it was not", /about 619 lines/.test(b3("plan")), true);
	// at 80% of the window without compacting counts; 60% does not
	const r4 = makeRepo("peak"); const fd4 = fakeDeps({ ...OK, build: [({ cwd }) => ({ ...build()({ cwd }), peak: 27000, window: 32768 })] });
	const L4 = await F.startRun(opts(r4, { window: 32768, outCap: 8192 }), fd4);
	t("ran short: a request at 80% of the window", [L4.entries.find((e) => e.stage === "build").short, L4.shrink], [true, 1]);
	const r5 = makeRepo("roomy"); const fd5 = fakeDeps({ ...OK, build: [({ cwd }) => ({ ...build()({ cwd }), peak: 20000, window: 32768 })] });
	const L5 = await F.startRun(opts(r5, { window: 32768, outCap: 8192 }), fd5);
	t("room left (60%): no shrink", [L5.entries.find((e) => e.stage === "build").short, L5.shrink], [undefined, undefined]);
	// every stage short: the shrink stops at 3
	const all = (x) => typeof x === "function" ? (a) => ({ ...x(a), compactions: 1 }) : () => ({ text: x, exitCode: 0, input: 1, output: 1, seconds: 1, compactions: 1 });
	const r6 = makeRepo("allshort"); const fd6 = fakeDeps(Object.fromEntries(Object.entries({ ...OK, build: [build()] }).map(([k, v]) => [k, v.map(all)])));
	const L6 = await F.startRun(opts(r6, { window: 32768, outCap: 8192 }), fd6);
	t("ran short at every stage: the shrink stops at 3", [L6.shrink, L6.entries.filter((e) => e.short).length >= 4], [3, true]);
	// a developer reply cut at the reply limit: continued from the work tree, not blocked
	const cutOnce = [() => ({ text: "half a reply", exitCode: 0, input: 10, output: 8000, seconds: 3, cut: true }), build()];
	const r7 = makeRepo("cut"); const fd7 = fakeDeps({ ...OK, build: cutOnce });
	const L7 = await F.startRun(opts(r7, { window: 32768, outCap: 8192 }), fd7);
	const builds7 = fd7.calls.filter((c) => c.meta.stage === "build");
	t("cut build: continued once, then done", [L7.status, builds7.length, L7.entries.find((e) => e.stage === "build").continued], ["done", 2, 1]);
	t("cut build: the continuation says where it stopped, from the work tree", [/cut off at the reply limit\. The work tree keeps every file you wrote/.test(builds7[1].brief.continue), builds7[1].brief.continue.endsWith("half a reply"), "continue" in builds7[0].brief], [true, true, false]);
	t("cut build: tokens and time of both replies counted", [L7.entries.find((e) => e.stage === "build").output_tokens, L7.entries.find((e) => e.stage === "build").seconds], [8050, 5]);
	const cutPlan = [() => ({ text: "1. a", exitCode: 0, input: 1, output: 1, seconds: 1, cut: true }), PLAN];
	const r8 = makeRepo("cutplan"); const fd8 = fakeDeps({ ...OK, plan: cutPlan, build: [build()] });
	const L8 = await F.startRun(opts(r8), fd8);
	const plans8 = fd8.calls.filter((c) => c.meta.stage === "plan");
	t("cut plan: asked again, shorter, and goes on", [L8.status, plans8.length, /Reply again with the whole plan, shorter/.test(plans8[1].brief.continue)], ["done", 2, true]);
	// negative: cut every time: two continuations, then the run blocks as before
	const always = () => ({ text: "cut again", exitCode: 0, input: 1, output: 1, seconds: 1, cut: true });
	const r9 = makeRepo("cutalways"); const fd9 = fakeDeps({ ...OK, build: [always] }, { decisions: { stuck: { action: "stop" }, blocked: { action: "stop" } } });
	const L9 = await F.startRun(opts(r9), fd9);
	t("cut every time: continued at most MAX_CONTINUES, then blocked", [fd9.calls.filter((c) => c.meta.stage === "build").length, F.MAX_CONTINUES, L9.entries.find((e) => e.stage === "build").continued, L9.status], [3, 2, 2, "stopped"]);
	// negative: a reviewer's cut reply is not continued
	const r10 = makeRepo("cutreview"); const fd10 = fakeDeps({ ...OK, build: [build()], "expert-review": [() => ({ text: "VERDICT: APPROVE\n## Findings\nnone", exitCode: 0, input: 1, output: 1, seconds: 1, cut: true })] });
	await F.startRun(opts(r10), fd10);
	t("a reviewer's cut reply that has its verdict: not asked again", fd10.calls.filter((c) => c.meta.stage === "expert-review").length, 1);
	// a review reply without its verdict (cut off, or left out): asked again, verdict first
	const noVerdict = (cut) => () => ({ text: "I checked C1 and C2 and ran the suite; looking at the parser n", exitCode: 0, input: 1, output: 1, seconds: 1, cut });
	const r11 = makeRepo("ask-cut-review"); const fd11 = fakeDeps({ ...OK, build: [build()], "expert-review": [noVerdict(true), "VERDICT: APPROVE\n## Findings\nnone"] });
	const L11 = await F.startRun(opts(r11, { window: 32768, outCap: 8192 }), fd11);
	const rv11 = fd11.calls.filter((c) => c.meta.stage === "expert-review");
	t("review cut without its verdict: asked again, then on", [L11.status, rv11.length, L11.entries.find((e) => e.stage === "expert-review").continued, L11.entries.find((e) => e.stage === "expert-review").verdict], ["done", 2, 1, "APPROVE"]);
	t("review asked again: verdict first, briefly, and why", [/ended without its verdict \(cut off at the reply limit\)/.test(rv11[1].brief.continue), /the verdict line first, then one line per finding/.test(rv11[1].brief.continue)], [true, true]);
	const r12 = makeRepo("ask-leftout"); const fd12 = fakeDeps({ ...OK, build: [build()], "design-review": [noVerdict(false), "VERDICT: APPROVE\n## Findings\nnone"] });
	const L12 = await F.startRun(opts(r12), fd12);
	t("design review with the verdict left out (not cut): asked again", [L12.status, fd12.calls.filter((c) => c.meta.stage === "design-review").length, /ended without its verdict\. Check only/.test(fd12.calls.filter((c) => c.meta.stage === "design-review")[1].brief.continue)], ["done", 2, true]);
	const r13 = makeRepo("ask-judge"); const fd13 = fakeDeps({ ...OK, build: [build()], judge: [noVerdict(false), "## Verdict\nACCEPT all pass\n## Criteria\nC1: PASS x\nC2: PASS y"] });
	const L13 = await F.startRun(opts(r13), fd13);
	t("judge without its verdict: asked again", [L13.status, fd13.calls.filter((c) => c.meta.stage === "judge").length], ["done", 2]);
	const r13b = makeRepo("judge-never"); const fd13b = fakeDeps({ ...OK, build: [build()], judge: [noVerdict(false)] }, { decisions: { blocked: { action: "stop" } } });
	const L13b = await F.startRun(opts(r13b), fd13b);
	t("judge never a verdict, the suite passes: blocked, not waved through by the developer's suite", [L13b.entries.find((e) => e.stage === "judge").verdict, L13b.status, L13b.unreviewed], ["NO VERDICT", "stopped", undefined]);
	const jb = fd13b.calls.find((c) => c.meta.stage === "judge").brief, tb = fd13b.calls.find((c) => c.meta.stage === "test")?.brief;
	t("judge: given the ticket, told to check its every example", [/Check every example and rule in the ticket too/.test(jb.ticket), jb.ticket.includes(readFileSync(join(r13b, "TICKET.md"), "utf8").trim().split("\n")[0]), /A failing example of the ticket is a failing criterion/.test(jb.ticket)], [true, true, true]);
	// never a verdict: asked again twice, then the suite decides
	const r14 = makeRepo("ask-never"); const fd14 = fakeDeps({ ...OK, build: [build()], "expert-review": [noVerdict(false)] }, { decisions: { blocked: { action: "stop" } } });
	const L14 = await F.startRun(opts(r14), fd14);
	t("never a verdict, the suite passes: on, marked unreviewed", [fd14.calls.filter((c) => c.meta.stage === "expert-review").length, L14.entries.find((e) => e.stage === "expert-review").verdict, L14.unreviewed, L14.status, fd14.calls.some((c) => c.meta.stage === "design-review")], [3, "NO VERDICT (the suite passes)", true, "done", true]);
	const r14b = makeRepo("ask-never-red"); const fd14b = fakeDeps({ ...OK, build: [build()], "expert-review": [noVerdict(false)] }, { decisions: { stuck: { action: "stop" }, blocked: { action: "stop" } } });
	const L14b = await F.startRun(opts(r14b, { howToRun: "test -f nope.txt" }), fd14b);
	const ev14b = L14b.entries.filter((e) => e.stage === "expert-review");
	t("never a verdict, the suite fails: a fix round with its output, not on", [ev14b[0].verdict, fd14b.calls.filter((c) => c.meta.stage === "build").length >= 2, /no verdict from expert-reviewer, and the test suite fails/.test(fd14b.calls.filter((c) => c.meta.stage === "build")[1]?.brief.findings ?? ""), L14b.status], ["NO VERDICT (the suite fails)", true, true, "stopped"]);
	// a test command that runs no tests (exit 5): it judges nothing, so no fix round on it
	const noTestsCmd = "printf 'Ran 0 tests in 0.000s\\n\\nNO TESTS RAN\\n'; exit 5";
	const r14d = makeRepo("ask-never-notests"); const fd14d = fakeDeps({ ...OK, build: [build()], "expert-review": [noVerdict(false)] }, { decisions: { stuck: { action: "stop" }, blocked: { action: "stop" } } });
	const L14d = await F.startRun(opts(r14d, { howToRun: noTestsCmd }), fd14d);
	t("never a verdict, the suite runs no tests: on, unreviewed, no fix round", [L14d.entries.find((e) => e.stage === "expert-review").verdict, fd14d.calls.filter((c) => c.meta.stage === "build").length, L14d.unreviewed], ["NO VERDICT (the suite runs no tests)", 1, true]);
	t("the suite ran no tests before the change: the developer is told", [/finds no tests yet: name and place your tests so that this exact command runs them/.test(fd14d.calls.find((c) => c.meta.stage === "plan").brief.test_command ?? ""), "test_command" in fd14d.calls.find((c) => c.meta.stage === "build").brief], [true, true]);
	t("a suite that runs tests: no such note", "test_command" in fd14.calls.find((c) => c.meta.stage === "plan").brief, false);
	t("the suite ran no tests, now as before: regression says NO TESTS, not FAIL", L14d.entries.find((e) => e.stage === "regression")?.verdict, "NO TESTS (as before the change)");
	t("ranNoTests: unittest and pytest wording, exit 5 only", [F.ranNoTests(5, "Ran 0 tests in 0.000s\n\nNO TESTS RAN"), F.ranNoTests(5, "collected 0 items"), F.ranNoTests(1, "NO TESTS RAN"), F.ranNoTests(5, "FAILED (failures=2)")], [true, true, false, false]);
	const r14c = makeRepo("ask-never-nosuite"); const fd14c = fakeDeps({ ...OK, build: [build()], "expert-review": [noVerdict(false)] }, { decisions: { blocked: { action: "stop" } } });
	const L14c = await F.startRun(opts(r14c, { howToRun: "" }), fd14c);
	t("never a verdict, no test command: blocked as before", [L14c.entries.find((e) => e.stage === "expert-review").verdict, L14c.status], ["NO VERDICT", "stopped"]);
	// negative: a reviewer whose run failed is not asked again (that is a failure, not a missing line)
	const r15 = makeRepo("ask-failed"); const fd15 = fakeDeps({ ...OK, build: [build()], "expert-review": [() => ({ text: "boom", exitCode: 1, input: 1, output: 1, seconds: 1 })] }, { decisions: { blocked: { action: "stop" } } });
	const L15 = await F.startRun(opts(r15), fd15);
	t("a failed review run: not asked again", [fd15.calls.filter((c) => c.meta.stage === "expert-review").length, L15.entries.find((e) => e.stage === "expert-review").verdict], [1, "FAILED"]);
	// blocked after the build: decision final takes the build to the final approval, and it is committed
	const r16 = makeRepo("final-blocked"); const fd16 = fakeDeps({ ...OK, build: [build()], "expert-review": [noVerdict(false)] }, { decisions: { blocked: { action: "final", by: "the orchestrator" } } });
	const L16 = await F.startRun(opts(r16, { howToRun: "" }), fd16);
	t("blocked after the build, final: committed on the run branch, marked unreviewed", [L16.status, !!L16.commit, L16.unreviewed, L16.entries.some((e) => e.verdict === "FINAL AS IT IS" && /expert-review and the stages after it did not run/.test(e.summary))], ["done", true, true, true]);
	t("blocked after the build, final: the later stages did not run", fd16.calls.some((c) => c.meta.stage === "design-review" || c.meta.stage === "judge"), false);
	t("blocked after the build: final is offered", F.decisionsAt("blocked", { ...L16, waiting: "blocked" }), ["retry", "final", "stop"]);
	// negative: blocked before anything was built: final is not offered, and refused
	const r17 = makeRepo("final-early"); const fd17 = fakeDeps({ ...OK, plan: ["I would add a file."] }, { decisions: { blocked: { action: "stop" } } });
	const L17 = await F.startRun(opts(r17), fd17);
	t("blocked before a build: final not offered", F.decisionsAt("blocked", L17), ["retry", "stop"]);
	t("blocked before a build: final refused", typeof F.decisionFor("blocked", "final", undefined, L17), "string");
	t("blocked after a build: final accepted", F.decisionFor("blocked", "final", undefined, L16), { action: "final", text: undefined, by: "the orchestrator" });
	// a fix round that changes nothing is sent back to the findings
	const revise = "VERDICT: REVISE\n## Findings\nR1 | major | feature.txt | confirmed | the content is wrong";
	const idleFix = () => ({ text: "I looked at the findings.", exitCode: 0, input: 1, output: 1, seconds: 1 });
	const disputeFix = () => ({ text: "STATUS: DONE\nR1 is wrong: the content is as the ticket says; no change.", exitCode: 0, input: 1, output: 1, seconds: 1 });
	const r18 = makeRepo("idle-fix"); const fd18 = fakeDeps({ ...OK, build: [build(), idleFix, build("fixed\n")], "expert-review": [revise, "VERDICT: APPROVE\n## Findings\nnone"] });
	const L18 = await F.startRun(opts(r18), fd18);
	const b18 = fd18.calls.filter((c) => c.meta.stage === "build");
	t("fix round that changed nothing: sent back, then fixed and on", [L18.status, b18.length, /changed nothing in the work tree, and the findings below are still open/.test(b18[2].brief.continue ?? ""), L18.entries.filter((e) => e.stage === "build")[1].continued], ["done", 3, true, 1]);
	const r19 = makeRepo("real-fix"); const fd19 = fakeDeps({ ...OK, build: [build(), build("fixed\n")], "expert-review": [revise, "VERDICT: APPROVE\n## Findings\nnone"] });
	const L19 = await F.startRun(opts(r19), fd19);
	t("fix round that changed the work tree: not sent back", [L19.status, fd19.calls.filter((c) => c.meta.stage === "build").length], ["done", 2]);
	const r22 = makeRepo("dispute-fix"); const fd22 = fakeDeps({ ...OK, build: [build(), disputeFix], "expert-review": [revise, "VERDICT: APPROVE\n## Findings\nnone"] });
	const L22 = await F.startRun(opts(r22), fd22);
	t("fix round that says STATUS DONE without a change (disputing a finding): not sent back, the reviews judge it", [L22.status, fd22.calls.filter((c) => c.meta.stage === "build").length], ["done", 2]);
	const r20 = makeRepo("first-build"); const fd20 = fakeDeps({ ...OK, build: [build()] });
	const L20 = await F.startRun(opts(r20), fd20);
	t("the first build is never sent back for no change, and its fingerprint is kept", [fd20.calls.filter((c) => c.meta.stage === "build").length, /^\d+:[0-9a-f]+$/.test(L20.patch ?? "")], [1, true]);
	const r21 = makeRepo("idle-always"); const fd21 = fakeDeps({ ...OK, build: [build(), idleFix], "expert-review": [revise] }, { decisions: { stuck: { action: "stop" } } });
	const L21 = await F.startRun(opts(r21), fd21);
	t("fix round that never changes anything: sent back twice, then on as before (stuck on the repeat)", [fd21.calls.filter((c) => c.meta.stage === "build").length, L21.status], [4, "stopped"]);
	t("hasVerdict: the line, the judge's heading, neither", [F.hasVerdict("expert-review", "VERDICT: REVISE\nx"), F.hasVerdict("judge", "## Verdict\nREJECT C1"), F.hasVerdict("design-review", "all good"), F.hasVerdict("judge", "VERDICT is coming")], [true, true, false, false]);
	// negative: an uncut reply is never continued
	t("no cut: one build call", fd.calls.filter((c) => c.meta.stage === "build").length, 1);
}

// ------------------------------------------------------------------ no STATUS line (small models drop it)
{
	const noStatusBuild = ({ cwd }) => { writeFileSync(join(cwd, "feature.txt"), "feature\n"); return { text: "I wrote feature.txt and the tests pass.", exitCode: 0, input: 1, output: 1, seconds: 1 }; };
	const r1 = makeRepo("nostatus-build"); const f1 = fakeDeps({ ...OK, build: [noStatusBuild] });
	const L1 = await F.startRun(opts(r1), f1);
	t("no STATUS, a build that changed the work tree: on to the reviews", [L1.status, L1.entries.find((e) => e.stage === "build").verdict, f1.calls.some((c) => c.meta.stage === "expert-review")], ["done", "DONE (no STATUS line)", true]);
	const r2 = makeRepo("nostatus-nochange"); const f2 = fakeDeps({ ...OK, build: [() => ({ text: "Thinking about it.", exitCode: 0, input: 1, output: 1, seconds: 1 })] }, { decisions: { blocked: { action: "stop" } } });
	const L2 = await F.startRun(opts(r2), f2);
	t("no STATUS, no change: blocked as before, no review", [L2.entries.find((e) => e.stage === "build").verdict, f2.calls.some((c) => c.meta.stage === "expert-review"), L2.status], ["NO STATUS", false, "stopped"]);
	const r3 = makeRepo("nostatus-plan"); const f3 = fakeDeps({ ...OK, plan: ["Here is how:\n1. add feature.txt\n2. test it"], build: [build()] });
	const L3 = await F.startRun(opts(r3), f3);
	t("no STATUS, a numbered plan: a plan", [L3.entries.find((e) => e.stage === "plan").verdict, L3.status], ["PLAN (no STATUS line)", "done"]);
	const r4 = makeRepo("nostatus-prose"); const f4 = fakeDeps({ ...OK, plan: ["I would add a file and test it."] }, { decisions: { blocked: { action: "stop" } } });
	const L4 = await F.startRun(opts(r4), f4);
	t("no STATUS, a plan without steps: blocked", [L4.entries.find((e) => e.stage === "plan").verdict, L4.status], ["NO STATUS", "stopped"]);
	const r5 = makeRepo("blocked-said"); const f5 = fakeDeps({ ...OK, build: [({ cwd }) => { writeFileSync(join(cwd, "feature.txt"), "x\n"); return { text: "STATUS: BLOCKED\nneed a key", exitCode: 0, input: 1, output: 1, seconds: 1 }; }] }, { decisions: { blocked: { action: "stop" } } });
	const L5 = await F.startRun(opts(r5), f5);
	// the developer built at the plan stage
	const builtAtPlan = ({ cwd }) => { writeFileSync(join(cwd, "feature.txt"), "feature\n"); return { text: "Done, wrote feature.txt.\nSTATUS: DONE", exitCode: 0, input: 1, output: 1, seconds: 1 }; };
	const r6 = makeRepo("built-at-plan"); const f6 = fakeDeps({ ...OK, plan: [builtAtPlan] });
	const L6 = await F.startRun(opts(r6), f6);
	t("DONE at the plan stage with a change: on to the reviews, no build stage", [L6.status, L6.entries.find((e) => e.stage === "plan").verdict, f6.calls.some((c) => c.meta.stage === "build"), f6.calls.some((c) => c.meta.stage === "expert-review")], ["done", "DONE (built at the plan stage)", false, true]);
	t("DONE at the plan stage: no plan checkpoint asked", f6.asked.includes("plan"), false);
	const r7 = makeRepo("done-at-plan-nochange"); const f7 = fakeDeps({ ...OK, plan: ["STATUS: DONE\nall good"] }, { decisions: { blocked: { action: "stop" } } });
	const L7 = await F.startRun(opts(r7), f7);
	t("DONE at the plan stage without a change: blocked", [L7.status, f7.calls.some((c) => c.meta.stage === "expert-review")], ["stopped", false]);
	t("STATUS: BLOCKED said, even with a change: blocked", [L5.entries.find((e) => e.stage === "build").verdict, L5.status], ["BLOCKED", "stopped"]);
}

// ------------------------------------------------------------------ orchestrated: a green run is committed
{
	const E = (stage, verdict) => ({ stage, round: 0, verdict, summary: "", input: 0, output_tokens: 0, seconds: 0, started: 0, ended: 0 });
	const L = (entries) => ({ entries, criteria: ["C1"] });
	const cp = F.orchestrated();
	t("orchestrated, green (judge ACCEPT, regression PASS): commit", await cp("result", L([E("judge", "ACCEPT"), E("regression", "PASS")])), { action: "commit", by: "the orchestrator" });
	t("orchestrated, judge rejected: left to the orchestrator", await cp("result", L([E("judge", "REJECT"), E("regression", "PASS")])), null);
	t("orchestrated, suite failed as before the change: left to the orchestrator", await cp("result", L([E("judge", "ACCEPT"), E("regression", "FAIL (as before the change)")])), null);
	t("orchestrated, the suite runs no tests (as before) and the judge accepted: commit", await cp("result", L([E("judge", "ACCEPT"), E("regression", "NO TESTS (as before the change)")])), { action: "commit", by: "the orchestrator" });
	t("orchestrated, no regression ran: left to the orchestrator", await cp("result", L([E("judge", "ACCEPT"), E("regression", "SKIPPED")])), null);
	t("orchestrated, the last judge counts", await cp("result", L([E("judge", "REJECT"), E("judge", "ACCEPT"), E("regression", "PASS")])), { action: "commit", by: "the orchestrator" });
	t("orchestrated, a given decision first", await F.orchestrated({ action: "keep", by: "x" })("result", L([E("judge", "ACCEPT"), E("regression", "PASS")])), { action: "keep", by: "x" });
	t("orchestrated, other checkpoints unchanged", [await cp("plan", L([])), await cp("blocked", L([E("judge", "ACCEPT"), E("regression", "PASS")]))], [null, null]);
	// end to end: an orchestrated run commits its green result itself
	const repo = makeRepo("orch-green"); const fd = fakeDeps({ ...OK, build: [build()] }); fd.checkpoint = F.orchestrated();
	const L0 = await F.startRun(opts(repo), fd);
	t("orchestrated run: waits for the orchestrator at the plan", [L0.status, L0.waiting], ["waiting", "plan"]);
	const Lg = await F.resumeRun(L0.id, { ...fd, checkpoint: F.orchestrated({ action: "approve", by: "the orchestrator" }) }, root);
	t("orchestrated run, green: done and committed without being asked", [Lg.status, !!Lg.commit, Lg.waiting], ["done", true, null]);
	const r2 = makeRepo("orch-red"); const fd2 = fakeDeps({ ...OK, build: [build()], judge: ["## Verdict\nREJECT C1\n## Criteria\nC1: FAIL x"] }, { decisions: { stuck: { action: "final" } } }); fd2.checkpoint = F.orchestrated();
	const R0 = await F.startRun(opts(r2), fd2);
	const Lr = await F.resumeRun(R0.id, { ...fd2, checkpoint: F.orchestrated({ action: "approve", by: "the orchestrator" }) }, root);
	t("orchestrated run, judge rejects: not committed by itself", [!!Lr.commit, Lr.status], [false, "waiting"]);
}

// ------------------------------------------------------------------ the happy path
{
	const repo = makeRepo("happy"); const statusBefore = git(repo, "status", "--porcelain"); const head = git(repo, "rev-parse", "HEAD");
	const fd = fakeDeps({ ...OK, build: [build()] });
	const L = await F.startRun(opts(repo), fd);
	t("happy: done", [L.status, L.waiting], ["done", null]);
	t("happy: stages in order", L.entries.map((e) => e.stage), ["intake", "plan", "build", "expert-review", "design-review", "test", "judge", "regression"]);
	t("happy: tester skipped where not usable", L.entries.find((e) => e.stage === "test").verdict, "SKIPPED");
	t("happy: experts dispatched", fd.calls.map((c) => c.expert), ["developer", "developer", "expert-reviewer", "design-reviewer", "acceptance-judge"]);
	t("happy: the three checkpoints asked", fd.asked, ["criteria", "plan", "result"]);
	t("happy: criteria from the ticket", L.criteria, ["feature.txt exists", "a.txt still says ok"]);
	t("happy: every stage runs in the run's worktree", [...new Set(fd.calls.map((c) => c.cwd))], [L.work]);
	t("happy: its own branch", git(L.work, "rev-parse", "--abbrev-ref", "HEAD"), L.branch);
	t("happy: branch name passes the git guard", L.branch.startsWith("pi/factory-"), true);
	t("happy: one commit on the base", [git(L.work, "rev-parse", "HEAD^"), git(L.work, "show", "--name-only", "--format=", "HEAD")], [head, "feature.txt"]);
	t("happy: committed after the user's yes", L.commit, git(L.work, "rev-parse", "HEAD"));
	t("happy: the work tree is clean", git(L.work, "status", "--porcelain"), "");
	t("happy: the user's checkout untouched", [git(repo, "status", "--porcelain"), git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "--abbrev-ref", "HEAD")], [statusBefore, head, "main"]);
	t("happy: baseline and regression", [L.baseline.code, L.entries.at(-1).verdict], [0, "PASS"]);
	t("happy: the developer is told the ticket's repo is its worktree", [fd.calls[0].brief.workspace.includes(L.work), fd.calls[0].brief.workspace.includes(`${repo} (branch`), fd.calls[2].brief.diff.includes(`worktree of ${repo}`)], [true, true, true]);
	t("happy: plan mode, then build with the plan", [fd.calls[0].brief.mode, fd.calls[1].brief.mode, fd.calls[1].brief.plan], ["plan", "build", "## Plan\n1. add feature.txt (C1)\n## Tests\n## Risks\nnone"]);
	t("happy: reviewers get the diff and the criteria", [fd.calls[2].brief.diff.includes(L.base), fd.calls[2].brief.criteria], [true, "C1. feature.txt exists\nC2. a.txt still says ok"]);
	t("happy: the judge gets the developer's report as the claim", fd.calls[4].brief.claim.startsWith("## Changes"), true);
	t("happy: the diff saved", readFileSync(F.diffPath(L), "utf8").includes("+feature"), true);
	const saved = F.loadLedger(L.id, root);
	t("happy: the ledger on disk", [saved.status, saved.entries.length, saved.entries[1].expert, existsSync(join(L.dir, saved.entries[1].brief)), existsSync(join(L.dir, saved.entries[1].output))], ["done", 8, "developer", true, true]);
	t("happy: tokens and time per stage", [saved.entries[2].input, saved.entries[2].output_tokens, saved.entries[2].seconds > 0], [300, 50, true]);
	const s = F.summary(L);
	t("happy: the summary is stage lines only", [s.split("\n").length, s.includes("Done.\nSTATUS"), /build: DONE, 1 file changed/.test(s)], [10, false, true]);
	t("happy: listed", F.listRuns(root).some((x) => x.id === L.id), true);
}

// ------------------------------------------------------------------ a new project, where git has no identity (a fresh phone)
{
	const saved = { ...process.env };
	const cfg = join(work, "no-ident.gitconfig"); writeFileSync(cfg, "[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n");
	Object.assign(process.env, { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" });
	for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];
	try {
		const ticket = "# CHESS-1: a game\n## Acceptance criteria\n1. feature.txt exists\n";
		const fresh = join(work, "new", "chess");
		t("new: git has no identity here", (await F.shellExec("git var GIT_AUTHOR_IDENT", work)).code !== 0, true);
		const fd = fakeDeps({ ...OK, judge: ["## Verdict\nACCEPT\n## Criteria\nC1: PASS x"] });
		const L = await F.startRun({ ticket, repo: fresh, root }, fd);
		t("new: a folder that did not exist becomes the project", [L.status, existsSync(join(fresh, ".git")), L.repo], ["done", true, fresh]);
		t("new: the log says so", [L.entries[0].verdict, /created .*made it a git repo, added an empty first commit/.test(L.entries[0].summary)], ["new project", true]);
		t("new: the base is the empty first commit", [git(fresh, "rev-list", "--count", "HEAD"), git(fresh, "ls-tree", "HEAD")], ["1", ""]);
		t("new: committed with the factory's identity", [L.commit.length >= 40, git(L.work, "log", "-1", "--format=%an <%ae>")], [true, "lets-code factory <factory@lets-code.invalid>"]);
		t("new: the user's git config untouched", [readFileSync(cfg, "utf8").includes("lets-code"), (() => { try { return git(fresh, "config", "--local", "user.name"); } catch { return ""; } })()], [false, ""]);
		// an empty folder that exists; a repo with no commit and an untracked file
		const empty = join(work, "empty-dir"); mkdirSync(empty);
		const L2 = await F.startRun({ ticket, repo: empty, root }, fakeDeps(OK, { decisions: { criteria: { action: "stop" } } }));
		t("new: an empty folder too", [existsSync(join(empty, ".git")), L2.entries[0].summary.includes("made it a git repo")], [true, true]);
		const bare = join(work, "no-commit"); mkdirSync(bare); git(bare, "init", "-q"); writeFileSync(join(bare, "notes.txt"), "mine\n");
		const L3 = await F.startRun({ ticket, repo: bare, root }, fakeDeps(OK, { decisions: { criteria: { action: "stop" } } }));
		t("new: a repo without a commit gets an empty first one, its files left as they were", [L3.entries[0].summary.endsWith("added an empty first commit"), git(bare, "ls-tree", "HEAD"), git(bare, "status", "--porcelain")], [true, "", "?? notes.txt"]);
		const full = join(work, "has-files"); mkdirSync(full); writeFileSync(join(full, "x.txt"), "x");
		let err = ""; try { await F.startRun({ ticket, repo: full, root }, fakeDeps(OK)); } catch (e) { err = e.message; }
		let err2 = ""; try { await F.startRun({ ticket, repo: join(work, "chess (empty; becomes a repo)"), root }, fakeDeps(OK)); } catch (e) { err2 = e.message; }
		t("new: no folder is made from a path with a remark in it", [/a remark in the path/.test(err2), existsSync(join(work, "chess (empty; becomes a repo)"))], [true, false]);
		const L4 = await F.startRun({ ticket, repo: join(work, "remark"), root, howToRun: "python3 -m unittest discover -s . -p 'chess_tests.py' -v (tests in chess_tests.py at repo root; game started with python3 -m chess)" }, fakeDeps(OK, { decisions: { criteria: { action: "stop" } } }));
		t("new: a remark after the test command is dropped", L4.howToRun, "python3 -m unittest discover -s . -p 'chess_tests.py' -v");
		let err3 = ""; try { await F.startRun({ ticket, repo: join(work, "broken"), root, howToRun: "make test ((" }, fakeDeps(OK)); } catch (e) { err3 = e.message; }
		t("new: a test command that does not parse stops the start", /test command \(how_to_run\) is not a shell command that parses/.test(err3), true);
		t("new: a subshell is a command, not a remark", (await F.shellCommand("(cd src && make test)", "x", fakeDeps(OK), work)), "(cd src && make test)");
		t("new: a test command in prose: the command in its backticks", await F.shellCommand("Run the unit tests: `python3 -m unittest -v` from the repo root", "x", fakeDeps(OK), work), "python3 -m unittest -v");
		t("new: prose with a remark span first: the span that is a command", await F.shellCommand("Use `the test file` then run `python3 -m pytest -q`", "x", fakeDeps(OK), work), "python3 -m pytest -q");
		let err4 = ""; try { await F.shellCommand("Run the tests the usual way, with `pytest ((` maybe", "x", fakeDeps(OK), work); } catch (e) { err4 = e.message; }
		t("new: prose whose spans do not parse: still refused", /is not a shell command that parses/.test(err4), true);
		let err5 = ""; try { await F.shellCommand("Run the unit tests from the repo root", "x", fakeDeps(OK), work); } catch (e) { err5 = e.message; }
		t("new: prose without a command: still refused", /is not a shell command that parses/.test(err5), true);
		t("new: a folder with files that is not a repo is refused, untouched", [/not a git repository, and has files/.test(err), existsSync(join(full, ".git"))], [true, false]);
	} finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

// ------------------------------------------------------------------ a fix round, then approval
{
	const repo = makeRepo("fix");
	const R1 = "VERDICT: REVISE\n## Findings\nR1 | major | feature.txt:1 | wrong text | confirmed\n  fix: say feature\nR2 | minor | x | a nit\n";
	const fd = fakeDeps({ ...OK, build: [build("wrong\n"), build("feature\n")], "expert-review": [R1, "VERDICT: APPROVE\n## Findings\nnone\n## Previous\nR1: FIXED"] });
	const L = await F.startRun(opts(repo), fd);
	const builds = fd.calls.filter((c) => c.meta.stage === "build"); const reviews = fd.calls.filter((c) => c.meta.stage === "expert-review");
	t("fix: done after one round", [L.status, L.rounds], ["done", 1]);
	t("fix: back to the developer with the blocker/major findings only", [builds.length, builds[1].brief.findings.includes("R1 | major"), builds[1].brief.findings.includes("R2")], [2, true, false]);
	t("fix: the second review re-checks the earlier findings", [reviews.length, reviews[1].brief.previous_findings.includes("R1 | major | feature.txt:1")], [2, true]);
	t("fix: then on to design review", L.entries.map((e) => e.stage).slice(2, 6), ["build", "expert-review", "build", "expert-review"]);
	t("fix: the round in the ledger", L.entries.filter((e) => e.stage === "build").map((e) => e.round), [0, 1]);
	t("fix: ids sent, per stage", L.sent["expert-review"], ["R1"]);
}

// ------------------------------------------------------------------ the same finding comes back: stop and ask
{
	const repo = makeRepo("repeat");
	const R1 = "VERDICT: REVISE\nR1 | blocker | a | still broken";
	const fd = fakeDeps({ ...OK, build: [build("1\n"), build("2\n")], "expert-review": [R1] }, { decisions: { stuck: { action: "stop" } } });
	const L = await F.startRun(opts(repo), fd);
	t("repeat: asked after the second REVISE with R1", [fd.asked.at(-1), L.rounds, fd.calls.filter((c) => c.meta.stage === "build").length], ["stuck", 1, 2]);
	t("repeat: stopped on the user's word", [L.status, /stuck/.test(L.note)], ["stopped", true]);
	// the same, but the user wants one more round: it runs
	const repo2 = makeRepo("repeat-more");
	const fd2 = fakeDeps({ ...OK, build: [build("1\n"), build("2\n"), build("feature\n")], "expert-review": [R1, R1, "VERDICT: APPROVE"] }, { decisions: { stuck: [{ action: "more" }] } });
	const L2 = await F.startRun(opts(repo2), fd2);
	t("repeat: one more round on the user's word", [L2.status, L2.rounds, fd2.asked.filter((k) => k === "stuck").length], ["done", 2, 1]);
}

// ------------------------------------------------------------------ the loop limit
{
	const repo = makeRepo("limit"); let k = 0;
	const fresh = () => ({ text: `VERDICT: REVISE\nD${++k} | major | a | new problem ${k}`, exitCode: 0, input: 1, output: 1, seconds: 0 });
	const fd = fakeDeps({ ...OK, build: [build()], "design-review": [fresh] }, { decisions: { stuck: (L) => ({ action: L.rounds < F.MAX_FIX_ROUNDS ? "more" : "final" }) } });
	const L = await F.startRun(opts(repo), fd);
	t("limit: five rounds at most", [L.rounds, fd.calls.filter((c) => c.meta.stage === "build").length], [5, 6]);
	t("limit: then the user is asked once", fd.asked.filter((x) => x === "stuck").length, 1);
	t("limit: no more-rounds option left, final approval chosen", [L.status, fd.asked.at(-1)], ["done", "result"]);
}

// ------------------------------------------------------------------ the bricked chess run, replayed
{
	// tests leave bytecode; staged once, it used to come back every round (the developer cannot unstage)
	const repo = makeRepo("pyc");
	const withPyc = ({ cwd }) => { mkdirSync(join(cwd, "__pycache__"), { recursive: true }); writeFileSync(join(cwd, "__pycache__", "m.cpython-314.pyc"), "x"); mkdirSync(join(cwd, "node_modules", "z"), { recursive: true }); writeFileSync(join(cwd, "node_modules", "z", "i.js"), "x"); writeFileSync(join(cwd, "feature.txt"), "feature\n"); return { text: "STATUS: DONE\n## Changes\nfeature.txt", exitCode: 0, input: 1, output: 1, seconds: 0 }; };
	const L = await F.startRun(opts(repo), fakeDeps({ ...OK, build: [withPyc] }));
	t("bytecode and node_modules are never the change: not in the diff, not committed", [L.status, readFileSync(F.diffPath(L), "utf8").includes("pyc"), readFileSync(F.diffPath(L), "utf8").includes("node_modules"), git(L.work, "show", "--name-only", "--format=", "HEAD")], ["done", false, false, "feature.txt"]);
	// the rounds used up: a further round is not offered, and asking for one keeps the checkpoint
	const repo2 = makeRepo("rounds"); let k = 0;
	const fresh = () => ({ text: `VERDICT: REVISE\nD${++k} | major | a | new problem ${k}`, exitCode: 0, input: 1, output: 1, seconds: 0 });
	const R1 = "VERDICT: REVISE\nR1 | major | a.pyc | bytecode tracked";
	const fdn = fakeDeps({ ...OK, build: [build(), build(), build()], "expert-review": [R1, R1, "VERDICT: APPROVE"] }, { decisions: { stuck: [{ action: "more", text: "unstage the bytecode first" }] } });
	await F.startRun(opts(makeRepo("note")), fdn);
	const notes = fdn.calls.filter((c) => c.meta.stage === "build").map((c) => c.brief.findings ?? "");
	t("more with text: the note reaches that round's developer, and only that round", notes.map((f) => f.includes("unstage the bytecode first")), [false, false, true]);
	let asks = 0;
	const fd = fakeDeps({ ...OK, build: [build()], "design-review": [fresh] });
	fd.checkpoint = (orig => async (kind, L) => (kind === "stuck" ? (asks++ === 0 ? { action: "more" } : null) : orig(kind, L)))(fd.checkpoint);
	const L2 = await F.startRun({ ...opts(repo2), id: "rounds-1" }, fd);
	t("the rounds used: the run waits at the stuck checkpoint, not stopped", [L2.status, L2.waiting, L2.rounds], ["waiting", "stuck", 5]);
	t("then only final or stop", [F.decisionsAt("stuck", L2), F.decisionFor("stuck", "more", "", L2)], [["final", "stop"], "the run waits at its stuck checkpoint with its 5 fix rounds used: decision is one of final, stop"]);
	t("approve there is not a further round", typeof F.decisionFor("stuck", "approve", "", L2), "string");
	t("the call offered lists final and stop", F.report(L2, true).includes('decision: "final | stop"'), true);
	// a ledger from before: stopped with "5 fix rounds used", nothing to resume from
	const old = F.loadLedger("rounds-1", root); old.status = "stopped"; old.waiting = null; delete old.stoppedAt; old.pending = null; old.note = "5 fix rounds used"; F.saveLedger(old);
	t("an older stop after the rounds is resumable at the stuck checkpoint", [F.stopKind(F.loadLedger("rounds-1", root)), /Stopped\. To go on, .*"final \| stop"/.test(F.report(F.loadLedger("rounds-1", root), true))], ["stuck", true]);
	const L3 = await F.resumeRun("rounds-1", { ...fakeDeps(OK), checkpoint: F.orchestrated({ action: "final", by: "the orchestrator" }) }, root);
	t("resumed with final: on to the result, waiting there for the caller", [L3.status, L3.waiting], ["waiting", "result"]);
}

// ------------------------------------------------------------------ the judge rejects, the suite fails
{
	const repo = makeRepo("judge");
	const fd = fakeDeps({ ...OK, build: [build(), build()], judge: ["## Verdict\nREJECT\n## Criteria\nC1: PASS\nC2: FAIL a.txt changed\n", "## Verdict\nACCEPT"] });
	const L = await F.startRun(opts(repo), fd);
	const b = fd.calls.filter((c) => c.meta.stage === "build");
	t("judge: REJECT sends the failing criterion back", [b.length, b[1].brief.findings.includes("C2 | blocker | criterion | FAIL a.txt changed")], [2, true]);
	t("judge: back to the judge after the fix, then done", [L.entries.map((e) => e.stage).slice(-3), L.status], [["build", "judge", "regression"], "done"]);
	const repo2 = makeRepo("regress");
	const breakIt = ({ cwd }) => { writeFileSync(join(cwd, "src", "a.txt"), "bad\n"); writeFileSync(join(cwd, "feature.txt"), "f\n"); return { text: "STATUS: DONE", exitCode: 0, input: 1, output: 1, seconds: 0 }; };
	const fixIt = ({ cwd }) => { writeFileSync(join(cwd, "src", "a.txt"), "ok\n"); return { text: "STATUS: DONE", exitCode: 0, input: 1, output: 1, seconds: 0 }; };
	const fd2 = fakeDeps({ ...OK, build: [breakIt, fixIt] });
	const L2 = await F.startRun(opts(repo2), fd2);
	const b2 = fd2.calls.filter((c) => c.meta.stage === "build");
	t("regression: a suite that passed before and fails now is REG1", [b2.length, b2[1].brief.findings.startsWith("Fix these findings of the regression stage")], [2, true]);
	t("regression: then it passes", [L2.entries.filter((e) => e.stage === "regression").map((e) => e.verdict), L2.status], [["FAIL", "PASS"], "done"]);
	const repo3 = makeRepo("red-before");
	const L3 = await F.startRun(opts(repo3, { howToRun: "false" }), fakeDeps({ ...OK, build: [build()] }));
	t("regression: red before the change too is not the change's fault", [L3.entries.at(-1).verdict, L3.status, L3.rounds], ["FAIL (as before the change)", "done", 0]);
}

// ------------------------------------------------------------------ blocked, no verdict, a failed run
{
	const repo = makeRepo("blocked");
	const fd = fakeDeps({ ...OK, build: ["STATUS: BLOCKED\n## Notes\nneeds npm install", build()] }, { decisions: { blocked: { action: "retry" } } });
	const L = await F.startRun(opts(repo), fd);
	t("blocked: the user is asked, the stage runs again", [fd.asked.includes("blocked"), L.status, fd.calls.filter((c) => c.meta.stage === "build").length], [true, "done", 2]);
	const repo2 = makeRepo("ask-noverdict");
	const fd2 = fakeDeps({ ...OK, "expert-review": ["looks good to me"] }, { decisions: { blocked: { action: "stop" } } });
	const L2 = await F.startRun(opts(repo2, { howToRun: "" }), fd2);
	t("no verdict line, no test command: blocked, then stopped", [L2.status, L2.entries.at(-1).verdict, fd2.asked.at(-1)], ["stopped", "NO VERDICT", "blocked"]);
	const repo3 = makeRepo("nochange");
	const L3 = await F.startRun(opts(repo3), fakeDeps({ ...OK, build: ["STATUS: DONE"] }, { decisions: { blocked: { action: "stop" } } }));
	t("DONE without a change in the tree: blocked", [L3.status, L3.entries.at(-1).summary], ["stopped", "no change in the work tree"]);
	const repo4 = makeRepo("throws");
	const L4 = await F.startRun(opts(repo4), fakeDeps({ ...OK, plan: [() => { throw new Error("boom"); }] }, { decisions: { blocked: { action: "stop" } } }));
	t("a stage whose run throws: blocked, not a crash", [L4.status, L4.entries.at(-1).verdict], ["stopped", "FAILED"]);
}

// ------------------------------------------------------------------ no STATUS line, but the headings say it
{
	const repo = makeRepo("nostatus");
	const fd = fakeDeps({ ...OK, plan: ["I have a plan.\n## Plan\n1. add it\n## Risks\nnone"], build: [({ cwd }) => { writeFileSync(join(cwd, "feature.txt"), "x\n"); return { text: "Done.\n## Changes\nfeature.txt", exitCode: 0, input: 1, output: 1, seconds: 0 }; }] });
	const L = await F.startRun(opts(repo), fd);
	t("no STATUS: plan and build taken from their headings", [L.status, L.entries[1].verdict, L.entries[2].verdict, L.plan], ["done", "PLAN (no STATUS line)", "DONE (no STATUS line)", "## Plan\n1. add it\n## Risks\nnone"]);
}

// ------------------------------------------------------------------ checkpoints: edits, stop, and no UI
{
	const repo = makeRepo("edit");
	const fd = fakeDeps({ ...OK, build: [build()] }, { decisions: { criteria: { action: "edit", text: "1. only this\n2. and this" }, plan: { action: "edit", text: "1. my plan" }, result: { action: "keep" } } });
	const L = await F.startRun(opts(repo), fd);
	const b = fd.calls.find((c) => c.meta.stage === "build").brief;
	t("criteria edited by the user reach every stage", [L.criteria, b.criteria, fd.calls.find((c) => c.expert === "acceptance-judge").brief.criteria], [["only this", "and this"], "C1. only this\nC2. and this", "C1. only this\nC2. and this"]);
	t("the plan as the user edited it", b.plan, "1. my plan");
	t("keep uncommitted: nothing committed", [L.status, L.commit, git(L.work, "rev-parse", "HEAD") === L.base, git(L.work, "status", "--porcelain").includes("feature.txt")], ["done", "", true, true]);
	const repo2 = makeRepo("stop-plan");
	const fd2 = fakeDeps(OK, { decisions: { plan: { action: "stop" } } });
	const L2 = await F.startRun(opts(repo2), fd2);
	t("stop at the plan: the developer never builds", [L2.status, fd2.calls.map((c) => c.meta.stage)], ["stopped", ["plan"]]);
	const repo3 = makeRepo("stop-result");
	const L3 = await F.startRun(opts(repo3), fakeDeps({ ...OK, build: [build()] }, { decisions: { result: { action: "stop" } } }));
	t("stop at the result: nothing committed", [L3.status, L3.commit, git(L3.work, "rev-parse", "HEAD") === L3.base], ["stopped", "", true]);
}

// ------------------------------------------------------------------ no UI: pause at each checkpoint; resume
{
	const repo = makeRepo("resume");
	const noUI = (deps) => Object.assign(deps, { checkpoint: async (k) => { deps.asked.push(k); return null; } });
	const d1 = noUI(fakeDeps(OK));
	let L = await F.startRun(opts(repo), d1);
	t("no UI: paused at the criteria", [L.status, L.waiting, d1.calls.length], ["waiting", "criteria", 0]);
	t("no UI: the ledger says so", [F.loadLedger(L.id, root).status, F.loadLedger(L.id, root).waiting], ["waiting", "criteria"]);
	L = await F.resumeRun(L.id, noUI(fakeDeps(OK)), root);
	t("resume, still no UI: still waiting, nothing ran", [L.status, L.waiting, L.entries.length], ["waiting", "criteria", 1]);
	const d2 = fakeDeps(OK, { decisions: { plan: [] } }); d2.checkpoint = async (k) => { d2.asked.push(k); return k === "criteria" ? { action: "approve" } : null; };
	L = await F.resumeRun(L.id, d2, root);
	t("resume: on to the plan, paused there", [L.waiting, d2.calls.map((c) => c.meta.stage)], ["plan", ["plan"]]);
	const d3 = fakeDeps({ ...OK, build: [build()] }, { decisions: {} }); d3.checkpoint = async (k) => { d3.asked.push(k); return k === "result" ? null : { action: "approve" }; };
	L = await F.resumeRun(L.id, d3, root);
	t("resume: from the plan to the final approval, no stage twice", [L.waiting, d3.calls.map((c) => c.meta.stage)], ["result", ["build", "expert-review", "design-review", "judge"]]);
	// interrupted in the middle of a stage (the process died): the stage runs again
	const saved = F.loadLedger(L.id, root); saved.status = "running"; saved.waiting = null; saved.stage = "judge"; F.saveLedger(saved);
	const d4 = fakeDeps(OK);
	L = await F.resumeRun(L.id, d4, root);
	t("resume after a crash mid-stage: that stage again, then on", [d4.calls.map((c) => c.meta.stage), L.status, L.commit.length], [["judge"], "done", 40]);
	t("resume: a finished run stays finished", (await F.resumeRun(L.id, fakeDeps(OK), root)).status, "done");
	let err = ""; try { await F.resumeRun("nope", fakeDeps(OK), root); } catch (e) { err = e.message; }
	t("resume: an unknown run", err, "no factory run nope");
}

// ------------------------------------------------------------------ briefs come from the ledger only
{
	const repo = makeRepo("leak");
	const fd = fakeDeps({ ...OK, build: [build()], "expert-review": ["VERDICT: REVISE\nR1 | major | a | x", "VERDICT: APPROVE"], test: ["VERDICT: APPROVE"] }, { available: (n) => n === "tester" });
	const L = await F.startRun(opts(repo), fd);
	t("tester runs where it is usable, with the verdict line asked for", [fd.calls.some((c) => c.expert === "tester"), fd.calls.find((c) => c.expert === "tester").brief.report.startsWith("Start your final message with the line VERDICT:")], [true, true]);
	// every value of every brief is made of the ledger's own artifacts
	const sources = [L.ticket, ...L.criteria, L.plan, L.claim, L.repo, L.work, L.base, L.branch, L.howToRun, F.diffPath(L), "R1 | major | a | x"];
	const strayWords = new Set();
	for (const c of fd.calls) for (const v of Object.values(c.brief)) for (const w0 of String(v).split(/[^A-Za-z0-9_.-]+/)) { const w = w0.replace(/[.]+$/, ""); if (w.length > 3 && !sources.some((s) => s.includes(w)) && !F.briefFor.toString().includes(w)) strayWords.add(w); }
	t("no brief carries a word from outside the ledger and the engine's own text", [...strayWords], []);
	t("the plan stage sees no plan, no findings, no diff", Object.keys(fd.calls[0].brief).sort(), ["constraints", "criteria", "how_to_run", "mode", "task", "workspace"]);
}

// ------------------------------------------------------------------ the command, in a fake session
{
	process.env.LETS_CODE_EXPERTS_ON = "1"; process.env.LETS_CODE_SUBAGENTS_ON = "1";
	const repo = makeRepo("session");
	const ext = join(work, "session-ext"); mkdirSync(ext);
	// fake subagents and experts modules next to a copy of factory.ts
	writeFileSync(join(ext, "subagents.ts"), `
export const runs = [];
const reg = { view: {} }; export function registry() { return reg; } export function viewState(r) { return r.view; }
export const busySeen = [];
export function discoverExperts() { return ["developer", "expert-reviewer", "design-reviewer", "acceptance-judge"].map((name) => ({ name, expert: { ready: true, brief: [] } })); }
export async function runAgent(agent, task, cwd, signal, onProgress, meta) {
	runs.push({ agent: agent.name, task, cwd, meta }); busySeen.push(!!reg.view.mainBusy);
	const fs = await import("node:fs"); const path = await import("node:path");
	const stage = meta && meta.index;
	let text = "VERDICT: APPROVE";
	if (agent.name === "developer") { if (/Mode\\nplan/.test(task)) text = "STATUS: PLAN\\n## Plan\\n1. x"; else { fs.writeFileSync(path.join(cwd, "feature.txt"), "f\\n"); text = "STATUS: DONE\\n## Changes\\nfeature.txt"; } }
	if (agent.name === "acceptance-judge") text = "## Verdict\\nACCEPT";
	return { text, exitCode: 0, input: 5, output: 1, turns: 1 };
}
`);
	writeFileSync(join(ext, "experts.ts"), `
let on = {};
export function remembered() { return on; }
export function remember(n, v) { on[n] = v; }
export function renderBrief(s, b) { return "Brief for the " + s.name + " expert.\\n\\n" + Object.entries(b).map(([k, v]) => "## " + k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + "\\n" + v).join("\\n\\n"); }
`);
	writeFileSync(join(ext, "factory.ts"), src);
	const fm = await import(pathToFileURL(join(ext, "factory.ts")).href);
	const cmds = {}; const pi = { registerCommand: (n, o) => { cmds[n] = o; }, on: () => {}, registerTool: () => { throw new Error("no tool"); } };
	const hooks = []; pi.on = (e) => hooks.push(e);
	delete process.env.LETS_CODE_EXPERTS_ON; fm.default(pi);
	t("session: experts off, no command", Object.keys(cmds), []);
	process.env.LETS_CODE_EXPERTS_ON = "1"; process.env.LETS_CODE_SUBAGENT_DEPTH = "1"; fm.default(pi);
	t("session: none in a child", Object.keys(cmds), []);
	delete process.env.LETS_CODE_SUBAGENT_DEPTH; fm.default(pi);
	t("session: the /factory command, no tool, no hook (nothing in context)", [typeof cmds.factory?.handler, hooks], ["function", []]);
	t("session: completions", [cmds.factory.getArgumentCompletions("st").map((c) => c.value), cmds.factory.getArgumentCompletions("start x")], [["start", "status"], null]);
	const notes = []; const selects = [];
	const ui = { notify: (m) => notes.push(m), setStatus: () => {}, confirm: async () => true, editor: async (_t, p) => p,
		select: async (title, options) => { selects.push(title.split("\n")[0]); return options[0]; } };
	writeFileSync(join(repo, "notes.md"), SECRET);
	const ctx = { cwd: repo, hasUI: true, ui, sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: SECRET } }], getBranch: () => [] }, signal: undefined };
	// the mandate's hook: a run puts the main session in orchestrator mode
	const engaged = []; globalThis.__letsCodeOrchestrate = (c, why) => { engaged.push([c === ctx, why]); return true; };
	await cmds.factory.handler("start TICKET.md grep -q ok src/a.txt", ctx);
	t("session: /factory start engages the orchestrator", engaged, [[true, "factory run"]]);
	const sub = await import(pathToFileURL(join(ext, "subagents.ts")).href);
	t("session: stages through the subagents runner", sub.runs.map((r) => r.agent), ["developer", "developer", "expert-reviewer", "design-reviewer", "acceptance-judge"]);
	t("session: runs tagged for /subagents", [...new Set(sub.runs.map((r) => r.meta.tool))], ["factory"]);
	t("session: the session counts as working during the run (switching shows a stage in place), not after", [[...new Set(sub.busySeen)], !!sub.viewState(sub.registry()).mainBusy], [[true], false]);
	t("session: the conversation reaches no stage", sub.runs.some((r) => r.task.includes(SECRET)), false);
	t("session: the experts' yes asked once, remembered", (await import(pathToFileURL(join(ext, "experts.ts")).href)).remembered()["developer"], true);
	t("session: the checkpoints as dialogs", selects.map((s) => s.replace(/^Factory \S+: /, "")), ["acceptance criteria", "the developer's plan", "the result"]);
	t("session: the user sees the stage summary", [notes.length, notes.at(-1).startsWith("factory run "), notes.at(-1).includes("committed")], [1, true, true]);
	const said = async (args, c = ctx) => { const got = []; await cmds.factory.handler(args, { ...c, ui: { ...ui, notify: (m) => got.push(m) } }); return got.join("\n"); };
	const lastId = F.listRuns().length ? (await said("list")).split("\n")[0].split(/\s+/)[0] : "";
	t("session: /factory list, newest first", [/^\d{8}-\d{6}-[0-9a-f]{4}  done, committed/.test(await said("list"))], [true]);
	t("session: /factory status (newest)", (await said("status")).includes("The change is committed on pi/factory-"), true);
	t("session: /factory status <id>", (await said(`status ${lastId}`)).startsWith(`factory run ${lastId}: done`), true);
	t("session: /factory status of an unknown run", await said("status nope"), "No factory run nope.");
	t("session: /factory with a bad verb: usage", (await said("frobnicate")).startsWith("Usage: /factory start"), true);
	t("session: /factory start without a file", await said("start missing.md"), "No ticket file missing.md.");
	engaged.length = 0; await said("resume nope");
	t("session: /factory resume engages it too", engaged.map((e) => e[1]), ["factory run resumed"]);
	t("session: resume completions offer waiting runs", Array.isArray(cmds.factory.getArgumentCompletions("resume ")), true);
	// without a UI: the run waits at the criteria and says how to go on
	const out = []; const log = console.log; console.log = (m) => out.push(m);
	const ctx2 = { cwd: repo, hasUI: false, sessionManager: ctx.sessionManager };
	await cmds.factory.handler("run TICKET.md", ctx2);
	console.log = log;
	t("session, no UI: waits at the criteria and says how to go on", [/waiting for the user: criteria/.test(out.join("\n")), /\/factory resume \S+ asks it/.test(out.join("\n"))], [true, true]);
	// the expert's entry: runExpert, as the experts module calls it for runner: factory
	sub.runs.length = 0; selects.length = 0;
	// the orchestrator decides the checkpoints: the run comes back at each, with what to decide
	const idOf = (r) => /resume: "([^"]+)"/.exec(r.text)?.[1];
	const r1 = await fm.runExpert({ ticket: "TICKET.md", how_to_run: "grep -q ok src/a.txt", start: "python3 -m http.server 8123", constraints: "leave README.md alone" }, ctx, undefined, () => {}, "call-77");
	t("expert: the run engages the orchestrator, and the model is told", [engaged.at(-1)?.[1], r1.text.endsWith(F.ORCHESTRATING)], ["software factory run", true]);
	t("expert: the criteria it wrote are confirmed for it; the plan comes back to it, not to a dialog", [r1.isError, /waits at its plan checkpoint, for you to decide/.test(r1.text), r1.text.includes("## Plan") || r1.text.includes("1. "), selects.length], [false, true, true, 0]);
	t("expert: with the call that goes on, and when to ask the user", [!!idOf(r1), r1.text.includes('decision: "approve | edit | stop"'), /only for a significant design decision/.test(r1.text)], [true, true, true]);
	t("expert: a ticket given as a path is read", sub.runs[0].task.includes("feature.txt exists"), true);
	const r1b = await fm.runExpert({ resume: idOf(r1), decision: "approve" }, ctx, undefined, () => {}, "call-77");
	t("expert: resume with approve builds, reviews, judges; a green result is committed on its branch", [r1b.isError, /waits at its result checkpoint/.test(r1b.text), /done, committed/.test(r1b.text), selects.length], [false, false, true, 0]);
	const r1c = await fm.runExpert({ resume: idOf(r1), decision: "approve" }, ctx, undefined, () => {}, "call-77");
	t("expert: the commit is on the run's branch only", [/done, committed/.test(r1c.text), /pushing, merging or a PR is up to the user/.test(r1c.text)], [true, true]);
	t("expert: its stage runs carry the tool call's id (for /subagents and detaching)", [...new Set(sub.runs.map((r) => r.meta.callId))], ["call-77"]);
	t("expert: constraints reach the stages", sub.runs.every((r) => r.task.includes("leave README.md alone")), true);
	t("expert: the result is stage summaries, not stage output", [r1c.text.includes("## Changes"), r1c.text.split("\n").filter((l) => l.startsWith("- ")).length >= 7], [false, true]);
	const r1d = await fm.runExpert({ resume: idOf(r1), decision: "approve" }, ctx);
	t("expert: a done run is reported, nothing runs", [r1d.isError, /done, committed/.test(r1d.text)], [false, true]);
	sub.runs.length = 0;
	const r2 = await fm.runExpert({ ticket: "# T-9: a thing\n## Acceptance criteria\n1. feature.txt exists" }, ctx, undefined, () => {}, "call-78");
	t("expert: a ticket given as text", [r2.isError, sub.runs[0].task.includes("T-9: a thing")], [false, true]);
	t("expert: each run that engages it says so", r2.text.includes(F.ORCHESTRATING), true);
	globalThis.__letsCodeOrchestrate = () => false;
	const r2b = await fm.runExpert({ ticket: "# T-10\n## Acceptance criteria\n1. feature.txt exists" }, ctx, undefined, () => {}, "call-79");
	t("expert: already orchestrating: no line", r2b.text.includes(F.ORCHESTRATING), false);
	delete globalThis.__letsCodeOrchestrate;
	const r3 = await fm.runExpert({ ticket: "  " }, ctx);
	t("expert: no ticket, nothing runs", [r3.isError, r3.text.startsWith("Nothing ran")], [true, true]);
	const r4 = await fm.runExpert({ ticket: "TICKET.md" }, { cwd: repo, hasUI: false });
	t("expert, no UI: the same, it needs none", [r4.isError, /waits at its plan checkpoint/.test(r4.text)], [false, true]);
	const id4 = idOf(r4);
	const bad = await fm.runExpert({ resume: id4, decision: "commit" }, ctx);
	t("expert: a decision the checkpoint does not take", [bad.isError, /decision is one of approve, edit, stop/.test(bad.text)], [true, true]);
	const noText = await fm.runExpert({ resume: id4, decision: "edit" }, ctx);
	t("expert: edit needs the text", [noText.isError, /edit needs text/.test(noText.text)], [true, true]);
	t("expert: resume of a run that does not exist", (await fm.runExpert({ resume: "nope" }, ctx)).text, "Nothing ran: no factory run nope.");
	const st = await fm.runExpert({ resume: id4, decision: "stop" }, ctx);
	t("expert: stopped by the orchestrator, and how to go on", [/stopped: the orchestrator stopped it at the plan checkpoint/.test(st.text), st.text.includes(`resume: "${id4}"`)], [true, true]);
	const again = await fm.runExpert({ resume: id4, decision: "edit", text: "## Plan\n1. add feature.txt with the word feature" }, ctx);
	t("expert: a stopped run goes on from the checkpoint it stopped at, with the edited plan", [again.isError, /waits at its result checkpoint/.test(again.text), F.loadLedger(id4).plan], [false, true, "## Plan\n1. add feature.txt with the word feature"]);
	mkdirSync(join(work, "not-a-repo"), { recursive: true }); writeFileSync(join(work, "not-a-repo", "x.txt"), "x");
	const r5 = await fm.runExpert({ ticket: "TICKET.md", repo: join(work, "not-a-repo") }, ctx);
	t("expert: a repo that is not one", [r5.isError, /could not run: .*not a git repository/.test(r5.text)], [true, true]);
	const r7 = await fm.runExpert({ ticket: "TICKET.md", repo: `${repo} (the repo; already set up)` }, ctx);
	t("expert: a remark after the repo path is dropped", [/waits at its plan checkpoint/.test(r7.text), existsSync(`${repo} (the repo; already set up)`)], [true, false]);
	// the user's own /factory: a stop in a dialog, and /factory resume asks that checkpoint again
	const stopUi = { ...ui, select: async (title, options) => (title.includes("plan") ? "Stop" : options[0]) };
	const out6 = []; await cmds.factory.handler("start TICKET.md", { ...ctx, ui: { ...stopUi, notify: (m) => out6.push(m) } });
	t("session: stopped by the user in a dialog is reported as such", [/stopped: the user stopped it at the plan checkpoint/.test(out6.join("\n")), /\/factory resume \S+ asks the plan checkpoint again/.test(out6.join("\n"))], [true, true]);
	const id6 = /factory run (\S+):/.exec(out6.join("\n"))?.[1];
	const out6b = []; await cmds.factory.handler(`resume ${id6}`, { ...ctx, ui: { ...ui, notify: (m) => out6b.push(m) } });
	// a ledger from before stoppedAt: the stop is in its note only
	{ const L = F.loadLedger(id4); L.status = "stopped"; L.waiting = null; delete L.stoppedAt; L.note = "the user stopped it at the result checkpoint"; F.saveLedger(L); }
	const old = await fm.runExpert({ resume: id4, decision: "keep" }, ctx);
	t("expert: an older ledger's stop is resumed from its note", [old.isError, /left uncommitted/.test(old.text)], [false, true]);
	t("session: /factory resume of a stopped run goes on from there", /done, committed/.test(out6b.join("\n")), true);
}

// ------------------------------------------------------------------ ids: never one a run or a branch already has
{
	const repo = makeRepo("ids"); const realRandom = Math.random; const t0 = Date.UTC(2026, 0, 2, 3, 4, 5);
	const same = { ...fakeDeps(OK, { decisions: { criteria: { action: "stop" } } }), now: () => t0 };
	Math.random = () => 0.5;   // every candidate id the same, until the third
	let calls = 0; Math.random = () => (++calls <= 2 ? 0.5 : 0.25);
	const a = await F.startRun(opts(repo), same);
	calls = 0; const b = await F.startRun(opts(repo), same);
	Math.random = realRandom;
	t("ids: a second run in the same second gets another id and branch", [a.id !== b.id, a.branch !== b.branch, /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(b.id)], [true, true, true]);
	t("ids: both worktrees exist", [existsSync(a.work), existsSync(b.work)], [true, true]);
}

// ------------------------------------------------------------------ the tester gets how to start the app
{
	const repo = makeRepo("start");
	const fd = fakeDeps({ ...OK, build: [build()], test: ["VERDICT: APPROVE"] }, { available: (n) => n === "tester" });
	await F.startRun(opts(repo, { start: "python3 -m http.server 8123" }), fd);
	t("tester: tests and the app's start command", fd.calls.find((c) => c.expert === "tester").brief.how_to_run, "Tests: grep -q ok src/a.txt\nStart the app: python3 -m http.server 8123");
}

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
