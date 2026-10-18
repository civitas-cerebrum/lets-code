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
	const repo2 = makeRepo("noverdict");
	const fd2 = fakeDeps({ ...OK, "expert-review": ["looks good to me"] }, { decisions: { blocked: { action: "stop" } } });
	const L2 = await F.startRun(opts(repo2), fd2);
	t("no verdict line: blocked, then stopped", [L2.status, L2.entries.at(-1).verdict, fd2.asked.at(-1)], ["stopped", "NO VERDICT", "blocked"]);
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
	const sources = [L.ticket, ...L.criteria, L.plan, L.claim, L.work, L.base, L.branch, L.howToRun, F.diffPath(L), "R1 | major | a | x"];
	const strayWords = new Set();
	for (const c of fd.calls) for (const v of Object.values(c.brief)) for (const w0 of String(v).split(/[^A-Za-z0-9_.-]+/)) { const w = w0.replace(/[.]+$/, ""); if (w.length > 3 && !sources.some((s) => s.includes(w)) && !F.briefFor.toString().includes(w)) strayWords.add(w); }
	t("no brief carries a word from outside the ledger and the engine's own text", [...strayWords], []);
	t("the plan stage sees no plan, no findings, no diff", Object.keys(fd.calls[0].brief).sort(), ["constraints", "criteria", "how_to_run", "mode", "task"]);
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
	await cmds.factory.handler("start TICKET.md grep -q ok src/a.txt", ctx);
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
	t("session: resume completions offer waiting runs", Array.isArray(cmds.factory.getArgumentCompletions("resume ")), true);
	// without a UI: the run waits at the criteria and says how to go on
	const out = []; const log = console.log; console.log = (m) => out.push(m);
	const ctx2 = { cwd: repo, hasUI: false, sessionManager: ctx.sessionManager };
	await cmds.factory.handler("run TICKET.md", ctx2);
	console.log = log;
	t("session, no UI: waits at the criteria and says how to go on", [/waiting for the user: criteria/.test(out.join("\n")), /\/factory resume \S+ asks it/.test(out.join("\n"))], [true, true]);
	// the expert's entry: runExpert, as the experts module calls it for runner: factory
	sub.runs.length = 0; selects.length = 0;
	const r1 = await fm.runExpert({ ticket: "TICKET.md", how_to_run: "grep -q ok src/a.txt", start: "python3 -m http.server 8123", constraints: "leave README.md alone" }, ctx, undefined, () => {}, "call-77");
	t("expert: a ticket given as a path is read", [r1.isError, /done, committed/.test(r1.text), sub.runs[0].task.includes("isFreeShipping") || sub.runs[0].task.includes("feature.txt exists")], [false, true, true]);
	t("expert: its stage runs carry the tool call's id (for /subagents and detaching)", [...new Set(sub.runs.map((r) => r.meta.callId))], ["call-77"]);
	t("expert: constraints reach the stages", sub.runs.every((r) => r.task.includes("leave README.md alone")), true);
	t("expert: the result is stage summaries, not stage output", [r1.text.includes("## Changes"), r1.text.split("\n").filter((l) => l.startsWith("- ")).length >= 7], [false, true]);
	sub.runs.length = 0;
	const r2 = await fm.runExpert({ ticket: "# T-9: a thing\n## Acceptance criteria\n1. feature.txt exists" }, ctx, undefined, () => {}, "call-78");
	t("expert: a ticket given as text", [r2.isError, sub.runs[0].task.includes("T-9: a thing")], [false, true]);
	const r3 = await fm.runExpert({ ticket: "  " }, ctx);
	t("expert: no ticket, nothing runs", [r3.isError, r3.text.startsWith("Nothing ran")], [true, true]);
	const r4 = await fm.runExpert({ ticket: "TICKET.md" }, { cwd: repo, hasUI: false });
	t("expert, no UI: it waits and says how to go on", [r4.isError, /waiting for the user: criteria/.test(r4.text), /\/factory resume/.test(r4.text)], [false, true, true]);
	const r5 = await fm.runExpert({ ticket: "TICKET.md", repo: join(work, "not-a-repo") }, ctx);
	t("expert: a repo that is not one", [r5.isError, /could not run: .*not a git repository/.test(r5.text)], [true, true]);
	const stopUi = { ...ui, select: async (title, options) => (title.includes("plan") ? "Stop" : options[0]) };
	const r6 = await fm.runExpert({ ticket: "TICKET.md" }, { ...ctx, ui: stopUi });
	t("expert: stopped by the user is reported as such", [r6.isError, /stopped: the user stopped it at the plan checkpoint/.test(r6.text), /\/factory resume/.test(r6.text)], [true, true, true]);
	if (!/stopped: the user stopped it at the plan checkpoint/.test(r6.text)) console.log(`  (its report: ${r6.text.slice(0, 600)})`);
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
