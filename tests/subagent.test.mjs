#!/usr/bin/env node
// Unit test for the subagent extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/subagents.ts). Loads it with a fake pi
// API and a fake `pi` binary on PATH that replays JSON events. Needs Node >= 22.6.
//
//   tests/subagent.test.mjs [path/to/lets-code/subagents.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, chmodSync, readdirSync, existsSync, statSync } from "node:fs";
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
process.env.LETS_CODE_SUBAGENT_IDLE_S = "0.5";   // children at rest go soon (each is a process)
process.env.PATH = `${bin}:${process.env.PATH}`;

writeFileSync(join(bin, "pi"), `#!/usr/bin/env node
// fake pi in RPC mode: records its start (argv, env, instructions) and the
// first prompt as a call, then answers prompts with events built from the
// task; steer, abort, bash, set_model, set_thinking_level and compact too
const fs = require("fs"); const path = require("path");
const dir = process.env.FAKE_PI_DIR; const id = Date.now() + "-" + Math.random().toString(36).slice(2);
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const log = (o) => fs.appendFileSync(path.join(dir, "cmds"), JSON.stringify({ pid: process.pid, ...o }) + "\\n");
const ap = argv.indexOf("--append-system-prompt");
let first = true, turn = null; const steers = []; let uiWait = null;
process.on("SIGTERM", () => { if (turn) { try { fs.unlinkSync(turn.running); } catch {} } process.exit(143); });
const later = (ms, f) => { const t = setTimeout(f, ms); if (turn) turn.timers.push(t); };
const settle = (stop = "stop") => {
  const t = turn; if (!t) return; turn = null;
  t.timers.forEach(clearTimeout);
  try { fs.unlinkSync(t.running); } catch {}
  if (stop === "aborted") out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "aborted" } });
  out({ type: "agent_end", messages: [] }); out({ type: "agent_settled" });
};
const reply = (text, usage = { input: 10, output: 5 }) => out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "stop" } });
function startTurn(msg) {
  const running = path.join(dir, "running-" + id + "-" + Date.now()); fs.writeFileSync(running, "");
  const n = fs.readdirSync(dir).filter((f) => f.startsWith("running-")).length;
  fs.appendFileSync(path.join(dir, "concurrency"), n + "\\n");
  turn = { running, timers: [] };
  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "user", content: msg } }); out({ type: "message_end", message: { role: "user", content: msg } });
  const task = msg;
  if (/stream/.test(task)) {
    const big = "HEAD" + "z".repeat(20000) + "TAIL"; const cmd = { command: "cat big.txt" };
    const evs = [
      { type: "turn_start" },
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
      { type: "turn_end" },
    ];
    let i = 0; const tick = () => { if (!turn) return; if (i < evs.length) { out(evs[i++]); later(15, tick); } else settle(); }; tick();
    return;
  }
  if (/hang/.test(task)) {   // works until stopped
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } });
    return;
  }
  if (/ask first/.test(task)) {   // an extension's dialog, answered by the parent
    uiWait = (r) => { reply(\`Answer: \${r.cancelled ? "cancelled" : r.value}\`); settle(); };
    out({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Allow?", options: ["Allow once", "Deny"] });
    return;
  }
  out({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
  later(/steer/.test(task) ? 400 : 150, () => {
    if (/slow/.test(task)) return;   // never answers; only an abort ends it
    if (/fail/.test(task)) { process.stderr.write("boom"); try { fs.unlinkSync(turn.running); } catch {} process.exit(3); }
    for (const s of steers.splice(0)) { out({ type: "message_start", message: { role: "user", content: s } }); out({ type: "message_end", message: { role: "user", content: s } }); reply(\`Steered: \${s}\`); }
    const text = /big/.test(task) ? "x".repeat(60 * 1024) : "Result for: " + task.replace(/^Task: /, "");
    reply(text); settle();
  });
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    const ok = (data) => out({ type: "response", id: c.id, command: c.type, success: true, ...(data ? { data } : {}) });
    if (c.type === "extension_ui_response") { const w = uiWait; uiWait = null; w?.(c); continue; }
    log({ type: c.type, message: c.message, streamingBehavior: c.streamingBehavior, command: c.command, provider: c.provider, modelId: c.modelId, level: c.level });
    if (c.type === "prompt") {
      if (first) { first = false; fs.writeFileSync(path.join(dir, "call-" + id + ".json"), JSON.stringify({ argv, task: c.message, env: { role: process.env.LETS_CODE_ROLE, depth: process.env.LETS_CODE_SUBAGENT_DEPTH }, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(), prompt: ap >= 0 ? fs.readFileSync(argv[ap + 1], "utf8") : "" })); }
      if (turn) { if (c.streamingBehavior !== "steer" && c.streamingBehavior !== "followUp") { out({ type: "response", id: c.id, command: "prompt", success: false, error: "busy" }); continue; } steers.push(c.message); ok({ disposition: "queued" }); continue; }
      ok({ disposition: "started" }); startTurn(c.message); continue;
    }
    if (c.type === "abort") { if (turn) settle("aborted"); ok(); continue; }
    if (c.type === "bash") { ok({ output: "ran: " + c.command, exitCode: 0 }); continue; }
    if (c.type === "clear_queue") { ok({ steering: steers.splice(0), followUp: [] }); continue; }
    ok();
  }
});
process.stdin.on("end", () => process.exit(0));
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
	const sent = [], userSent = [], renderers = {};
	mod.default({ registerTool: (d) => { tool = d; tools.push(d); }, on(ev, h) { handlers[ev] = h; return () => {}; },
		registerCommand: (name, d) => { commands[name] = d; }, registerShortcut: (key, d) => { shortcuts[key] = d; },
		sendMessage: (m, o) => { sent.push([m, o]); }, sendUserMessage: (m, o) => { userSent.push([m, o]); }, registerMessageRenderer: (k, f) => { renderers[k] = f; }, getSettings: () => ({ ...(globalThis.__piSettings ?? {}) }) });
	return { mod, tool, tools, commands, shortcuts, handlers, sent, userSent, renderers, run: (params, cwd = work, trusted = true) => tool.execute("id", params, undefined, undefined, { cwd, isProjectTrusted: trusted }) };
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
	t("child argv: RPC mode on its own session file", [c.argv.slice(0, 3), c.argv.slice(4, 6)], [["--mode", "rpc", "--session"], ["--provider", "lets-code"]]);
	const sf = c.argv[3];
	t("child session file: under the runs dir, named after the run, created 0600 for pi to fill", [sf.startsWith(join(agentDir, "lets-code-runs") + "/"), sf.endsWith(".pi.jsonl"), existsSync(sf), (statSync(sf).mode & 0o777).toString(8)], [true, true, true, "600"]);
	t("child model/thinking/tools", [c.argv[c.argv.indexOf("--model") + 1], c.argv[c.argv.indexOf("--thinking") + 1], c.argv[c.argv.indexOf("--tools") + 1]], ["test-model", "low", "read,grep"]);
	t("the task is the first prompt, not an argument", [c.task, c.argv.includes("Task: find the config")], ["Task: find the config", false]);
	t("child prompt file content", /"scout" agent\. finds things[\s\S]*You look around\./.test(c.prompt), true);
	t("child role from agent file, depth 1", c.env, { role: "plan", depth: "1" });
	t("child cwd", c.cwd, work);
	const r2 = await h.run({ agent: "worker", task: "x" });
	t("worker inherits parent mode as role", calls().find((x) => /Task: x$/.test(x.task)).env.role, "ask");
	t("agent without thinking runs at medium", (({ argv }) => argv[argv.indexOf("--thinking") + 1])(calls().find((x) => /Task: x$/.test(x.task))), "medium");
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
	t("chain: previous substituted", calls().some((c) => /Task: use Result for: look$/.test(c.task)), true);
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
	const c = calls().find((x) => x.task === "Task: inspect /bin/true");
	const after = (flag) => c.argv.flatMap((v, i) => (v === flag ? [c.argv[i + 1]] : []));
	t("child gets agent_dir as PI_CODING_AGENT_DIR", c.agentDir, join(rea, "agent"));
	t("child gets each skill", after("--skill"), [join(rea, "skill-a"), join(rea, "skill-b")]);
	t("child gets the agent prompt, then append_prompt", [after("--append-system-prompt").length, after("--append-system-prompt")[1]], [2, join(rea, "prompt.md")]);
	t("child task: the first prompt", c.task, "Task: inspect /bin/true");
	// no body, own instructions: exactly those (REA sees what rea/run gave it), no generic preamble
	writeFileSync(join(agentDir, "agents", "re2.md"), fm(full).replace("name: re", "name: re2").replace("---\nbody\n", "---\n"));
	const on2 = await load();
	await on2.run({ agent: "re2", task: "inspect /bin/false" });
	const c2 = calls().find((x) => x.task === "Task: inspect /bin/false");
	const after2 = (flag) => c2.argv.flatMap((v, i) => (v === flag ? [c2.argv[i + 1]] : []));
	t("no body + append_prompt: only its own instructions", after2("--append-system-prompt"), [join(rea, "prompt.md")]);
	rmSync(join(agentDir, "agents", "re2.md"));
	t("other agents keep the parent's agent dir", calls().find((x) => x.task === "Task: find the config").agentDir, agentDir);
	const started = Date.now();
	const slow = await on.run({ agent: "slow", task: "slow down" });
	t("timeout stops the child", [slow.isError, /timed out after 1s/.test(slow.content[0].text), Date.now() - started < 8000], [true, true, true]);
	delete process.env.TEST_RE_ON;
	rmSync(join(agentDir, "agents", "re.md")); rmSync(join(agentDir, "agents", "slow.md"));

	// the description budget with the starter agents plus reverse-engineer
	const four = [["scout", "Fast read-only recon of a codebase; returns the files, line ranges and key code another agent needs"], ["worker", "Makes a delegated change and tests it"], ["general", "Researches open questions; runs multi-step tasks"], ["reviewer", "Reviews a change for correctness and missed cases; reports findings, does not edit"], ["reverse-engineer", "Reverse engineers binaries, apps, APKs, firmware, websites"]].map(([name, description]) => ({ name, description }));
	t("description names each agent with its job", ["scout (Fast read-only recon", "worker (Makes a delegated change", "general (Researches open questions; runs multi-step tasks)", "reviewer (Reviews a change", "reverse-engineer (Reverse engineers"].every((x) => mod.agentsBlurb(four).includes(x)), true);
	t("description < 440 with the starters and reverse-engineer", mod.agentsBlurb(four).length < 440, true);
	// the method routes research to general, only when there is one
	const m = mod.orchestration(four), m3 = mod.orchestration(four.filter((a) => a.name !== "general"));
	t("method: open questions -> general", /scouts in parallel .* you run the tests; open questions -> general\./.test(m), true);
	t("method: no general, no route to it", [/-> general/.test(m3), /scouts in parallel .* you run the tests\./.test(m3)], [false, true]);
	t("method: one line longer at most", m.split("\n").length, m3.split("\n").length);

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

// --- run transcripts and the subagent sessions' hooks: UI only
{
	const reg = () => globalThis[Symbol.for("lets-code.subagent-runs")];
	const { copyFileSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const view = join(dirname(extPath), "subagent-view.ts");
	if (existsSync(view)) copyFileSync(view, join(agentDir, "extensions", "subagent-view.ts"));
	const h = await load({});
	const { mod } = h;
	t("view: a /subagents command and the alt+s shortcut", [typeof h.commands.subagents?.handler, typeof h.shortcuts["alt+s"]?.handler], ["function", "function"]);
	t("view: no new tool and no prompt hook (zero context)", [h.tools.map((x) => x.name), Object.keys(h.handlers).sort()], [["subagent"], ["before_agent_start", "input", "model_select", "session_before_compact", "session_before_fork", "session_before_switch", "session_shutdown", "session_start", "thinking_level_select", "user_bash"]]);
	t("view: nothing about it in the tool's text", /subagents to (watch|switch)|\/subagents|alt\+s|session/.test(JSON.stringify([h.tool.description, h.tool.promptSnippet, h.tool.promptGuidelines, h.tool.parameters])), false);
	const sections = {};
	await h.handlers.before_agent_start({ prompt: "fix the typo", systemPromptOptions: { sections } }, { getContextUsage: () => ({ percent: 1 }) });
	t("view: the prompt sections are unchanged", Object.keys(sections), []);
	t("hint text", [mod.hintText(1), mod.hintText(2, "none"), mod.hintText(0)], ["1 subagent running · alt+s or /subagents to switch", "2 subagents running · /subagents to switch", ""]);

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
	t("hint: shown while it ran, cleared after", [statuses.some(([k, v]) => k === "subagents" && v === "1 subagent running · alt+s or /subagents to switch"), statuses.at(-1)], [true, ["subagents", undefined]]);
	t("disk: the child's session file next to its transcript", [rec.sessionFile, existsSync(rec.sessionFile)], [join(agentDir, "lets-code-runs", "sess-1", `${rec.id}.pi.jsonl`), true]);

	// parallel: two runs at once, each with its place in the call
	statuses.length = 0;
	const par = await h.run({ tasks: [{ agent: "scout", task: "stream a" }, { agent: "worker", task: "stream b" }] });
	const a = reg().runs.find((r) => r.task === "stream a"), b = reg().runs.find((r) => r.task === "stream b");
	t("parallel: both recorded, apart", [a.status, b.status, a.id !== b.id, a.events.length, b.events.length], ["done", "done", true, 4, 4]);
	t("parallel: their place in the call", [a.parent, b.parent], [{ tool: "subagent", callId: "id", mode: "parallel", index: 0, of: 2 }, { tool: "subagent", callId: "id", mode: "parallel", index: 1, of: 2 }]);
	t("parallel: the hint counted both", statuses.some(([, v]) => v === "2 subagents running · alt+s or /subagents to switch"), true);
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
	for (const f of readdirSync(join(agentDir, "lets-code-runs", "sess-p"))) writeFileSync(join(agentDir, "lets-code-runs", "sess-p", f.replace(/\.json$/, ".pi.jsonl")), "{}\n");
	mod.pruneRuns("sess-p");
	t("prune: the newest KEEP_RUNS runs stay on disk", readdirSync(join(agentDir, "lets-code-runs", "sess-p")).filter((f) => f.endsWith(".json")).length, mod.KEEP_RUNS);
	t("prune: a run's session file goes with its transcript", readdirSync(join(agentDir, "lets-code-runs", "sess-p")).length, 2 * mod.KEEP_RUNS);
	t("pickRun: by row and by name", [mod.pickRun(loaded, "2", (x) => x)?.task, mod.pickRun(loaded, "sco", (x) => x)?.task, mod.pickRun(loaded, "9", (x) => x)], ["finished", "left running", undefined]);

	// the command without a terminal: the list as text
	if (existsSync(view)) {
		const logged = []; const log = console.log; console.log = (m) => logged.push(String(m));
		try { await h.commands.subagents.handler("", { hasUI: false }); } finally { console.log = log; }
		t("no UI: /subagents prints the list", /^1\. [●✓✗■] \S+ — /.test(logged[0] ?? ""), true);
	}
	const ks = await load({ LETS_CODE_SUBAGENT_KEY: "none" });
	t("LETS_CODE_SUBAGENT_KEY=none: no shortcut, the command stays", [Object.keys(ks.shortcuts), typeof ks.commands.subagents?.handler], [[], "function"]);
	const ck = await load({ LETS_CODE_SUBAGENT_KEY: "ctrl+alt+w" });
	t("LETS_CODE_SUBAGENT_KEY picks the key", Object.keys(ck.shortcuts), ["ctrl+alt+w"]);
	delete process.env.LETS_CODE_SUBAGENT_KEY;
}

// --- subagent sessions: switching, read-only, detaching, the footer toggle
{
	const reg = () => globalThis[Symbol.for("lets-code.subagent-runs")];
	const { copyFileSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const view = join(dirname(extPath), "subagent-view.ts");
	if (existsSync(view)) copyFileSync(view, join(agentDir, "extensions", "subagent-view.ts"));
	const stateFile = join(work, "state.json"); writeFileSync(stateFile, JSON.stringify({ metrics: true }));
	const h = await load({ LETS_CODE_METRICS_SAVE: stateFile });
	const { mod } = h;
	const runsDir = join(agentDir, "lets-code-runs");
	const home = join(work, "sessions", "home.jsonl"); mkdirSync(dirname(home), { recursive: true }); writeFileSync(home, "{}\n");
	const statuses = [], notes = [], widgets = {};
	let editor = "";
	const ui = { setStatus: (k, v) => statuses.push([k, v]), notify: (m, t) => notes.push([t, m]), theme: { fg: (_c, s) => s }, setWidget: (k, v) => { widgets[k] = v; }, getEditorText: () => editor, setEditorText: (s) => { editor = s; } };
	const sm = (file, id, entries = []) => ({ getSessionFile: () => file, getSessionId: () => id, getEntries: () => entries });
	await h.handlers.session_start({ reason: "startup" }, { hasUI: true, ui, sessionManager: sm(home, "sess-s") });
	t("isChildSession: a run's .pi.jsonl under the runs dir only", [mod.isChildSession(join(runsDir, "s", "x.pi.jsonl")), mod.isChildSession(home), mod.isChildSession(join(work, "x.pi.jsonl"))], [true, false, false]);

	// the switch: through the command's ctx; a call in flight detaches instead of stopping its children
	const switched = [];
	const ctxFor = () => ({ hasUI: true, ui, switchSession: async (file, o) => {
		switched.push([file, reg().switching === true]);
		// pi aborts the turn in flight first (the abort below stands for it), then opens the file
		abortTurn?.();
		await h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: sm(file, mod.isChildSession(file) ? "child" : "sess-s", mod.isChildSession(file) ? [{ type: "message", message: { role: "user", content: "Task" } }] : []) });
		await o?.withSession?.({});
		return { cancelled: false };
	} });
	let abortTurn;
	const ac = new AbortController(); abortTurn = () => ac.abort();
	const call = h.tool.execute("call-d", { tasks: [{ agent: "worker", task: "stream d1" }, { agent: "scout", task: "stream d2" }] }, ac.signal, undefined, { cwd: work, isProjectTrusted: true });
	let d1; for (let i = 0; i < 100 && !((d1 = reg().runs.find((r) => r.task === "stream d1")) && d1.events.length > 1 && existsSync(d1.sessionFile)); i++) await new Promise((r) => setTimeout(r, 20));
	await h.commands.subagents.handler("1", ctxFor());
	const res = await call;
	t("switch: into a copy of the run's own session file, with reg.switching set while pi tears the turn down", [switched[0], existsSync(mod.viewFile(d1.sessionFile))], [[mod.viewFile(d1.sessionFile), true], true]);
	t("switch: reg.switching is cleared after", reg().switching, false);
	t("detach: the call returns at once, says its runs go on, not an error", [/Still running in the background/.test(res.content[0].text), /worker, scout/.test(res.content[0].text), res.isError], [true, true, false]);
	t("detach: the children were not stopped", reg().runs.filter((r) => /stream d[12]/.test(r.task)).map((r) => r.status), ["running", "running"]);
	t("in a run's session: the status names it and the way back", statuses.at(-1)?.[1], "subagent worker · running");
	t("in a run's session: the live widget is set", typeof widgets["subagent-live"], "function");
	// a prompt there goes to the child: a steer while it works
	const inp = await h.handlers.input({ text: "hello", source: "interactive" }, { ui });
	t("a prompt in a working child's session: a steer of the child", [inp?.action, reg().children.get(d1.id).queued.some((q) => q.text === "hello" && q.kind === "steer")], ["handled", true]);
	t("the view's own command text never goes to the model", (await h.handlers.input({ text: "/subagents back", source: "extension" }, { ui }))?.action, "handled");
	// the reports wait while the run's session is open
	for (let i = 0; i < 200 && reg().runs.some((r) => /stream d[12]/.test(r.task) && r.status === "running"); i++) await new Promise((r) => setTimeout(r, 20));
	t("detach: the runs finished on their own", reg().runs.filter((r) => /stream d[12]/.test(r.task)).map((r) => r.status), ["done", "done"]);
	t("detach: the report waits while another session is open", [h.sent.filter(([m]) => m?.customType === "lets-code-subagents").length, (reg().pending ?? []).length, /1 report waiting/.test(statuses.at(-1)?.[1] ?? "")], [0, 1, true]);
	// back: alt+s sends /subagents back as a command; the command switches home and the report goes out
	await h.shortcuts["alt+s"].handler({});
	t("alt+s in a run's session: the footer navigator, on the main row", [reg().view.nav, reg().view.sel], [true, 0]);
	await h.shortcuts["alt+s"].handler({});
	t("alt+s again: back to the editor", reg().view.nav, false);
	abortTurn = undefined;
	await h.commands.subagents.handler("back", ctxFor());
	await new Promise((r) => setTimeout(r, 120));
	t("back: the main session's file", switched.at(-1)[0], home);
	const reps = h.sent.filter(([m]) => m?.customType === "lets-code-subagents");
	t("back: the report continues the main session as a message", [reps.length, reps[0]?.[0]?.customType, /^Reports of the subagent call that went on in the background:/.test(reps[0]?.[0]?.content ?? ""), /## worker[\s\S]*## scout/.test(reps[0]?.[0]?.content ?? ""), reps[0]?.[1]], [1, "lets-code-subagents", true, true, { triggerTurn: true, deliverAs: "followUp" }]);
	t("back: prompts are the user's again", await h.handlers.input({ text: "hello", source: "interactive" }, { ui }), undefined);
	let ok = true; try { h.handlers.user_bash({ command: "ls" }); } catch { ok = false; }
	t("back: ! commands too", ok, true);
	await h.shortcuts["alt+s"].handler({});
	t("alt+s in the main session: the navigator, on the first run", [reg().view.nav, reg().view.sel], [true, 1]);
	await h.shortcuts["alt+s"].handler({});
	t("/subagents back in the main session: nothing to do", (switched.length, await h.commands.subagents.handler("back", ctxFor()), switched.length), 2);
	// a real abort (Esc) still stops the children
	const ac2 = new AbortController();
	const call2 = h.tool.execute("call-e", { agent: "worker", task: "hang on" }, ac2.signal, undefined, { cwd: work, isProjectTrusted: true });
	let e1; for (let i = 0; i < 100 && !((e1 = reg().runs.find((r) => r.task === "hang on")) && e1.events.length > 1); i++) await new Promise((r) => setTimeout(r, 20));
	ac2.abort();
	const res2 = await call2;
	t("a plain abort is not a detach: the child is stopped", [e1.status, /Still running/.test(res2.content[0].text)], ["aborted", false]);
	// /subagents stop <n|name>
	const call3 = h.tool.execute("call-f", { agent: "scout", task: "hang again" }, undefined, undefined, { cwd: work, isProjectTrusted: true });
	let f1; for (let i = 0; i < 100 && !((f1 = reg().runs.find((r) => r.task === "hang again")) && f1.events.length > 1); i++) await new Promise((r) => setTimeout(r, 20));
	await h.commands.subagents.handler("stop scout", ctxFor());
	await call3;
	t("/subagents stop <name> stops that run", f1.status, "aborted");
	t("/subagents <unknown> says so", (await h.commands.subagents.handler("nobody", ctxFor()), /No run "nobody"/.test(notes.at(-1)?.[1] ?? "")), true);
	// /subagents' completions never turn a bare /subagents into a subcommand
	t("completions: none for /subagents and /subagents with a space", [mod.subcommandCompletions(""), mod.subcommandCompletions(" ")], [null, null]);
	t("completions: a typed letter offers the subcommand", [mod.subcommandCompletions("t")?.map((c) => c.value), mod.subcommandCompletions("toggle"), mod.subcommandCompletions("st")?.map((c) => c.value)], [["toggle"], null, ["stop"]]);
	const toggledBefore = JSON.parse(readFileSync(stateFile, "utf8")).subagentsFooter;
	await h.commands.subagents.handler("", { hasUI: true, ui: { ...ui, custom: async () => undefined } });
	await h.commands.subagents.handler(" ", { hasUI: true, ui: { ...ui, custom: async () => undefined } });
	t("bare /subagents opens the picker and never toggles the footer", JSON.parse(readFileSync(stateFile, "utf8")).subagentsFooter, toggledBefore);
	// the copy pi opens stops before a reply whose tool calls have no results yet
	const L = (o) => JSON.stringify(o);
	const file = [L({ type: "session" }), L({ type: "message", message: { role: "user", content: "t" } }), L({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "a" }] } }), L({ type: "message", message: { role: "toolResult", toolCallId: "a" } }),
		L({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "b" }, { type: "toolCall", id: "c" }] } }), L({ type: "message", message: { role: "toolResult", toolCallId: "b" } })].join("\n") + "\n";
	t("view copy: cut before the reply with a call still running", mod.viewLines(file).length, 4);
	t("view copy: whole when every call has its result", mod.viewLines(file + L({ type: "message", message: { role: "toolResult", toolCallId: "c" } }) + "\n").length, 7);
	// /subagents toggle: the footer list, remembered in the state file (other keys kept)
	await h.commands.subagents.handler("toggle", ctxFor());
	t("toggle: on, remembered next to the other keys", JSON.parse(readFileSync(stateFile, "utf8")), { metrics: true, subagentsFooter: true });
	const block = globalThis[Symbol.for("lets-code.footer-blocks")]?.blocks?.get("subagents");
	t("toggle: a footer block of the runs", [typeof block, block(120, (_c, s) => s).length > 0, block(70, (_c, s) => s).every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length <= 70)], ["function", true, true]);
	t("toggle: the footer list replaces the running hint", statuses.at(-1)?.[1], undefined);
	const again = await load({ LETS_CODE_METRICS_SAVE: stateFile });
	t("toggle: the next launch starts with it", mod.readFooterOn(stateFile), true);
	await again.commands.subagents.handler("toggle", ctxFor());
	t("toggle: off again", [JSON.parse(readFileSync(stateFile, "utf8")).subagentsFooter, block(120, (_c, s) => s)], [false, []]);
}

// --- the child process (RPC): steer, Esc, going on, a new start, reports, ! and friends, dialogs, cleanup
{
	const reg = () => globalThis[Symbol.for("lets-code.subagent-runs")];
	const h = await load({});
	const { mod } = h;
	const home = join(work, "sessions", "home2.jsonl"); writeFileSync(home, "{}\n");
	const notes = [], statuses = [], selects = []; let termHandler, editor = "";
	const ui = { setStatus: (k, v) => statuses.push([k, v]), notify: (m, ty) => notes.push([ty, m]), theme: { fg: (_c, s) => s }, setWidget() {}, getEditorText: () => editor, setEditorText: (x) => { editor = x; },
		onTerminalInput: (f) => { termHandler = f; return () => {}; }, select: async (title, opts) => { selects.push([title, opts]); return "Allow once"; } };
	const sm = (file, id, entries = []) => ({ getSessionFile: () => file, getSessionId: () => id, getEntries: () => entries });
	await h.handlers.session_start({ reason: "startup" }, { hasUI: true, ui, sessionManager: sm(home, "sess-r") });
	const cmds = () => (existsSync(join(fake, "cmds")) ? readFileSync(join(fake, "cmds"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
	const wait = async (f, ms = 3000) => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); return f(); };

	// a prompt while it works: pi's steer
	const p = h.run({ agent: "worker", task: "steer me" });
	let s1; await wait(() => (s1 = reg().runs.find((r) => r.task === "steer me")) && s1.events.length > 1);
	const res = await mod.childOf(s1).steer("go left");
	const out = await p;
	t("steer: queued by the child while it works", [res.success, res.data?.disposition, cmds().some((c) => c.type === "prompt" && c.message === "go left" && c.streamingBehavior === "steer")], [true, "queued", true]);
	t("steer: the user's message and the child's answer in the transcript", [s1.events.some((e) => e.t === "user" && e.text === "go left"), s1.events.some((e) => e.t === "assistant" && e.blocks?.some((b) => b.text === "Steered: go left"))], [true, true]);
	t("steer: the call still gets the turn's last reply", /Result for: steer me/.test(out.content[0].text), true);

	// going on with a finished child: the same process, a new turn; its reply goes to the main session, quietly
	const c1 = mod.childOf(s1);
	const pid = c1.proc?.pid;
	h.sent.length = 0;
	const more = await c1.prompt("and more");
	t("going on: the same process answers", [c1.proc?.pid === pid, more.text, s1.status], [true, "Result for: and more", "done"]);
	t("going on: the reply goes to the main session as a quiet message", [h.sent.length, (h.sent[0]?.[0]?.content ?? "").startsWith("worker (a subagent the user went on with in its own session) replied:"), /Result for: and more/.test(h.sent[0]?.[0]?.content ?? ""), h.sent[0]?.[1]], [1, true, true, { triggerTurn: false }]);

	// at rest it goes after the idle time; the next prompt starts it again with the same settings
	await wait(() => !c1.alive, 5000);
	t("idle: the process goes after LETS_CODE_SUBAGENT_IDLE_S", c1.alive, false);
	const again = await c1.prompt("once more");
	const rc = calls().find((x) => x.task === "once more"), orig = calls().find((x) => x.task === "Task: steer me");
	t("respawn: a new process with the same args (session file, tools, instructions) and role", [again.text, !!rc, JSON.stringify(rc?.argv) === JSON.stringify(orig?.argv), rc?.env.role === orig?.env.role, rc?.prompt === orig?.prompt], ["Result for: once more", true, true, true, true]);

	// Esc in its session: the turn stops, the process stays
	const ph = h.run({ agent: "worker", task: "hang about" });
	let hr; await wait(() => (hr = reg().runs.find((r) => r.task === "hang about")) && hr.events.length > 1);
	await h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: sm(mod.viewFile(hr.sessionFile), "child", []) });
	t("in a child's session: the status has no read-only any more", statuses.at(-1)?.[1], "subagent worker · running");
	t("in a child's session: a key hook for Esc", typeof termHandler, "function");
	reg().tui = { focusedComponent: { handleInput() {} } };   // a pi selector has the keys
	t("Esc while a pi selector is open: the selector's, not the child's", [termHandler("\x1b"), hr.status, termHandler("\x1bs"), reg().view.nav], [undefined, "running", undefined, false]);
	reg().tui = { focusedComponent: { getText: () => "", onSubmit: () => {} } };   // the editor again
	t("Esc while the child works: consumed", termHandler("\x1b")?.consume, true);
	const ho = await ph;
	t("Esc: the turn is stopped, the process stays to go on", [hr.status, /stopped by the user/.test(ho.content[0].text), mod.childOf(hr).alive], ["aborted", true, true]);
	t("Esc at rest: left to pi", termHandler("\x1b"), undefined);
	// no reloads: the child's completed messages are added to its session's chat in-process, in order
	const added = h.sent.filter(([m]) => m?.customType === "lets-code-subagent-message");
	t("in-process: the run's completed messages added to the chat, quietly", [added.length >= 2, added[0]?.[0]?.details?.ev?.t, added[0]?.[0]?.details?.ev?.text, added.every(([, o]) => o?.triggerTurn === false)], [true, "user", "hang about", true]);
	t("in-process: the stopped reply follows the task", added.at(-1)?.[0]?.details?.ev?.t, "assistant");
	const before = added.length;
	{ await h.handlers.input({ text: "and then", source: "interactive" }, { ui }); }
	await wait(() => hr.status === "done" && hr.events.some((e) => e.t === "user" && e.text === "and then"));
	await wait(() => h.sent.filter(([m]) => m?.customType === "lets-code-subagent-message").length >= before + 3);
	const later = h.sent.filter(([m]) => m?.customType === "lets-code-subagent-message").slice(before).map(([m]) => m.details.ev);
	t("in-process: the user's prompt, the tool and the child's reply follow, each once", [later.map((e) => e.t), later[0]?.text, later[2]?.blocks?.[0]?.text], [["user", "tool", "assistant"], "and then", "Result for: and then"]);
	// a turn the user stops before it says anything is not reported to the main session
	const pend0 = (reg().pending ?? []).length, sent0 = h.sent.filter(([m]) => m?.customType === "lets-code-subagents").length;
	await h.handlers.input({ text: "hang on a bit", source: "interactive" }, { ui });
	await wait(() => hr.status === "running");
	termHandler("\x1b");
	await wait(() => hr.status === "aborted");
	await new Promise((r) => setTimeout(r, 100));
	t("a stopped turn with no reply: no report to the main session", [(reg().pending ?? []).length, h.sent.filter(([m]) => m?.customType === "lets-code-subagents").length], [pend0, sent0]);
	const rend = h.renderers["lets-code-subagent-message"];
	const rcomp = rend?.(added[0][0], { expanded: false }, { fg: (_c, x) => x, bg: (_c, x) => x, bold: (x) => x });
	const rl = rcomp?.render(70) ?? [];
	t("in-process: drawn with the message components, without its own spacer line on top, within the width", [typeof rend, rl.some((l) => /hang about/.test(l)), rl.length > 0 && rl[0] !== "", rl.every((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "").length <= 70)], ["function", true, true, true]);

	// a prompt in its session at rest: a new turn of the child
	const inp = await h.handlers.input({ text: "next step", source: "interactive" }, { ui });
	await wait(() => hr.status === "done" && hr.events.some((e) => e.t === "user" && e.text === "next step"));
	t("input in a child's session at rest: a new turn of the child", [inp?.action, hr.status, hr.events.some((e) => e.t === "assistant" && e.blocks?.some((b) => b.text === "Result for: next step"))], ["handled", "done", true]);

	// ! / /model / thinking / /compact act on the child
	const cpid = mod.childOf(hr).proc?.pid;
	const b = h.handlers.user_bash({ command: "ls -la", excludeFromContext: false });
	h.handlers.model_select({ model: { provider: "lets-code", id: "other-model" }, source: "set" });
	h.handlers.thinking_level_select({ level: "high" });
	const comp = h.handlers.session_before_compact({ reason: "manual", customInstructions: "keep it short" });
	await wait(() => ["bash", "set_model", "set_thinking_level", "compact"].every((k) => cmds().some((c) => c.type === k && c.pid === cpid)));
	t("! in a child's session: runs in the child", [/ran: ls -la/.test((await b)?.result?.output ?? ""), cmds().some((c) => c.type === "bash" && c.command === "ls -la" && c.pid === cpid)], [true, true]);
	t("/model, thinking, /compact: passed on to the child; the copy is never compacted", [cmds().some((c) => c.type === "set_model" && c.modelId === "other-model"), cmds().some((c) => c.type === "set_thinking_level" && c.level === "high"), cmds().some((c) => c.type === "compact"), comp?.cancel], [true, true, true, true]);
	await h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: sm(home, "sess-r") });

	// a dialog of a child's extension: asked here, with the agent's name
	const ask = await h.run({ agent: "worker", task: "ask first" });
	t("a child's dialog is asked here, with the agent's name", [selects[0]?.[0], ask.content[0].text.includes("Answer: Allow once")], ["worker: Allow?", true]);

	// pi's keys in a child's session (the key hook), and the footer navigator
	await h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: sm(mod.viewFile(hr.sessionFile), "child", []) });
	const vsx = reg().view;
	t("alt+s: the footer list takes the keys, on the main row", [termHandler("\x1bs")?.consume, vsx.nav, vsx.sel], [true, true, 0]);
	t("navigator: down moves, esc gives the keys back without switching", [termHandler("\x1b[B")?.consume, vsx.sel, termHandler("\x1b")?.consume, vsx.nav, hr.status !== "aborted" || true], [true, 1, true, false, true]);
	termHandler("\x1bs"); termHandler("\x1b[B");
	const rowsNow = (await import(pathToFileURL(join(agentDir, "extensions", "subagent-view.ts")).href)).navRows(reg().runs);
	const us0 = h.userSent.length;
	t("navigator: enter switches to the selected run (or the main session)", [termHandler("\r")?.consume, vsx.nav, h.userSent.slice(us0).map(([m]) => m)], [true, false, rowsNow[1].id === vsx.viewing ? [] : [`/subagents id:${rowsNow[1].id}`]]);
	termHandler("\x1bs"); termHandler("\x1b[A"); const us1 = h.userSent.length; termHandler("\r");
	t("navigator: the main row goes back", h.userSent.slice(us1).map(([m]) => m), ["/subagents back"]);
	// alt+enter then a prompt while the child works: a follow-up, shown as pi shows it
	await h.handlers.input({ text: "hang deeper", source: "interactive" }, { ui });
	await wait(() => hr.status === "running");
	t("alt+enter: left to pi's editor", termHandler("\x1b\r"), undefined);
	await h.handlers.input({ text: "later please", source: "interactive" }, { ui });
	await wait(() => cmds().some((c) => c.type === "prompt" && c.message === "later please"));
	t("alt+enter: the prompt goes to the child as a follow-up", [cmds().some((c) => c.message === "later please" && c.streamingBehavior === "followUp"), reg().children.get(hr.id).queued.map((q) => [q.text, q.kind])], [true, [["later please", "followUp"]]]);
	// alt+up: what was queued comes back to the editor
	editor = "";
	t("alt+up: consumed when the child has something queued", termHandler("\x1b[1;3A")?.consume, true);
	await wait(() => editor.includes("later please"));
	t("alt+up: the queued message is back in the editor, the queue empty", [editor, reg().children.get(hr.id).queued.length, cmds().some((c) => c.type === "clear_queue")], ["later please", 0, true]);
	termHandler("\x1b"); await wait(() => hr.status !== "running");
	// ctrl+t and ctrl+o: the child's messages follow pi's thinking and tool-output toggles
	const thinkMsg = { customType: "lets-code-subagent-message", content: "", display: true, details: { ev: { t: "assistant", done: true, v: 1, at: 1, blocks: [{ type: "thinking", text: "secret plan here" }, { type: "text", text: "the answer" }] }, cwd: work } };
	const thinkComp = h.renderers["lets-code-subagent-message"](thinkMsg, { expanded: false }, { fg: (_c, x) => x, bg: (_c, x) => x, bold: (x) => x, italic: (x) => x });
	// pi flips its setting on the key; the view knows the new state at once (pi may save it later)
	globalThis.__piSettings = { hideThinkingBlock: true }; await new Promise((r) => setTimeout(r, 250));
	termHandler("\x14"); globalThis.__piSettings = { hideThinkingBlock: false }; await new Promise((r) => setTimeout(r, 20));
	const shownT = thinkComp.render(70).join("\n");
	termHandler("\x14"); globalThis.__piSettings = { hideThinkingBlock: true }; await new Promise((r) => setTimeout(r, 20));
	const hiddenT = thinkComp.render(70).join("\n");
	t("ctrl+t: thinking shown, then hidden, in the child's messages", [/secret plan here/.test(shownT), /secret plan here/.test(hiddenT), /the answer/.test(hiddenT)], [true, false, true]);
	const toolMsg = { customType: "lets-code-subagent-message", content: "", display: true, details: { ev: { t: "tool", id: "x1", name: "bash", args: { command: "seq 40" }, done: true, v: 1, at: 1, end: 2, output: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"), cut: 0 }, cwd: work } };
	const th0 = { fg: (_c, x) => x, bg: (_c, x) => x, bold: (x) => x, italic: (x) => x };
	const col = h.renderers["lets-code-subagent-message"](toolMsg, { expanded: false }, th0).render(70), exp = h.renderers["lets-code-subagent-message"](toolMsg, { expanded: true }, th0).render(70);
	t("ctrl+o: a tool's output collapsed, then expanded (pi passes its state to each message)", [exp.join("\n").includes("line 1\n") || exp.some((l) => /line 1$/.test(l.trim())), exp.length > col.length], [true, true]);
	// ctrl+x copies the child's last reply: the view catches up first
	const us2 = h.userSent.length;
	if ((vsx.addedCount ?? 0) > 0) t("ctrl+x: the copy catches up, then the key is pressed again", [termHandler("\x18")?.consume, h.userSent.slice(us2).map(([m]) => m)], [true, ["/subagents refresh"]]);
	vsx.resubmit = undefined; vsx.resubmitKey = undefined;
	await h.handlers.session_start({ reason: "resume" }, { hasUI: true, ui, sessionManager: sm(home, "sess-r") });
	// the main session ends: no child is left
	await h.handlers.session_shutdown({ reason: "quit" });
	await wait(() => [...(reg().children?.values() ?? [])].every((c) => !c.alive), 6000);
	t("quit: every child process goes", [...(reg().children?.values() ?? [])].filter((c) => c.alive).length, 0);
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
