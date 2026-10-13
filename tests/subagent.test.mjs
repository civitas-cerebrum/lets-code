#!/usr/bin/env node
// Unit test for the subagent extension that lets-code writes
// (~/.pi/agent/extensions/subagents/index.ts). Loads it with a fake pi
// API and a fake `pi` binary on PATH that replays JSON events. Needs Node >= 22.6.
//
//   tests/subagent.test.mjs [path/to/lets-code-subagent.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, chmodSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/subagents/index.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "subagent-test-")));
const agentDir = join(work, "agent"); mkdirSync(join(agentDir, "extensions"), { recursive: true }); mkdirSync(join(agentDir, "agents"));
const bin = join(work, "bin"); mkdirSync(bin);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LETS_CODE_SUBAGENTS_ON = "1";
process.env.LETS_CODE_MODEL = "test-model";
process.env.LETS_CODE_SUBAGENT_CONCURRENCY = "2";
process.env.PATH = `${bin}:${process.env.PATH}`;

// fake pi: records argv + env, waits, replays a reply built from the task
writeFileSync(join(bin, "pi"), `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const dir = process.env.FAKE_PI_DIR; const id = Date.now() + "-" + Math.random().toString(36).slice(2);
fs.writeFileSync(path.join(dir, "call-" + id + ".json"), JSON.stringify({ argv: process.argv.slice(2), env: { role: process.env.LETS_CODE_ROLE, depth: process.env.LETS_CODE_SUBAGENT_DEPTH }, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(), prompt: fs.readFileSync(process.argv[process.argv.indexOf("--append-system-prompt") + 1], "utf8") }));
const task = process.argv[process.argv.length - 1];
const running = path.join(dir, "running-" + id); fs.writeFileSync(running, "");
const n = fs.readdirSync(dir).filter((f) => f.startsWith("running-")).length;
fs.appendFileSync(path.join(dir, "concurrency"), n + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
setTimeout(() => {
  if (/slow/.test(task)) return;   // never answers; only a timeout ends it
  if (/fail/.test(task)) { process.stderr.write("boom"); fs.unlinkSync(running); process.exit(3); }
  const text = /big/.test(task) ? "x".repeat(60 * 1024) : "Result for: " + task.replace(/^Task: /, "");
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 10, output: 5 } } });
  fs.unlinkSync(running); process.exit(0);
}, 150);
if (/slow/.test(task)) setTimeout(() => {}, 60000);
`);
chmodSync(join(bin, "pi"), 0o755);
const fake = join(work, "fake"); mkdirSync(fake); process.env.FAKE_PI_DIR = fake;
const calls = () => readdirSync(fake).filter((f) => f.startsWith("call-")).map((f) => JSON.parse(readFileSync(join(fake, f), "utf8")));

writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: finds things\ntools: read, grep\nthinking: low\nrole: plan\n---\nYou look around.\n");
writeFileSync(join(agentDir, "agents", "worker.md"), "---\ndescription: does things\n---\nYou do things.\n");
writeFileSync(join(agentDir, "agents", "notes.txt"), "not an agent");

const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
// "typebox" is provided by the pi host at runtime; point the temp copy at pi's own
import { symlinkSync } from "node:fs"; import { execFileSync } from "node:child_process";
{
	let piRoot = "";
	try { piRoot = join(execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "@earendil-works", "pi-coding-agent"); } catch { /* no npm */ }
	const tb = piRoot ? [join(piRoot, "node_modules", "typebox"), join(piRoot, "..", "..", "typebox")].find((p) => existsSync(p)) : undefined;
	const nm = join(agentDir, "extensions", "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	if (tb) { rmSync(nm, { recursive: true }); symlinkSync(tb, nm); }
	else {	// no pi on this machine (CI): the extension only builds a schema with these four, which the fake pi never validates
		writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
		writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }) };\n");
	}
}
let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let loads = 0;
async function load(env = {}) {
	for (const k of ["LETS_CODE_SUBAGENT_DEPTH", "LETS_CODE_ROLE", "LETS_CODE_MODE"]) delete process.env[k];
	Object.assign(process.env, env);
	const f = join(agentDir, "extensions", `subagent-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	let tool = null; const handlers = {};
	mod.default({ registerTool: (d) => { tool = d; }, on(ev, h) { handlers[ev] = h; return () => {}; } });
	return { mod, tool, handlers, run: (params, cwd = work, trusted = true) => tool.execute("id", params, undefined, undefined, { cwd, isProjectTrusted: trusted }) };
}

// --- what the model is told: agents and call shapes in the tool; the method once asked for
{
	const { tool, mod } = await load();
	t("description: agent names", /scout/.test(tool.description) && /worker/.test(tool.description), true);
	t("description: the three call shapes", ["{agent,task}", "{tasks:", "parallel", "{chain:", "{previous}"].every((k) => tool.description.includes(k)), true);
	t("method: each agent's job", /scout \(finds things\); worker \(does things\)/.test(mod.orchestration(mod.discoverAgents(work, true))), true);
	t("guideline: orchestrate", /orchestrate/i.test(tool.promptGuidelines[0]), true);
	const long = mod.agentJobs([{ name: "x", description: "a".repeat(30) + " " + "b".repeat(50) }]);
	t("long agent descriptions are cut", /x \(a{30}…\)/.test(long), true);

	const want = mod.wantsOrchestration;
	for (const p of ["use subagents to map the repo", "Delegate the test writing", "do these three in parallel", "orchestrate the refactor",
		"fan out over the modules", "parallelize the audit", "split the work between scouts", "design a workflow for releasing docs", "plan the workflow for onboarding"])
		t(`trigger: "${p}"`, want(p), true);
	for (const p of ["fix the failing test in parser.py", "add a GitHub Actions workflow for the tests", "set up a CI workflow", "the workflow file is broken",
		"why does `in parallel` appear in the log?", "explain this:\n```\nrun in parallel; delegate()\n```", "the parallel port driver crashes"])
		t(`no trigger: "${p.replace(/\n/g, " ")}"`, want(p), false);
}
{
	const { handlers } = await load();
	const run = (prompt, pct = 10) => { const sections = { other: "kept" }; handlers.before_agent_start({ prompt, systemPromptOptions: { sections } }, { getContextUsage: () => ({ percent: pct }) }); return sections; };
	t("plain prompt: no method", Object.keys(run("fix the failing test")), ["other"]);
	t("asked for: method added", /you are the orchestrator/.test(run("use subagents for this").lets_code_orchestration), true);
	t("and it stays for the session", typeof run("now fix the typo").lets_code_orchestration, "string");
}
{
	const { handlers } = await load();
	const run = (prompt, pct) => { const sections = {}; handlers.before_agent_start({ prompt, systemPromptOptions: { sections } }, { getContextUsage: () => ({ percent: pct }) }); return sections; };
	t("context under 50%: no method", "lets_code_orchestration" in run("keep going", 49), false);
	t("context at 50%: method added", "lets_code_orchestration" in run("keep going", 50), true);
}
{
	const { handlers, tool } = await load({ LETS_CODE_SUBAGENT_DEPTH: "1" });
	const sections = {}; handlers.before_agent_start?.({ prompt: "use subagents", systemPromptOptions: { sections } }, { getContextUsage: () => ({ percent: 90 }) });
	t("a subagent never gets the method", "lets_code_orchestration" in sections, false);
}

// --- discovery
{
	const { mod } = await load();
	const proj = join(work, "proj"); mkdirSync(join(proj, ".pi", "agents"), { recursive: true }); mkdirSync(join(proj, ".agents", "agents"), { recursive: true });
	writeFileSync(join(proj, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: project scout\n---\nproject\n");
	writeFileSync(join(proj, ".agents", "agents", "cross.md"), "---\ndescription: cross-tool\n---\nx\n");
	const user = mod.discoverAgents(work, true).map((a) => a.name).sort();
	t("user agents found, non-md ignored", user, ["scout", "worker"]);
	t("name falls back to filename", mod.discoverAgents(work, true).find((a) => a.name === "worker").description, "does things");
	t("frontmatter fields", (({ tools, thinking, role }) => ({ tools, thinking, role }))(mod.discoverAgents(work, true).find((a) => a.name === "scout")), { tools: ["read", "grep"], thinking: "low", role: "plan" });
	const trusted = mod.discoverAgents(proj, true);
	t("trusted project: .pi/agents wins, .agents/agents included", [trusted.find((a) => a.name === "scout").description, trusted.some((a) => a.name === "cross")], ["project scout", true]);
	t("untrusted project: user agents only", mod.discoverAgents(proj, false).map((a) => a.source).every((s) => s === "user"), true);
	t("bad name rejected", mod.parseAgentFile("---\nname: ../evil\n---\nx", "x.md", "user"), null);
}

// --- single run: argv, env, prompt, result
{
	const h = await load({ LETS_CODE_MODE: "ask" });
	t("tool registered", h.tool?.name, "subagent");
	t("prompt snippet names the agents", /^subagent: delegate to agents \((scout, worker|worker, scout)\); parallel or chained$/.test(h.tool.promptSnippet), true);
	t("one short guideline that says it already exists", [h.tool.promptGuidelines.length, /never build your own/.test(h.tool.promptGuidelines[0]), h.tool.promptGuidelines[0].length < 120], [1, true, true]);
	t("description names the agents and stays short", [/scout/.test(h.tool.description), h.tool.description.length < 160], [true, true]);
	const r = await h.run({ agent: "scout", task: "find the config" });
	t("single: not an error", r.isError, false);
	t("single: result text", /Result for: find the config/.test(r.content[0].text), true);
	t("single: usage line", /1 turn, ↑10 ↓5/.test(r.content[0].text), true);
	const c = calls()[0];
	t("child argv", c.argv.slice(0, 6), ["--mode", "json", "-p", "--no-session", "--provider", "lets-code"]);
	t("child model/thinking/tools", [c.argv[c.argv.indexOf("--model") + 1], c.argv[c.argv.indexOf("--thinking") + 1], c.argv[c.argv.indexOf("--tools") + 1]], ["test-model", "low", "read,grep"]);
	t("child task is last arg", c.argv[c.argv.length - 1], "Task: find the config");
	t("child prompt file content", /"scout" agent\. finds things[\s\S]*You look around\./.test(c.prompt), true);
	t("child role from agent file, depth 1", c.env, { role: "plan", depth: "1" });
	t("child cwd", c.cwd, work);
	const r2 = await h.run({ agent: "worker", task: "x" });
	t("worker inherits parent mode as role", calls().find((x) => /Task: x$/.test(x.argv.at(-1))).env.role, "ask");
	t("unknown agent lists agents", (await h.run({ agent: "nope", task: "x" })).content[0].text.includes("- scout: finds things"), true);
	t("no args lists agents, not an error", (await h.run({})).isError, false);
	t("failure reported", (({ isError, content }) => [isError, /exit 3/.test(content[0].text) && /boom/.test(content[0].text)])(await h.run({ agent: "worker", task: "please fail" })), [true, true]);
	t("output capped", (await h.run({ agent: "worker", task: "big" })).content[0].text.includes("[output truncated at 50 KB]"), true);
}

// --- parallel with concurrency 2, chain with {previous}
{
	const h = await load({});
	rmSync(join(fake, "concurrency"), { force: true });
	const r = await h.run({ tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }, { agent: "worker", task: "c" }, { agent: "worker", task: "d" }] });
	t("parallel: all four results", (r.content[0].text.match(/^## worker/gm) ?? []).length, 4);
	const peak = Math.max(...readFileSync(join(fake, "concurrency"), "utf8").trim().split("\n").map(Number));
	t("parallel: at most 2 at once", peak <= 2, true);
	t("parallel: too many", (await h.run({ tasks: Array.from({ length: 9 }, () => ({ agent: "worker", task: "x" })) })).isError, true);
	const ch = await h.run({ chain: [{ agent: "scout", task: "look" }, { agent: "worker", task: "use {previous}" }] });
	t("chain: steps numbered", /step 1[\s\S]*step 2/.test(ch.content[0].text), true);
	t("chain: previous substituted", calls().some((c) => /Task: use Result for: look$/.test(c.argv.at(-1))), true);
	const stop = await h.run({ chain: [{ agent: "worker", task: "fail now" }, { agent: "worker", task: "never" }] });
	t("chain: stops after failure", [stop.isError, /step 2/.test(stop.content[0].text)], [true, false]);
}

// --- depth limit: a child registers nothing
{
	const h = await load({ LETS_CODE_SUBAGENT_DEPTH: "1" });
	t("child at depth limit: no tool", h.tool, null);
	delete process.env.LETS_CODE_SUBAGENTS_ON;
	const off = await load({});
	t("inert when off", off.tool, null);
}

// --- agent types: agent_dir, skills, append_prompt, timeout, requires, requires_env
{
	process.env.LETS_CODE_SUBAGENTS_ON = "1";
	const { mod } = await load();
	const rea = join(agentDir, "rea");
	for (const d of ["agent", "skill-a", "skill-b", "runtime"]) mkdirSync(join(rea, d), { recursive: true });
	writeFileSync(join(rea, "prompt.md"), "REA standing instructions\n");
	const fm = (lines) => `---\nname: re\ndescription: reverse engineers\n${lines.join("\n")}\n---\nbody\n`;
	const full = ["agent_dir: rea/agent", "skills:", "  - rea/skill-a", `  - ${join(rea, "skill-b")}`, "append_prompt: rea/prompt.md", "timeout: 3600", "requires: rea/runtime", "requires_env: TEST_RE_ON"];
	process.env.TEST_RE_ON = "1";
	const a = mod.parseAgentFile(fm(full), "re.md", "user");
	t("fields parsed and resolved under the agent dir", a && { agentDir: a.agentDir, skills: a.skills, appendPrompt: a.appendPrompt, timeout: a.timeout },
		{ agentDir: join(rea, "agent"), skills: [join(rea, "skill-a"), join(rea, "skill-b")], appendPrompt: join(rea, "prompt.md"), timeout: 3600 });
	t("inline skill list", mod.parseAgentFile(fm(["skills: [rea/skill-a, rea/skill-b]"]), "re.md", "user")?.skills, [join(rea, "skill-a"), join(rea, "skill-b")]);
	t("unknown fields ignored", mod.parseAgentFile(fm(["colour: blue", "agent_dir: rea/agent"]), "re.md", "user")?.agentDir, join(rea, "agent"));
	const proj = join(work, "proj2"); mkdirSync(join(proj, "env"), { recursive: true });
	for (const [what, line] of [["agent_dir ..", "agent_dir: ../outside"], ["agent_dir absolute elsewhere", `agent_dir: ${work}`], ["agent_dir /etc", "agent_dir: /etc"],
		["skill ..", "skills: rea/../../x"], ["one bad skill of two", "skills: rea/skill-a, /etc"], ["append_prompt /etc/passwd", "append_prompt: /etc/passwd"],
		["requires ..", "requires: ../outside"], ["user agent: path in the project", `agent_dir: ${join(proj, "env")}`]])
		t(`path escape rejected: ${what}`, mod.parseAgentFile(fm([line]), "re.md", "user", proj), null);
	t("trusted project agent: path in the project allowed", mod.parseAgentFile(fm([`agent_dir: ${join(proj, "env")}`]), "re.md", "project", proj)?.agentDir, join(proj, "env"));
	t("project agent: relative paths still under the agent dir", mod.parseAgentFile(fm(["agent_dir: ../env"]), "re.md", "project", proj), null);
	for (const v of ["0", "-5", "abc", "1.5", String(mod.MAX_TIMEOUT + 1)]) t(`timeout ${v} rejected`, mod.parseAgentFile(fm([`timeout: ${v}`]), "re.md", "user"), null);
	t("missing append_prompt hides (never passed as literal text)", mod.parseAgentFile(fm(["append_prompt: rea/nope.md"]), "re.md", "user"), null);
	t("missing agent_dir hides", mod.parseAgentFile(fm(["agent_dir: rea/nope"]), "re.md", "user"), null);
	t("missing skill hides", mod.parseAgentFile(fm(["skills: rea/nope"]), "re.md", "user"), null);
	t("requires missing hides", mod.parseAgentFile(fm(["requires: rea/runtime/nope"]), "re.md", "user"), null);
	t("requires_env bad name rejected", mod.parseAgentFile(fm(["requires_env: A-B"]), "re.md", "user"), null);
	process.env.TEST_RE_ON = "0";
	t("requires_env 0 hides", mod.parseAgentFile(fm(full), "re.md", "user"), null);
	delete process.env.TEST_RE_ON;
	t("requires_env unset hides", mod.parseAgentFile(fm(full), "re.md", "user"), null);

	// discovery and the tool: hidden agents are neither listed nor callable
	writeFileSync(join(agentDir, "agents", "re.md"), fm(full));
	writeFileSync(join(agentDir, "agents", "slow.md"), "---\ndescription: times out\ntimeout: 1\n---\nx\n");
	const off = await load();
	t("hidden: not in the tool description", /\bre\b/.test(off.tool.description), false);
	t("hidden: not callable", /Unknown agent "re"/.test((await off.run({ agent: "re", task: "x" })).content[0].text), true);
	process.env.TEST_RE_ON = "1";
	const on = await load();
	t("shown once its env is set", /\bre\b/.test(on.tool.description), true);
	const r = await on.run({ agent: "re", task: "inspect /bin/true" });
	t("agent type run: not an error", r.isError, false);
	const c = calls().find((x) => x.argv.at(-1) === "Task: inspect /bin/true");
	const after = (flag) => c.argv.flatMap((v, i) => (v === flag ? [c.argv[i + 1]] : []));
	t("child gets agent_dir as PI_CODING_AGENT_DIR", c.agentDir, join(rea, "agent"));
	t("child gets each skill", after("--skill"), [join(rea, "skill-a"), join(rea, "skill-b")]);
	t("child gets the agent prompt, then append_prompt", [after("--append-system-prompt").length, after("--append-system-prompt")[1]], [2, join(rea, "prompt.md")]);
	t("child task still last", c.argv.at(-1), "Task: inspect /bin/true");
	t("other agents keep the parent's agent dir", calls().find((x) => x.argv.at(-1) === "Task: find the config").agentDir, agentDir);
	const started = Date.now();
	const slow = await on.run({ agent: "slow", task: "slow down" });
	t("timeout stops the child", [slow.isError, /timed out after 1s/.test(slow.content[0].text), Date.now() - started < 8000], [true, true, true]);
	delete process.env.TEST_RE_ON;
	rmSync(join(agentDir, "agents", "re.md")); rmSync(join(agentDir, "agents", "slow.md"));

	// the description budget with the starter agents plus reverse-engineer
	t("description < 160 with scout, worker, reviewer, reverse-engineer", mod.agentsBlurb(["scout", "worker", "reviewer", "reverse-engineer"].map((name) => ({ name }))).length < 160, true);

	// the reverse-engineer file lets-code writes, as this extension reads it
	const script = join(new URL(".", import.meta.url).pathname, "..", "lets-code");
	if (existsSync(script)) {
		const s = readFileSync(script, "utf8"); const i = s.indexOf(`cat > "\${tmp}" <<'MD'\n---\n# Written by lets-code (REA)`);
		const file = i < 0 ? "" : s.slice(s.indexOf("\n", i) + 1, s.indexOf("\nMD\n", i) + 1);
		mkdirSync(join(rea, "runtime", "node_modules", "rea-agents", "skills", "reverse-engineer-anything"), { recursive: true });
		writeFileSync(join(rea, "runtime", "node_modules", "rea-agents", "package.json"), "{}");
		process.env.LETS_CODE_REA_AGENT = "1";
		const ra = mod.parseAgentFile(file, "reverse-engineer.md", "user");
		t("reverse-engineer: parses with its environment", ra && [ra.name, ra.agentDir, ra.skills, ra.appendPrompt, ra.timeout],
			["reverse-engineer", join(rea, "agent"), [join(rea, "runtime", "node_modules", "rea-agents", "skills", "reverse-engineer-anything")], join(rea, "prompt.md"), 3600]);
		t("reverse-engineer: description fits the jobs line", ra && ra.description.length <= 60, true);
		delete process.env.LETS_CODE_REA_AGENT;
		t("reverse-engineer: hidden without LETS_CODE_REA_AGENT", mod.parseAgentFile(file, "reverse-engineer.md", "user"), null);
		process.env.LETS_CODE_REA_AGENT = "1"; rmSync(join(rea, "runtime"), { recursive: true });
		t("reverse-engineer: hidden once the runtime is gone", mod.parseAgentFile(file, "reverse-engineer.md", "user"), null);
		delete process.env.LETS_CODE_REA_AGENT;
	}
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
