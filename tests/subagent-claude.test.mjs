#!/usr/bin/env node
// Unit test for the Claude Code agent files the subagent extension reads
// with the Claude Code adapter on (~/.pi/agent/extensions/lets-code/subagents.ts):
// frontmatter mapping (tools, disallowedTools, effort, permissionMode),
// where they are looked up, trust, and precedence of pi's own agent dirs.
// Needs Node >= 22.6.
//
//   tests/subagent-claude.test.mjs [path/to/lets-code/subagents.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/subagents.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "subagent-claude-test-")));
const HOME = join(work, "home"); const agentDir = join(HOME, ".pi", "agent");
mkdirSync(join(agentDir, "agents"), { recursive: true });
process.env.HOME = HOME; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.CLAUDE_CONFIG_DIR;
process.env.LETS_CODE_CLAUDE_SCOPE = "all";   // CLAUDE_CODE=all: the user's Claude agents too
{
	const nm = join(agentDir, "extensions", "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
	writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }) };\n");
}
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
let loads = 0;
async function load(env) {
	for (const k of ["LETS_CODE_CLAUDE_CODE_ON", "LETS_CODE_CLAUDE_TRUST"]) delete process.env[k];
	Object.assign(process.env, env);
	const f = join(agentDir, "extensions", `subagents-${loads++}.ts`); writeFileSync(f, src);
	return import(pathToFileURL(f).href);
}
let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const w = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };

const m = await load({ LETS_CODE_CLAUDE_CODE_ON: "1" });
{
	const a = m.parseAgentFile("---\nname: researcher\ndescription: >\n  Researches a topic\n  on the web.\ntools: Read, Grep, Glob, WebFetch, Task, mcp__my-srv__search\nmodel: sonnet\ncolor: blue\neffort: xhigh\nagent_dir: /etc\n---\nYou research.\n", "/x/researcher.md", "user", undefined, true);
	t("Claude agent: tools mapped, ones pi lacks dropped", a.tools, ["read", "grep", "find", "mcp__my_srv__search"]);
	t("Claude agent: folded description", a.description, "Researches a topic on the web.");
	t("Claude agent: effort xhigh runs as high; model and color ignored", [a.thinking, a.role], ["high", undefined]);
	t("Claude agent: pi's environment keys are not read (agent_dir)", a.agentDir, undefined);
	const b = m.parseAgentFile("---\nname: lookout\ndescription: d\ndisallowedTools: Bash, Write, Edit\npermissionMode: plan\neffort: low\n---\nx", "/x/lookout.md", "user", undefined, true);
	t("Claude agent: disallowedTools from all tools", b.tools, ["read", "grep", "find", "ls"]);
	t("Claude agent: permissionMode plan is the readonly role, effort low", [b.role, b.thinking], ["readonly", "low"]);
	const c = m.parseAgentFile("---\nname: web\ndescription: d\ntools: WebSearch\n---\nx", "/x/web.md", "user", undefined, true);
	t("Claude agent: no usable tool leaves read only", c.tools, ["read"]);
	t("Claude agent: Bash(git *) is Bash", m.claudeTools(["Bash(git add:*)", "Edit", "MultiEdit"]), ["bash", "edit"]);
	t("runAgent is exported (the workflow runner)", typeof m.runAgent, "function");
}
{
	const root = join(work, "repo"); const cwd = join(root, "pkg"); mkdirSync(join(root, ".git"), { recursive: true }); mkdirSync(cwd, { recursive: true });
	w(join(root, ".claude", "agents", "gemini-research-expert.md"), "---\nname: gemini-research-expert\ndescription: research\nmodel: sonnet\n---\nGo.\n");
	w(join(cwd, ".claude", "agents", "near.md"), "---\nname: near\ndescription: nearest\n---\nnear\n");
	w(join(HOME, ".claude", "agents", "near.md"), "---\nname: near\ndescription: user one\n---\nuser\n");
	w(join(HOME, ".claude", "agents", "scout.md"), "---\nname: scout\ndescription: claude scout\n---\nclaude\n");
	w(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: pi scout\n---\npi\n");
	const names = (l) => l.map((a) => `${a.name}:${a.description}`);
	let x = await load({ LETS_CODE_CLAUDE_CODE_ON: "1" });
	t("untrusted: only the user's Claude agents, after pi's", names(x.discoverAgents(cwd, false)), ["scout:pi scout", "near:user one"]);
	x = await load({ LETS_CODE_CLAUDE_CODE_ON: "1", LETS_CODE_CLAUDE_TRUST: "1" });
	t("trusted: project .claude/agents up to the git root, nearest first", names(x.discoverAgents(cwd, false)), ["scout:pi scout", "near:nearest", "gemini-research-expert:research"]);
	x = await load({});
	t("adapter off: no Claude agents", names(x.discoverAgents(cwd, false)), ["scout:pi scout"]);
}
rmSync(work, { recursive: true, force: true });
process.exit(fail);
