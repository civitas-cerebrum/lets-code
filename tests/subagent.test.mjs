#!/usr/bin/env node
// Unit test for the subagent extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/subagents.ts). Loads it with a fake pi
// API and a fake `pi` binary on PATH that replays JSON events. Needs Node >= 22.6.
//
//   tests/subagent.test.mjs [path/to/lets-code/subagents.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, chmodSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/subagents.ts");
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
process.on("SIGTERM", () => { try { fs.unlinkSync(running); } catch {} process.exit(143); });
if (/stream/.test(task)) {   // a recorded-shape event stream: thinking, a tool call with a big output, the answer
  const big = "HEAD" + "z".repeat(20000) + "TAIL"; const cmd = { command: "cat big.txt" };
  const evs = [
    { type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }, { type: "agent_start" }, { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: task } }, { type: "message_end", message: { role: "user", content: task } },
    { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
    { type: "message_update", usage: { output: 1 }, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
    { type: "message_update", usage: { output: 3 }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Look at " } },
    { type: "message_update", usage: { output: 5 }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "the files." } },
    { type: "message_update", usage: { output: 5 }, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Look at the files." } },
    { type: "message_update", usage: { output: 6 }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" } },
    { type: "message_update", usage: { output: 9 }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\\"command\\":" } },
    { type: "message_update", usage: { output: 12 }, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: cmd } } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Look at the files." }, { type: "toolCall", id: "call_1", name: "bash", arguments: cmd }], usage: { input: 100, output: 20 }, stopReason: "toolUse" } },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: cmd },
    { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: cmd, partialResult: { content: [{ type: "text", text: "HEAD" }], details: {} } },
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: big }], details: {} }, isError: false },
    { type: "message_start", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: big }] } },
    { type: "message_end", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: big }] } },
    { type: "turn_end" }, { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
    { type: "message_update", usage: { output: 1 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    { type: "message_update", usage: { output: 4 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Found it: " } },
    { type: "message_update", usage: { output: 8 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "line 3." } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found it: line 3." }], usage: { input: 150, output: 10 }, stopReason: "stop" } },
    { type: "turn_end" }, { type: "agent_end", messages: [] }, { type: "agent_settled" },
  ];
  let i = 0; const tick = () => { if (i < evs.length) { out(evs[i++]); setTimeout(tick, 15); } else { fs.unlinkSync(running); process.exit(0); } }; tick();
  return;
}
if (/hang/.test(task)) {   // works until stopped
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } });
  setInterval(() => {}, 1000);
  return;
}
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
	let tool = null; const handlers = {}, tools = [], commands = {}, shortcuts = {};
	mod.default({ registerTool: (d) => { tool = d; tools.push(d); }, on(ev, h) { handlers[ev] = h; return () => {}; },
		registerCommand: (name, d) => { commands[name] = d; }, registerShortcut: (key, d) => { shortcuts[key] = d; } });
	return { mod, tool, tools, commands, shortcuts, handlers, run: (params, cwd = work, trusted = true) => tool.execute("id", params, undefined, undefined, { cwd, isProjectTrusted: trusted }) };
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
	t("agent without thinking runs at medium", (({ argv }) => argv[argv.indexOf("--thinking") + 1])(calls().find((x) => /Task: x$/.test(x.argv.at(-1)))), "medium");
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
	// no body, own instructions: exactly those (REA sees what rea/run gave it), no generic preamble
	writeFileSync(join(agentDir, "agents", "re2.md"), fm(full).replace("name: re", "name: re2").replace("---\nbody\n", "---\n"));
	const on2 = await load();
	await on2.run({ agent: "re2", task: "inspect /bin/false" });
	const c2 = calls().find((x) => x.argv.at(-1) === "Task: inspect /bin/false");
	const after2 = (flag) => c2.argv.flatMap((v, i) => (v === flag ? [c2.argv[i + 1]] : []));
	t("no body + append_prompt: only its own instructions", after2("--append-system-prompt"), [join(rea, "prompt.md")]);
	rmSync(join(agentDir, "agents", "re2.md"));
	t("other agents keep the parent's agent dir", calls().find((x) => x.argv.at(-1) === "Task: find the config").agentDir, agentDir);
	const started = Date.now();
	const slow = await on.run({ agent: "slow", task: "slow down" });
	t("timeout stops the child", [slow.isError, /timed out after 1s/.test(slow.content[0].text), Date.now() - started < 8000], [true, true, true]);
	delete process.env.TEST_RE_ON;
	rmSync(join(agentDir, "agents", "re.md")); rmSync(join(agentDir, "agents", "slow.md"));

	// the description budget with the starter agents plus reverse-engineer
	const four = [["scout", "Fast read-only recon of a codebase; returns the files, line ranges and key code another agent needs"], ["worker", "General-purpose agent with full tools for a delegated change; isolated context"], ["reviewer", "Reviews a change for correctness and missed cases; reports findings, does not edit"], ["reverse-engineer", "Reverse engineers binaries, apps, APKs, firmware, websites"]].map(([name, description]) => ({ name, description }));
	t("description names each agent with its job", ["scout (Fast read-only recon", "reviewer (Reviews a change", "reverse-engineer (Reverse engineers"].every((x) => mod.agentsBlurb(four).includes(x)), true);
	t("description < 420 with the four default agents", mod.agentsBlurb(four).length < 420, true);

	// the reverse-engineer file lets-code writes, as this extension reads it
	const script = join(new URL(".", import.meta.url).pathname, "..", "lets-code");
	if (existsSync(script)) {
		const s = readFileSync(script, "utf8"); const i = s.indexOf(`cat > "\${tmp}" <<'MD'\n---\n# Written by lets-code (REA)`);
		const file = i < 0 ? "" : s.slice(s.indexOf("\n", i) + 1, s.indexOf("\nMD\n", i) + 1);
		mkdirSync(join(rea, "runtime", "node_modules", "rea-agents", "skills", "reverse-engineer-anything"), { recursive: true });
		writeFileSync(join(rea, "runtime", "node_modules", "rea-agents", "package.json"), "{}");
		const ra = mod.parseAgentFile(file, "reverse-engineer.md", "user");
		t("reverse-engineer: parses with its environment", ra && [ra.name, ra.agentDir, ra.skills, ra.appendPrompt, ra.timeout],
			["reverse-engineer", join(rea, "agent"), [join(rea, "runtime", "node_modules", "rea-agents", "skills", "reverse-engineer-anything")], join(rea, "prompt.md"), 3600]);
		t("reverse-engineer: description fits the jobs line", ra && ra.description.length <= 60, true);
		t("reverse-engineer: an expert", !!ra?.expert, true);
		rmSync(join(rea, "runtime"), { recursive: true });
		t("reverse-engineer: hidden once the runtime is gone", mod.parseAgentFile(file, "reverse-engineer.md", "user"), null);
	}
}

// --- run transcripts (the /subagents view's data) and the view's hooks: UI only
{
	const reg = () => globalThis[Symbol.for("lets-code.subagent-runs")];
	const { copyFileSync, statSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const view = join(dirname(extPath), "subagent-view.ts");
	if (existsSync(view)) copyFileSync(view, join(agentDir, "extensions", "subagent-view.ts"));
	const h = await load({});
	const { mod } = h;
	t("view: a /subagents command and the alt+s shortcut", [typeof h.commands.subagents?.handler, typeof h.shortcuts["alt+s"]?.handler], ["function", "function"]);
	t("view: no new tool and no prompt hook (zero context)", [h.tools.map((x) => x.name), Object.keys(h.handlers).sort()], [["subagent"], ["before_agent_start", "session_start"]]);
	t("view: nothing about it in the tool's text", /subagents to watch|\/subagents|alt\+s/.test(JSON.stringify([h.tool.description, h.tool.promptSnippet, h.tool.promptGuidelines, h.tool.parameters])), false);
	const sections = {};
	await h.handlers.before_agent_start({ prompt: "fix the typo", systemPromptOptions: { sections } }, { getContextUsage: () => ({ percent: 1 }) });
	t("view: the prompt sections are unchanged", Object.keys(sections), []);
	t("hint text", [mod.hintText(1), mod.hintText(2, "none"), mod.hintText(0)], ["1 subagent running · alt+s or /subagents to watch", "2 subagents running · /subagents to watch", ""]);

	// the session's id names the runs' directory; the footer shows the hint while one runs
	const statuses = [];
	const ui = { setStatus: (k, v) => statuses.push([k, v]), notify() {}, theme: { fg: (_c, s) => s } };
	h.handlers.session_start({ reason: "startup" }, { hasUI: true, ui, sessionManager: { getSessionId: () => "sess-1" } });
	const seen = [];
	const spy = (r) => { const last = r?.events?.at(-1); if (last?.t === "assistant" && !last.done) seen.push(last.blocks.map((b) => b.text).join("|")); };
	reg().listeners.add(spy);
	const single = await h.run({ agent: "worker", task: "stream it" });
	reg().listeners.delete(spy);
	const rec = reg().runs.find((r) => r.task === "stream it");
	t("stream: the tool result is the same as before", /Found it: line 3\./.test(single.content[0].text) && !single.isError, true);
	t("stream: one run recorded, done, in the session, with its tool call", rec && [rec.status, rec.session, rec.agent, rec.kind, rec.parent], ["done", "sess-1", "worker", "subagent", { tool: "subagent", callId: "id", mode: "single" }]);
	t("stream: events in order (the child's own copy of the task is not repeated)", rec.events.map((e) => e.t), ["user", "assistant", "tool", "assistant"]);
	t("stream: thinking and the tool call kept", rec.events[1].blocks.map((b) => [b.type, b.text, b.name ?? null]), [["thinking", "Look at the files.", null], ["toolCall", "", "bash"]]);
	t("stream: tool args kept", [rec.events[2].name, rec.events[2].args, rec.events[2].done, rec.events[2].isError], ["bash", { command: "cat big.txt" }, true, false]);
	const out = rec.events[2].output;
	t("stream: a huge tool output keeps its head and tail", [out.startsWith("HEAD"), out.endsWith("TAIL"), /characters cut/.test(out), rec.events[2].cut, out.length < mod.TOOL_OUT_CAP + 100], [true, true, true, 20008 - mod.TOOL_OUT_CAP, true]);
	t("stream: the final answer", rec.events[3].blocks, [{ type: "text", text: "Found it: line 3." }]);
	t("stream: tokens and turns", [rec.input, rec.output, rec.turns, rec.live], [250, 30, 2, 0]);
	t("stream: seen while streaming (partial text, then the rest)", seen.includes("Found it: ") && seen.includes("Found it: line 3."), true);
	const file = join(agentDir, "lets-code-runs", "sess-1", `${rec.id}.json`);
	t("disk: saved under the session, 0600", [existsSync(file), (statSync(file).mode & 0o777).toString(8)], [true, "600"]);
	t("disk: the finished run", JSON.parse(readFileSync(file, "utf8")).status, "done");
	t("hint: shown while it ran, cleared after", [statuses.some(([k, v]) => k === "subagents" && v === "1 subagent running · alt+s or /subagents to watch"), statuses.at(-1)], [true, ["subagents", undefined]]);

	// parallel: two runs at once, each with its place in the call
	statuses.length = 0;
	const par = await h.run({ tasks: [{ agent: "scout", task: "stream a" }, { agent: "worker", task: "stream b" }] });
	const a = reg().runs.find((r) => r.task === "stream a"), b = reg().runs.find((r) => r.task === "stream b");
	t("parallel: both recorded, apart", [a.status, b.status, a.id !== b.id, a.events.length, b.events.length], ["done", "done", true, 4, 4]);
	t("parallel: their place in the call", [a.parent, b.parent], [{ tool: "subagent", callId: "id", mode: "parallel", index: 0, of: 2 }, { tool: "subagent", callId: "id", mode: "parallel", index: 1, of: 2 }]);
	t("parallel: the hint counted both", statuses.some(([, v]) => v === "2 subagents running · alt+s or /subagents to watch"), true);
	t("parallel: tool result unchanged in shape", (par.content[0].text.match(/^## (scout|worker)/gm) ?? []).length, 2);

	// the view's stop (x): that child only, the other one finishes
	const pending = h.run({ tasks: [{ agent: "worker", task: "hang here" }, { agent: "scout", task: "stream c" }] });
	let hang; for (let i = 0; i < 100 && !(hang = reg().runs.find((r) => r.task === "hang here" && r.status === "running" && r.events.length > 1)); i++) await new Promise((r) => setTimeout(r, 30));
	t("stop: the hanging run streams its partial text", hang?.events.at(-1)?.blocks?.[0]?.text, "working");
	reg().stops.get(hang.id)();
	const res = await pending;
	t("stop: that run is stopped, the other done", [hang.status, reg().runs.find((r) => r.task === "stream c").status], ["aborted", "done"]);
	t("stop: the model is told the user stopped it", /## worker — stopped by the user/.test(res.content[0].text), true);
	t("stop: open blocks closed", hang.events.every((e) => e.t !== "assistant" || e.done), true);
	t("stop: its stop is gone", reg().stops.has(hang.id), false);

	// the tool call's abort (Esc in pi): recorded as stopped too
	const ac = new AbortController();
	const p2 = h.tool.execute("id2", { agent: "worker", task: "hang there" }, ac.signal, undefined, { cwd: work, isProjectTrusted: true });
	let h2; for (let i = 0; i < 100 && !(h2 = reg().runs.find((r) => r.task === "hang there" && r.events.length > 1)); i++) await new Promise((r) => setTimeout(r, 30));
	ac.abort(); const r2 = await p2;
	t("abort: recorded as stopped, the result as before", [h2.status, /stopped by the user/.test(r2.content[0].text), r2.isError], ["aborted", false, true]);

	// a failing child keeps its stderr as a note
	await h.run({ agent: "worker", task: "please fail again" });
	const f = reg().runs.find((r) => r.task === "please fail again");
	t("failed: status, exit code, stderr note", [f.status, f.exitCode, f.events.at(-1).t, /boom/.test(f.events.at(-1).text)], ["failed", 3, "note", true]);

	// the recorder on its own
	const r = mod.newRun({ name: "scout" }, "t", work, undefined, 1000);
	for (let i = 0; i < mod.MAX_EVENTS + 100; i++) mod.recordEvent(r, { type: "tool_execution_start", toolCallId: `c${i}`, toolName: "read", args: { path: `f${i}` } });
	t("cap: newest MAX_EVENTS events, the task first, the rest counted", [r.events.length, r.events[0].t, r.dropped, r.events.at(-1).args.path], [mod.MAX_EVENTS, "user", 101, `f${mod.MAX_EVENTS + 99}`]);
	t("cap: long arguments cut", mod.clipArgs({ content: "x".repeat(5000), n: 1 }).content.length < 2100, true);
	t("cap: nested arguments bounded", JSON.stringify(mod.clipArgs({ a: { b: { c: { d: { e: { f: 1 } } } } } })), '{"a":{"b":{"c":{"d":{"e":"[…]"}}}}}');
	t("unknown events are ignored", [mod.recordEvent(r, { type: "queue_update" }), mod.recordEvent(r, null), mod.recordEvent(r, { type: "message_update" })], [false, false, false]);
	const e = mod.newRun({ name: "x", expert: { job: "j" } }, "brief", work);
	t("an expert's run is marked", e.kind, "expert");
	mod.recordEvent(e, { type: "message_end", message: { role: "assistant", content: "plain", stopReason: "error", errorMessage: "500 upstream" } });
	t("an assistant message without a start, and its error", [e.events[1].blocks, e.events[1].error], [[{ type: "text", text: "plain" }], "500 upstream"]);
	mod.recordEvent(e, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" });
	t("retries are noted", e.events.at(-1).text, "retrying (attempt 1/3): 529 overloaded");

	// reopened after a restart: from disk; one saved while running shows as interrupted
	const live = mod.newRun({ name: "scout" }, "left running", work, undefined, 1000); live.session = "sess-2"; mod.saveRun(live, true);
	const done = mod.newRun({ name: "worker" }, "finished", work, undefined, 2000); done.session = "sess-2"; mod.finishRun(done, { exitCode: 0, text: "ok", stderr: "" }, false); mod.saveRun(done, true);
	const loaded = mod.loadRuns("sess-2");
	t("load: the session's runs", loaded.map((x) => [x.task, x.status]), [["left running", "aborted"], ["finished", "done"]]);
	t("load: an interrupted run says so", loaded[0].events.at(-1).text, "interrupted: pi stopped while it ran");
	reg().runs = reg().runs.filter((x) => x.id !== live.id && x.id !== done.id);
	h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: { getSessionId: () => "sess-2" } });
	t("session switch: that session's runs", reg().runs.filter((x) => x.status !== "running").map((x) => x.task), ["left running", "finished"]);
	h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: { getSessionId: () => "sess-1" } });
	t("and back: the first session's runs from disk", reg().runs.some((x) => x.task === "stream it"), true);
	for (let i = 0; i < mod.KEEP_RUNS + 5; i++) { const x = mod.newRun({ name: "w" }, `p${i}`, work); x.session = "sess-p"; mod.finishRun(x, { exitCode: 0, text: "", stderr: "" }, false); mod.saveRun(x, true); }
	mod.pruneRuns("sess-p");
	t("prune: the newest KEEP_RUNS runs stay on disk", readdirSync(join(agentDir, "lets-code-runs", "sess-p")).length, mod.KEEP_RUNS);
	t("pickRun: by row and by name", [mod.pickRun(loaded, "2", (x) => x)?.task, mod.pickRun(loaded, "sco", (x) => x)?.task, mod.pickRun(loaded, "9", (x) => x)], ["finished", "left running", undefined]);

	// the command without a terminal: the list as text
	if (existsSync(view)) {
		const logged = []; const log = console.log; console.log = (m) => logged.push(String(m));
		try { await h.commands.subagents.handler("", { hasUI: false }); } finally { console.log = log; }
		t("no UI: /subagents prints the list", /^Subagents {2}\d+ running · \d+ finished/.test(logged[0] ?? ""), true);
	}
	const ks = await load({ LETS_CODE_SUBAGENT_KEY: "none" });
	t("LETS_CODE_SUBAGENT_KEY=none: no shortcut, the command stays", [Object.keys(ks.shortcuts), typeof ks.commands.subagents?.handler], [[], "function"]);
	const ck = await load({ LETS_CODE_SUBAGENT_KEY: "ctrl+alt+w" });
	t("LETS_CODE_SUBAGENT_KEY picks the key", Object.keys(ck.shortcuts), ["ctrl+alt+w"]);
	delete process.env.LETS_CODE_SUBAGENT_KEY;
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
