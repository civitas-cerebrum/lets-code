#!/usr/bin/env node
// Unit test for the expert builder's helpers against lets-code itself:
// expert-lint must read a file the way the subagents module's parseAgentFile
// does (same fields, same brief, same files rejected), and route-check's
// pure parts (the prompts file, the decision on pi's event stream, the
// scores). The helpers come from pi_write_expert_builder in ./lets-code,
// the parser from the subagents module next to the experts module.
//
//   tests/expert-lint.test.mjs [path/to/lets-code/experts.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/experts.ts");
const subPath = join(dirname(extPath), "subagents.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "expert-lint-test-")));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const agentDir = join(work, "agent"); mkdirSync(join(agentDir, "agents"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

// the helpers, written by lets-code's own writer
execFileSync("bash", ["-c", `set -e; eval "$(python3 - "$1" <<'PY'
import sys
s = open(sys.argv[1]).read()
end = "\\n}  # end of pi_write_expert_builder\\n"
i = s.find("\\npi_write_expert_builder() {")
sys.stdout.write(s[i:s.find(end, i) + len(end)])
PY
)"; PI_AGENT_DIR="$2"; pi_write_expert_builder`, "x", join(here, "..", "lets-code"), agentDir], { stdio: "inherit" });
const require = createRequire(import.meta.url);
const lint = require(join(agentDir, "expert-builder", "bin", "expert-lint"));
const rc = require(join(agentDir, "expert-builder", "bin", "route-check"));

// the parser: subagents.ts, with typebox from the pi host or a stub (CI)
const ext = join(work, "ext"); mkdirSync(ext);
{
	let piRoot = "";
	try { piRoot = join(execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "@earendil-works", "pi-coding-agent"); } catch { /* no npm */ }
	const tb = piRoot ? [join(piRoot, "node_modules", "typebox"), join(piRoot, "..", "..", "typebox")].find((p) => existsSync(p)) : undefined;
	const nm = join(ext, "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	if (tb) { rmSync(nm, { recursive: true }); symlinkSync(tb, nm); }
	else {
		writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
		writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }), Number: (o) => ({ type: 'number', ...o }), Boolean: (o) => ({ type: 'boolean', ...o }), Union: (x) => ({ anyOf: x }), Literal: (v) => ({ const: v }) };\n");
	}
}
writeFileSync(join(ext, "subagents.ts"), readFileSync(subPath, "utf8").replace(/^import type .*$/m, ""));
const sub = await import(pathToFileURL(join(ext, "subagents.ts")).href);

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

// ------------------------------------------------------------- parity
const base = { name: "conf", description: "Converts config files", tools: "bash, read", expert: "true", use_for: "converting and validating JSON, YAML and TOML config files", keywords: "config files" };
const file = (fm, extra = "", body = "You convert.") => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n${extra}---\n${body}\n`;
const cases = {
	"a good one": file(base, "brief:\n  - file (required): the path\n  - to: the format\n"),
	"no brief": file(base),
	"quoted values": file({ ...base, use_for: '"converting: JSON, YAML"', keywords: "'config'" }, "brief:\n  - \"file (required): the path\"\n"),
	"a folded job": file(base, "job: >\n  Converts a file\n  and checks it\n"),
	"a block list of tools": file({ ...base, tools: "" }, "tools:\n  - bash\n  - read\nbrief:\n  - file (required): x\n"),
	"a bad brief item": file(base, "brief:\n  - file the path\n"),
	"a brief field twice": file(base, "brief:\n  - file (required): a\n  - file: b\n"),
	"a bad name": file({ ...base, name: "-conf" }),
	"a path outside": file({ ...base, append_prompt: "../../outside.md" }),
	"a bad timeout": file({ ...base, timeout: "10m" }),
	"a bad requires_env": file({ ...base, requires_env: "A-B" }),
	"use_for over 100": file({ ...base, use_for: "x".repeat(120) }),
	"keywords over 40": file({ ...base, keywords: "k".repeat(50) }),
	"a dispatch rule": file({ ...base, dispatch_rule: "Config conversions go to expert conf." }),
	"dispatch_rule over 300": file({ ...base, dispatch_rule: "r".repeat(320) }),
	"not an expert": file({ ...base, expert: "false" }),
	"route false": file({ ...base, route: "false" }),
	"route no": file({ ...base, route: "no" }),
	"route true": file({ ...base, route: "true" }),
	"runner factory": file({ ...base, runner: "factory" }),
	"an unknown runner": file({ ...base, runner: "rocket" }),
};
// lint's rejecting rules: the ones that make parseAgentFile drop the file
const REJECT = /^(name: "|brief: "|brief: field|append_prompt: .* outside|timeout:|requires_env:|expert:|runner:)/;
for (const [label, text] of Object.entries(cases)) {
	const f = join(agentDir, "agents", "conf.md"); writeFileSync(f, text);
	const a = sub.parseAgentFile(text, f, "user", undefined, false, true);
	const R = lint.lintFile(f, { agentDir });
	const p = lint.parseFrontmatter(text);
	t(`${label}: rejected alike`, R.errors.some((e) => REJECT.test(e)), !a?.expert);
	if (!a?.expert) continue;
	const b = lint.parseBrief(p.items.brief);
	t(`${label}: same brief`, b.fields.length ? b.fields : [{ name: "task", required: true, hint: "the whole task, standing alone" }], a.expert.brief);
	t(`${label}: same use_for`, (p.fm.use_for || "").replace(/\s+/g, " ").trim().slice(0, 100), a.expert.useFor ?? "");
	t(`${label}: same keywords`, (p.fm.keywords || "").replace(/\s+/g, " ").trim().slice(0, 40), a.expert.keywords ?? "");
	t(`${label}: same dispatch_rule`, (p.fm.dispatch_rule || "").replace(/\s+/g, " ").trim().slice(0, 300), a.expert.dispatchRule ?? "");
	t(`${label}: same job`, (p.fm.job || p.fm.description).replace(/\s+/g, " ").trim(), a.expert.job);
	t(`${label}: same tools`, (p.fm.tools ? p.fm.tools.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean) : undefined), a.tools);
	t(`${label}: same route`, !!R.routed, a.expert.routed);
	t(`${label}: same runner`, p.fm.runner || undefined, a.expert.runner);
}
t("lint: over 100 is an error", lint.lintFile((writeFileSync(join(agentDir, "agents", "conf.md"), cases["use_for over 100"]), join(agentDir, "agents", "conf.md")), { agentDir }).errors.some((e) => e.startsWith("use_for: 120 characters")), true);
{
	const f = join(agentDir, "agents", "conf.md");
	writeFileSync(f, cases["dispatch_rule over 300"]);
	t("lint: dispatch_rule over 300 is an error", lint.lintFile(f, { agentDir }).errors.some((e) => e.startsWith("dispatch_rule: 320 characters")), true);
	writeFileSync(f, cases["a dispatch rule"]);
	const R = lint.lintFile(f, { agentDir });
	t("lint: dispatch_rule is a known field", R.warnings.some((w) => w.includes("unknown field dispatch_rule")), false);
	t("lint: dispatch_rule kept for its cost", R.rule, "Config conversions go to expert conf.");
	writeFileSync(f, cases["route false"]); const RR = lint.lintFile(f, { agentDir });
	t("lint: route false is noted, no warning", [RR.notes.some((x) => x.startsWith("route: false")), RR.warnings.filter((w) => w.startsWith("route")).length, RR.errors.length], [true, 0, 0]);
	writeFileSync(f, file({ ...base, route: "maybe" }));
	t("lint: a bad route value is an error", lint.lintFile(f, { agentDir }).errors.some((e) => e.startsWith("route: maybe")), true);
}
t("lint: pi's tools are the runner's", lint.PI_TOOLS.slice().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
{
	// overlap: only between experts the model routes to by itself
	const f = join(agentDir, "agents", "conf.md"), g = join(agentDir, "agents", "conf2.md");
	writeFileSync(f, file({ ...base, use_for: "converting and validating config files: YAML, TOML, JSON" }));
	writeFileSync(g, file({ ...base, name: "conf2", use_for: "converting and validating config files between formats" }));
	t("lint: two routed experts that overlap: a warning", lint.lintFile(f, { agentDir }).warnings.some((w) => w.startsWith("overlap: expert conf2")), true);
	writeFileSync(g, file({ ...base, name: "conf2", route: "false", use_for: "converting and validating config files between formats" }));
	t("lint: one of them not routed (a lead's specialist): none", [lint.lintFile(f, { agentDir }).warnings.some((w) => w.startsWith("overlap")), lint.lintFile(g, { agentDir }).warnings.some((w) => w.startsWith("overlap"))], [false, false]);
	rmSync(g);
	// a team: the expert tool allowed with it, the names checked, the tool required
	writeFileSync(f, file({ ...base, tools: "read, bash, expert", team: "ui-tester, api-tester" }));
	const T = lint.lintFile(f, { agentDir });
	t("lint: team is known, expert allowed with it, noted", [T.warnings.some((w) => w.includes("unknown field team")), T.errors.length, T.notes.some((x) => x.startsWith("team: ui-tester, api-tester"))], [false, 0, true]);
	writeFileSync(f, file({ ...base, tools: "read, bash, expert" }));
	t("lint: expert without a team is an error", lint.lintFile(f, { agentDir }).errors.some((e) => e.startsWith("tools: expert")), true);
	writeFileSync(f, file({ ...base, tools: "read, bash", team: "ui-tester" }));
	t("lint: a team without the expert tool is an error", lint.lintFile(f, { agentDir }).errors.some((e) => e.startsWith("team: a team needs the expert tool")), true);
}
rmSync(join(agentDir, "agents", "conf.md"));

// the built-ins lets-code ships parse as experts with the parser, and lint has their entries
for (const name of ["expert-builder"]) {
	const f = join(agentDir, "agents", `${name}.md`); const a = sub.parseAgentFile(readFileSync(f, "utf8"), f, "user", undefined, false, true);
	t(`${name}: an expert`, !!a?.expert, true);
	t(`${name}: ready (no setup)`, a?.expert?.ready, true);
	t(`${name}: discovered`, sub.discoverExperts().map((x) => x.name).includes(name), true);
	t(`${name}: lint's entry is the line's`, lint.lintFile(f, { builtin: true }).entry, `${name} (${a.expert.useFor})`);
}

// ------------------------------------------------------------- route-check
const P = rc.parsePrompts("# c\n+ convert a.yaml\n\n-   explain YAML\n=tester check the form\n");
t("prompts: kinds", P.map((p) => p.kind), ["pos", "neg", "other"]);
t("prompts: text and want", [P[1].prompt, P[2].want, P[2].prompt], ["explain YAML", "tester", "check the form"]);
let bad = ""; try { rc.parsePrompts("convert it\n"); } catch (e) { bad = e.message; }
t("prompts: a bare line is an error", bad.startsWith("line 1:"), true);
const play = (evs, maxOwn = 8) => { let s = rc.fresh(); for (const e of evs) s = rc.step(s, e, { maxOwn }); return rc.finish(s, "end"); };
const call = (toolName, args = {}) => ({ type: "tool_execution_start", toolName, args });
const use = (input, output) => ({ type: "message_end", message: { role: "assistant", usage: { input, output } } });
let s = play([use(10, 2), call("ls"), call("expert", { action: "list" }), use(5, 1), call("expert", { action: "run", name: "conf" }), call("bash")]);
t("step: run after a list", [s.verdict, s.routed, s.own, s.lists, s.input, s.output], ["expert", "conf", 1, 1, 15, 3]);
t("step: enable counts", play([call("expert", { action: "enable", name: "tester" })]).routed, "tester");
t("step: runs:[..]", play([call("expert", { action: "run", runs: [{ name: "a" }, { name: "b" }] })]).all, ["a", "b"]);
t("step: a subagent", play([call("subagent", { agent: "scout" })]).routed, "subagent:scout");
t("step: a write is own", [play([call("read"), call("write")]).verdict, play([call("read"), call("write")]).why], ["own", "its own write"]);
t("step: max own", play([call("bash"), call("bash"), call("bash")], 3).why, "3 tool calls of its own");
t("step: an answer", play([use(1, 1)]).why, "answered without tools");
t("step: nothing after the decision", play([call("expert", { action: "run", name: "conf" }), use(100, 100)]).input, 0);
const R = [
	{ kind: "pos", verdict: "expert", routed: "conf", input: 1, output: 1, seconds: 1 },
	{ kind: "pos", verdict: "own", routed: "", input: 1, output: 1, seconds: 1 },
	{ kind: "neg", verdict: "expert", routed: "conf", input: 1, output: 1, seconds: 1 },
	{ kind: "neg", verdict: "expert", routed: "tester", input: 1, output: 1, seconds: 1 },
	{ kind: "other", want: "tester", verdict: "expert", routed: "tester", input: 1, output: 1, seconds: 1 },
];
const sc = rc.score(R, "conf");
t("score: recall, false triggers, precision", [sc.recall, sc.falseTriggers, sc.precision, sc.othersKept, sc.otherExpertOnNegatives], [[1, 2], [1, 3], 0.5, [1, 1], 1]);
t("score: the line", rc.summaryLine(sc), "route-check: conf: recall 1/2, false triggers 1/3, precision 50%, other experts kept 1/1, near-misses sent to another expert 1; 5 s, tokens in 5 out 5");
t("score: no route, no precision", rc.score([{ kind: "pos", verdict: "own", input: 0, output: 0, seconds: 0 }], "conf").precision, null);
t("scrub: lets-code's session vars", ["LETS_CODE_SUBAGENT_DEPTH", "LETS_CODE_EXPERTS_ON", "LETS_CODE_ROLE", "LETS_CODE_MODE", "LETS_CODE_ENDPOINTS", "LETS_CODE_TOKEN", "LETS_CODE_LAUNCHER"].map((k) => rc.SCRUB.test(k)), [true, true, true, true, false, false, false]);

console.log(`\n${n} checks${fail ? ", FAILURES" : ", all passed"}`);
process.exit(fail);
