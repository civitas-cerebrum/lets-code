#!/usr/bin/env node
// Unit test for the Claude Code adapter lets-code writes
// (~/.pi/agent/extensions/lets-code/claude-code.ts): settings, trust, hook
// matching and the hook contract (stdin JSON, exit codes, JSON output),
// tool-argument translation both ways, permission rules, command templates,
// MCP mapping, CLAUDE.md context and the workflow runtime with a fake
// runner; then the extension itself on a fake pi API in a scratch project
// with a .claude/ folder. Needs Node >= 22.6.
//
//   tests/claude-code.test.mjs [path/to/lets-code/claude-code.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/claude-code.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "claude-code-test-")));
const HOME = join(work, "home"); const agentDir = join(HOME, ".pi", "agent"); const claude = join(HOME, ".claude");
mkdirSync(join(agentDir, "extensions"), { recursive: true }); mkdirSync(claude, { recursive: true });
process.env.HOME = HOME; process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.CLAUDE_CONFIG_DIR;
process.env.LETS_CODE_CLAUDE_CODE_ON = "1";
process.env.LETS_CODE_CLAUDE_SCOPE = "all";   // CLAUDE_CODE=all; the default (auto) is checked at the end
for (const k of ["LETS_CODE_SUBAGENT_DEPTH", "LETS_CODE_CLAUDE_TRUST", "LETS_CODE_CLAUDE_ENV", "LETS_CODE_SUBAGENTS_ON"]) delete process.env[k];

// "typebox" is provided by the pi host at runtime; a stand-in is enough here
{
	const nm = join(agentDir, "extensions", "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
	writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }) };\n");
}
const origError = console.error;
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
let loads = 0;
const importModule = async () => { const f = join(agentDir, "extensions", `claude-code-${loads++}.ts`); writeFileSync(f, src); return import(pathToFileURL(f).href); };
const m = await importModule();

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const w = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };

// --- frontmatter
{
	const { fm, body } = m.parseFrontmatter("---\nname: scrape\ndescription: >\n  Finds new jobs\n  across portals.\ntools: [Read, Grep]\nallowed-tools:\n  - Bash(gh *)\n  - Read\nuser-invocable: false\n---\nBody\n");
	t("frontmatter: folded block", fm.description, "Finds new jobs across portals.");
	t("frontmatter: inline list", fm.tools, ["Read", "Grep"]);
	t("frontmatter: block list", fm["allowed-tools"], ["Bash(gh *)", "Read"]);
	t("frontmatter: boolean", fm["user-invocable"], false);
	t("frontmatter: body", body, "Body\n");
	t("asList: comma string keeps parentheses", m.asList("Bash(git add, git commit), Read"), ["Bash(git add, git commit)", "Read"]);
}

// --- matchers
t("matcher: empty and * match all", [m.matcherMatches("", "Bash"), m.matcherMatches("*", "Read"), m.matcherMatches(undefined, "X")], [true, true, true]);
t("matcher: exact name", [m.matcherMatches("Bash", "Bash"), m.matcherMatches("Bash", "BashOutput")], [true, false]);
t("matcher: | list", [m.matcherMatches("Edit|Write", "Write"), m.matcherMatches("Edit|Write", "Read")], [true, false]);
t("matcher: other characters are an unanchored regex", [m.matcherMatches("Edit.*", "NotebookEdit"), m.matcherMatches("^Edit$", "NotebookEdit")], [true, false]);
t("matcher: regex matches inside", m.matcherMatches("Note.*", "NotebookEdit"), true);
t("matcher: mcp regex", [m.matcherMatches("mcp__memory__.*", "mcp__memory__create"), m.matcherMatches("mcp__memory", "mcp__memory__create")], [true, false]);
t("matcher: Task matches the subagent tool (Agent alias)", m.matcherMatches("Task", ["Agent", "Task"]), true);
{
	const hooks = [{ event: "PreToolUse", matcher: "Bash", type: "command", command: "a" }, { event: "PreToolUse", matcher: "*", type: "command", command: "a" }, { event: "PreToolUse", matcher: "Read", type: "command", command: "b" }, { event: "Stop", matcher: "x", type: "command", command: "c" }, { event: "PreToolUse", matcher: "", type: "prompt", prompt: "p" }];
	t("selectHooks: matching, identical commands once, command/http only", m.selectHooks(hooks, "PreToolUse", ["Bash"]).map((h) => h.command), ["a"]);
	t("selectHooks: Stop ignores matchers", m.selectHooks(hooks, "Stop", undefined).map((h) => h.command), ["c"]);
}

// --- tool arguments both ways
{
	const cwd = "/p";
	t("to Claude: bash (timeout s -> ms)", m.toClaudeInput("bash", { command: "ls", timeout: 5 }, cwd), { command: "ls", timeout: 5000, description: "" });
	t("to Claude: read", m.toClaudeInput("read", { path: "a.txt", offset: 3 }, cwd), { file_path: "/p/a.txt", offset: 3 });
	t("to Claude: write", m.toClaudeInput("write", { path: "/x/b", content: "hi" }, cwd), { file_path: "/x/b", content: "hi" });
	t("to Claude: edit", m.toClaudeInput("edit", { path: "c.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd), { file_path: "/p/c.ts", old_string: "a", new_string: "b", replace_all: false });
	t("to Claude: edit with several edits", m.toClaudeInput("edit", { path: "c", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, cwd).edits, [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }]);
	t("to Claude: grep", m.toClaudeInput("grep", { pattern: "x", ignoreCase: true, limit: 5 }, cwd), { pattern: "x", "-i": true, head_limit: 5, output_mode: "content" });
	t("to Claude: find is Glob", [m.claudeToolName("find"), m.toClaudeInput("find", { pattern: "*.ts", path: "src" }, cwd)], ["Glob", { pattern: "*.ts", path: "/p/src" }]);
	t("to Claude: subagent is Agent", [m.claudeToolName("subagent"), m.toClaudeInput("subagent", { agent: "scout", task: "look" }, cwd)], ["Agent", { subagent_type: "scout", prompt: "look", description: "" }]);
	t("back to pi: bash", m.fromClaudeInput("bash", { command: "ls -la", timeout: 2000 }, { command: "ls" }), { command: "ls -la", timeout: 2 });
	t("back to pi: read", m.fromClaudeInput("read", { file_path: "/q" }, { path: "a", limit: 2 }), { path: "/q", limit: 2 });
	t("back to pi: edit", m.fromClaudeInput("edit", { file_path: "/p/c", old_string: "x", new_string: "y" }, { path: "c", edits: [{ oldText: "a", newText: "b" }] }), { path: "/p/c", edits: [{ oldText: "x", newText: "y" }] });
	t("back to pi: grep", m.fromClaudeInput("grep", { pattern: "y", "-i": false }, { pattern: "x", ignoreCase: true }), { pattern: "y", ignoreCase: false });
	t("back to pi: unknown tool keeps the input", m.fromClaudeInput("mcp__s__t", { a: 2 }, { a: 1, b: 1 }), { a: 2, b: 1 });
	t("tool_response: bash", m.toolResponse("bash", {}, [{ type: "text", text: "out" }], false), { stdout: "out", stderr: "", interrupted: false, isImage: false });
}

// --- hook results
{
	const run = (code, stdout = "", stderr = "") => ({ hook: { command: "h" }, code, stdout, stderr });
	t("exit 2 on PreToolUse denies with stderr", (({ decision, reason }) => ({ decision, reason }))(m.interpret("PreToolUse", [run(2, "", "no rm")])), { decision: "deny", reason: "no rm" });
	t("exit 2 on UserPromptSubmit blocks", m.interpret("UserPromptSubmit", [run(2, "", "bad prompt")]).block, "bad prompt");
	t("exit 2 on PostToolUse is feedback for the model", m.interpret("PostToolUse", [run(2, "", "lint failed")]).context, ["lint failed"]);
	t("exit 2 on SessionStart goes to the user only", m.interpret("SessionStart", [run(2, "", "warn")]).notices, ["SessionStart hook: warn"]);
	t("other exit codes: non-blocking notice", m.interpret("PreToolUse", [run(1, "", "oops\nmore")]), { context: [], notices: ["PreToolUse hook failed with non-blocking status code 1: oops"] });
	const json = (o) => run(0, JSON.stringify(o));
	t("deny > ask > allow", m.interpret("PreToolUse", [json({ hookSpecificOutput: { permissionDecision: "allow" } }), json({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope" } }), json({ hookSpecificOutput: { permissionDecision: "ask" } })]).decision, "deny");
	t("ask beats allow", m.interpret("PreToolUse", [json({ hookSpecificOutput: { permissionDecision: "allow" } }), json({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "sure?" } })]).reason, "sure?");
	t("defer leaves the normal flow", m.interpret("PreToolUse", [json({ hookSpecificOutput: { permissionDecision: "defer" } })]).decision, undefined);
	t("updatedInput and additionalContext", (({ updatedInput, context }) => ({ updatedInput, context }))(m.interpret("PreToolUse", [json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "ls" }, additionalContext: "note" } })])), { updatedInput: { command: "ls" }, context: ["note"] });
	t("legacy decision block on PreToolUse denies", m.interpret("PreToolUse", [json({ decision: "block", reason: "r" })]).decision, "deny");
	t("plain stdout is context for UserPromptSubmit", m.interpret("UserPromptSubmit", [run(0, "today is Monday\n")]).context, ["today is Monday"]);
	t("plain stdout is not context for PreToolUse", m.interpret("PreToolUse", [run(0, "debug")]).context, []);
	t("Stop decision block", m.interpret("Stop", [json({ decision: "block", reason: "run the tests" })]).block, "run the tests");
	t("continue false stops with stopReason, systemMessage to the user", (({ stop, notices }) => ({ stop, notices }))(m.interpret("PostToolUse", [json({ continue: false, stopReason: "enough", systemMessage: "hi" })])), { stop: "enough", notices: ["hi"] });
	t("updatedToolOutput", m.interpret("PostToolUse", [json({ hookSpecificOutput: { updatedToolOutput: "short" } })]).updatedOutput, "short");
	t("a timed-out hook is a notice", m.interpret("Stop", [{ hook: { command: "sleep" }, code: null, stdout: "", stderr: "", timedOut: true }]).notices, ["Stop hook timed out: sleep"]);
}
{
	const proj = join(work, "hookproj"); mkdirSync(proj);
	const r = await m.runHook({ event: "PreToolUse", matcher: "", type: "command", command: `cat > got.json; echo "$CLAUDE_PROJECT_DIR" > dir.txt; echo blocked >&2; exit 2`, scope: "user" }, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm x" } }, { cwd: proj });
	t("runHook: exit code and stderr", [r.code, r.stderr.trim()], [2, "blocked"]);
	t("runHook: stdin JSON", JSON.parse(readFileSync(join(proj, "got.json"), "utf8")).tool_input, { command: "rm x" });
	t("runHook: runs in the project dir with CLAUDE_PROJECT_DIR", readFileSync(join(proj, "dir.txt"), "utf8").trim(), proj);
	const slow = await m.runHook({ event: "Stop", type: "command", command: "sleep 5", scope: "user" }, {}, { cwd: proj, timeoutMs: 200 });
	t("runHook: timeout", slow.timedOut, true);
}

// --- trust
{
	const proj = join(work, "trust", "repo", "sub"); mkdirSync(proj, { recursive: true });
	t("untrusted by default", m.trustDecision(proj), { trusted: false, source: "undecided" });
	w(join(HOME, ".claude.json"), JSON.stringify({ projects: { [join(work, "trust")]: { hasTrustDialogAccepted: true } } }));
	t("a parent trusted in Claude Code counts", m.trustDecision(proj), { trusted: true, source: "claude" });
	w(join(HOME, ".claude.json"), JSON.stringify({ projects: { [join(work, "trust")]: { hasTrustDialogAccepted: false } } }));
	t("hasTrustDialogAccepted false is not trust", m.claudeTrusted(proj), false);
	w(join(agentDir, "trust.json"), JSON.stringify({ [join(work, "trust", "repo")]: true }));
	t("pi's trust.json counts", m.trustDecision(proj), { trusted: true, source: "pi" });
	rmSync(join(agentDir, "trust.json"));
	w(join(agentDir, "lets-code-state.json"), JSON.stringify({ other: 1 }));
	m.rememberTrust(proj, false);
	t("remembered no", m.trustDecision(proj), { trusted: false, source: "lets-code" });
	t("remembering keeps other keys", JSON.parse(readFileSync(join(agentDir, "lets-code-state.json"), "utf8")).other, 1);
	rmSync(join(HOME, ".claude.json")); rmSync(join(agentDir, "lets-code-state.json"));
}

// --- settings and permissions
{
	const proj = join(work, "perm"); mkdirSync(proj);
	w(join(claude, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm run test:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "u" }] }] }, env: { A: "user", B: "user" } }));
	w(join(proj, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git *)"], deny: ["Read(./secrets/**)", "Bash(rm *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "p", timeout: 5 }] }] }, env: { B: "project" } }));
	w(join(proj, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Bash(git push *)"] }, env: { C: "local" } }));
	const u = m.loadSettings(proj, false);
	t("untrusted: project allow dropped, deny and ask kept", [u.allow.map((r) => r.raw), u.deny.map((r) => r.raw), u.ask.map((r) => r.raw)], [["Bash(npm run test:*)"], ["Read(./secrets/**)", "Bash(rm *)"], ["Bash(git push *)"]]);
	t("untrusted: project hooks and env held back", [u.hooks.map((h) => h.command), u.untrustedHooks.map((h) => h.command), u.env], [["u"], ["p"], { A: "user", B: "user" }]);
	const s = m.loadSettings(proj, true);
	t("trusted: hooks merge, timeout kept", s.hooks.map((h) => [h.event, h.matcher, h.command, h.timeout ?? null]), [["Stop", "", "u", null], ["PreToolUse", "Bash", "p", 5]]);
	t("trusted: env local > project > user", s.env, { A: "user", B: "project", C: "local" });
	t("Bash prefix rule (:*)", m.permissionCheck(s, "Bash", { command: "npm run test -- --watch" }, proj), { decision: "allow", rule: "Bash(npm run test:*)" });
	t("Bash prefix rule matches the bare command", m.permissionCheck(s, "Bash", { command: "npm run test" }, proj).decision, "allow");
	t("Bash: a word, not a prefix", [m.permissionCheck(s, "Bash", { command: "npm run testing" }, proj).decision, m.permissionCheck(s, "Bash", { command: "npm run test:unit" }, proj).decision], ["none", "none"]);
	t("deny before ask before allow", [m.permissionCheck(s, "Bash", { command: "git status && rm -rf x" }, proj).decision, m.permissionCheck(s, "Bash", { command: "git push origin main" }, proj).decision], ["deny", "ask"]);
	t("allow needs every part of a compound command", [m.permissionCheck(s, "Bash", { command: "git add . && git commit -m x" }, proj).decision, m.permissionCheck(s, "Bash", { command: "git add . && make" }, proj).decision], ["allow", "none"]);
	t("wrappers are stripped", m.permissionCheck(s, "Bash", { command: "timeout 5 rm x" }, proj).decision, "deny");
	t("Read(./secrets/**) covers Read and Grep below it", [m.permissionCheck(s, "Read", { file_path: join(proj, "secrets", "a", "k.pem") }, proj).decision, m.permissionCheck(s, "Grep", { path: join(proj, "secrets") }, proj).decision, m.permissionCheck(s, "Read", { file_path: join(proj, "src", "a") }, proj).decision], ["deny", "deny", "none"]);
	const rules = (list) => ({ allow: [], ask: [], deny: list.map((r) => m.parseRule(r, proj)) });
	t("Edit(.env) at any depth, for Write too", [m.permissionCheck(rules(["Edit(.env)"]), "Write", { file_path: join(proj, "a", ".env") }, proj).decision, m.permissionCheck(rules(["Edit(.env)"]), "Edit", { file_path: join(proj, "a", ".envrc") }, proj).decision], ["deny", "none"]);
	t("//absolute and ~/ paths", [m.permissionCheck(rules(["Read(//etc/**)"]), "Read", { file_path: "/etc/passwd" }, proj).decision, m.permissionCheck(rules(["Read(~/.ssh/**)"]), "Read", { file_path: join(HOME, ".ssh", "id") }, proj).decision], ["deny", "deny"]);
	t("/path is relative to the settings' project", m.permissionCheck(rules(["Edit(/build/**)"]), "Edit", { file_path: join(proj, "build", "x.js") }, proj).decision, "deny");
	t("mcp rules: server, server__*, one tool, dashes", [m.permissionCheck(rules(["mcp__my-srv"]), "mcp__my_srv__q", {}, proj).decision, m.permissionCheck(rules(["mcp__s__*"]), "mcp__s__q", {}, proj).decision, m.permissionCheck(rules(["mcp__s__q"]), "mcp__s__r", {}, proj).decision], ["deny", "deny", "none"]);
	t("Agent(name) and Task(name)", [m.permissionCheck(rules(["Agent(worker)"]), "Agent", { subagent_type: "worker" }, proj).decision, m.permissionCheck(rules(["Task(scout)"]), "Agent", { tasks: [{ agent: "scout" }] }, proj).decision], ["deny", "deny"]);
	t("bare tool name denies every call", m.permissionCheck(rules(["Bash"]), "Bash", { command: "ls" }, proj).decision, "deny");
	t("bashParts splits operators, keeps quotes", m.bashParts(`echo "a;b" && ls | wc -l; (cd x)`), [`echo "a;b"`, "ls", "wc -l", "cd x"]);
	rmSync(join(claude, "settings.json"));
}
{
	const proj = join(work, "dis"); mkdirSync(proj);
	w(join(proj, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }));
	w(join(proj, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
	t("disableAllHooks", m.loadSettings(proj, true).hooks, []);
}

// --- commands and skills
{
	const proj = join(work, "cmds", "app"); mkdirSync(join(work, "cmds", ".git"), { recursive: true }); mkdirSync(proj, { recursive: true });
	w(join(work, "cmds", ".claude", "commands", "frontend", "build.md"), "---\ndescription: Build the UI\nargument-hint: <target>\n---\nBuild $ARGUMENTS now.\n");
	w(join(proj, ".claude", "commands", "fix.md"), "Fix issue $0 with priority $ARGUMENTS[1].\n");
	w(join(claude, "commands", "fix.md"), "user version\n");
	w(join(claude, "commands", "hello.md"), "# Say hello\nHello.\n");
	const cmds = m.discoverCommands(proj);
	t("commands: subdirectories namespace with ':', parents up to the git root", cmds.map((c) => c.name).sort(), ["fix", "frontend:build", "hello"]);
	t("commands: the project wins over the user", cmds.find((c) => c.name === "fix").scope, "project");
	t("commands: description from frontmatter or first line", [cmds.find((c) => c.name === "frontend:build").description, cmds.find((c) => c.name === "hello").description], ["Build the UI", "Say hello"]);
	const tp = { argNames: [], dir: "/d" };
	t("$ARGUMENTS", m.substitute("Do $ARGUMENTS.", "a b", tp), "Do a b.");
	t("$N and $ARGUMENTS[N] are 0-based, quotes group", m.substitute("$0 / $ARGUMENTS[1] / $2", `x "y z"`, tp), "x / y z / ");
	t("named arguments", m.substitute("from $src to $dst", "a b", { argNames: ["src", "dst"], dir: "/d" }), "from a to b");
	t("no placeholder: ARGUMENTS appended", m.substitute("Hello.", "there", tp), "Hello.\n\nARGUMENTS: there");
	t("escaped \\$1 and ${CLAUDE_SKILL_DIR}", m.substitute("cost \\$1 in ${CLAUDE_SKILL_DIR}", "", tp), "cost $1 in /d");
	const ran = [];
	const sh = await m.runShellInjections("Status:\n!`git status`\nnot !`this` inline-ish x!`no`\n```!\necho block\n```\n", async (c) => { ran.push(c); return { code: 0, out: `<${c}>\n` }; });
	t("!`cmd`: run at line start or after whitespace, and ```! blocks", [ran, sh.text], [["git status", "this", "echo block"], "Status:\n<git status>\nnot <this> inline-ish x!`no`\n<echo block>\n"]);
	const bad = await m.runShellInjections("!`false`", async () => ({ code: 2, out: "err" }));
	t("!`cmd` failure aborts", /failed \(exit 2\)/.test(bad.error ?? ""), true);
	const miss = await m.runShellInjections("!`grep x y`", async () => ({ code: 1, out: "" }));
	t("a search that finds nothing is not a failure", miss.error, undefined);
	w(join(proj, "notes.md"), "NOTES");
	t("@file: the text stays, the file follows", m.fileReferences("see @notes.md, and `@not.md`", proj), `see @notes.md, and \`@not.md\`\n\n<file path="${join(proj, "notes.md")}">\nNOTES\n</file>`);
	w(join(work, "cmds", ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploys\n---\nDeploy $ARGUMENTS\n");
	w(join(claude, "skills", "synced", "x", "SKILL.md"), "---\nname: synced-one\ndescription: d\nuser-invocable: false\n---\nx\n");
	w(join(claude, "skills", "mine", "SKILL.md"), "---\ndescription: mine\nuser-invocable: false\n---\nx\n");
	t("skills: project and user, name from frontmatter or dir; claude.ai's synced ones left out", m.discoverSkills(proj).map((s) => [s.name, s.scope, s.userInvocable]), [["deploy", "project", true], ["mine", "user", false]]);
	t("skill dirs for pi: each skill's own folder, without synced/", m.skillDirs(proj), [join(work, "cmds", ".claude", "skills", "deploy"), join(claude, "skills", "mine")]);
	process.env.LETS_CODE_CLAUDE_SYNCED_SKILLS = "1";
	t("synced skills on request", m.discoverSkills(proj).map((s) => s.name), ["deploy", "mine", "synced-one"]);
	delete process.env.LETS_CODE_CLAUDE_SYNCED_SKILLS;
	rmSync(join(claude, "commands"), { recursive: true }); rmSync(join(claude, "skills"), { recursive: true });
}

// --- MCP
{
	const proj = join(work, "mcp"); mkdirSync(proj);
	process.env.CC_TEST_TOKEN = "tok";
	w(join(HOME, ".claude.json"), JSON.stringify({ mcpServers: { shared: { command: "user-cmd" }, userOnly: { type: "http", url: "https://u/${CC_TEST_TOKEN}" } },
		projects: { [proj]: { mcpServers: { shared: { command: "local-cmd" } }, enabledMcpjsonServers: ["a"] } } }));
	w(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "${CC_MISSING:-npx}", args: ["srv", "${CC_TEST_TOKEN}"], env: { K: "${CC_TEST_TOKEN}" } }, b: { command: "b" }, c: { type: "sse", url: "https://x" }, shared: { command: "project-cmd" }, bang: { command: "!rm" } } }));
	const s = m.loadSettings(proj, true);
	const r = m.claudeMcpServers(proj, s, true, false);
	t("MCP: local > project > user, approvals, env expansion", r.servers.map((e) => [e.name, e.scope, e.config.command ?? e.config.url]), [["shared", "local", "local-cmd"], ["a", "project", "npx"], ["userOnly", "user", "https://u/tok"]]);
	t("MCP: args and env expanded", [r.servers[1].config.args, r.servers[1].config.env], [["srv", "tok"], { K: "tok" }]);
	t("MCP: unapproved project server skipped", r.skipped.includes("b (not approved in Claude Code)"), true);
	t("MCP: approved by the trust question here", m.claudeMcpServers(proj, s, true, true).servers.map((e) => e.name).includes("b"), true);
	t("MCP: untrusted folder: no project servers", m.claudeMcpServers(proj, s, false, true).servers.map((e) => e.scope), ["local", "user"]);
	w(join(proj, ".claude", "settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["a"], enableAllProjectMcpServers: true }));
	const r2 = m.claudeMcpServers(proj, m.loadSettings(proj, true), true, false);
	t("MCP: disabledMcpjsonServers wins over enableAll", r2.servers.map((e) => e.name), ["shared", "b", "userOnly"]);
	t("MCP: sse and '!' values skipped with a reason", r2.skipped.sort(), ["bang (a value starts with '!')", "c (transport sse is not supported by pi)"]);
	t("expandVars default", m.expandVars("${NOPE:-d}/${CC_TEST_TOKEN}"), "d/tok");
	rmSync(join(HOME, ".claude.json"));
}

// --- CLAUDE.md context
{
	const root = join(work, "mem"); const proj = join(root, "pkg"); mkdirSync(join(root, ".git"), { recursive: true }); mkdirSync(proj, { recursive: true });
	w(join(claude, "CLAUDE.md"), "user prefs @~/.claude/extra.md");
	w(join(claude, "extra.md"), "extra");
	w(join(root, "AGENTS.md"), "agents");
	w(join(root, "CLAUDE.md"), "claude root\n@docs/a.md\n```\n@docs/ignored.md\n```\n@" + join(work, "outside.md"));
	w(join(root, "docs", "a.md"), "A @b.md"); w(join(root, "docs", "b.md"), "B @c.md"); w(join(root, "docs", "c.md"), "C @d.md"); w(join(root, "docs", "d.md"), "D @e.md"); w(join(root, "docs", "e.md"), "E");
	w(join(root, "docs", "ignored.md"), "no"); w(join(work, "outside.md"), "outside");
	w(join(proj, "CLAUDE.md"), "pkg @../AGENTS.md"); w(join(proj, "CLAUDE.local.md"), "local");
	w(join(proj, ".claude", "rules", "style.md"), "rule"); w(join(proj, ".claude", "rules", "scoped.md"), "---\npaths: src/**\n---\nscoped");
	const existing = [{ path: join(root, "AGENTS.md"), content: "agents" }, { path: join(proj, "CLAUDE.md"), content: "pkg @../AGENTS.md" }];
	const names = (l) => l.map((f) => f.path.replace(work + "/", ""));
	const files = m.claudeContextFiles(proj, existing, false);
	t("context: Claude's files in place, imports after their file (4 hops), each once", names(files), ["home/.claude/CLAUDE.md", "home/.claude/extra.md", "mem/AGENTS.md", "mem/CLAUDE.md", "mem/docs/a.md", "mem/docs/b.md", "mem/docs/c.md", "mem/docs/d.md", "mem/pkg/CLAUDE.md", "mem/pkg/CLAUDE.local.md", "mem/pkg/.claude/rules/style.md"]);
	t("context: an import outside the project needs trust", names(m.claudeContextFiles(proj, existing, true)).includes("outside.md"), true);
	w(join(root, "CLAUDE.md"), "agents");
	t("context: a CLAUDE.md identical to the AGENTS.md is not added", names(m.claudeContextFiles(proj, existing, false)).includes("mem/CLAUDE.md"), false);
	rmSync(join(claude, "CLAUDE.md")); rmSync(join(claude, "extra.md"));
}

// --- workflows
{
	const src = `export const meta = { name: 'review', description: 'Reviews', phases: [{ title: 'scan' }] };
phase('scan');
const files = await agent('list files', { label: 'lister', schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } } });
const notes = await parallel(files.files.map((f) => () => agent('review ' + f)));
const both = await pipeline(['a', 'b'], (x) => agent('one ' + x), (y) => agent('two ' + y));
const bad = await parallel([() => { throw new Error('x'); }, async () => 'ok']);
log('done', args);
return { files: files.files, notes, both, bad, args };`;
	t("parseWorkflow: meta without running the script", m.parseWorkflow(src).meta, { name: "review", description: "Reviews", phases: [{ title: "scan" }] });
	t("parseWorkflow: no meta", m.parseWorkflow("return 1"), null);
	let live = 0, peak = 0; const prompts = []; const progress = [];
	let first = true;
	const runAgent = async (prompt) => {
		prompts.push(prompt.split("\n")[0]); live++; peak = Math.max(peak, live);
		await new Promise((r) => setTimeout(r, 20)); live--;
		if (prompt.startsWith("list files")) { if (first) { first = false; return { text: "here: {\"nofiles\": 1}", ok: true }; } return { text: "```json\n{\"files\": [\"x.ts\", \"y.ts\", \"z.ts\"]}\n```", ok: true }; }
		return { text: `did ${prompt.split("\n")[0]}`, ok: true };
	};
	const r = await m.runWorkflow({ source: src }, { pr: 7 }, { runAgent, concurrency: 2, onProgress: (l) => progress.push(l) });
	t("workflow: schema reply parsed after one retry", r.result.files, ["x.ts", "y.ts", "z.ts"]);
	t("workflow: parallel results in order", r.result.notes, ["did review x.ts", "did review y.ts", "did review z.ts"]);
	t("workflow: pipeline stages", r.result.both, ["did two did one a", "did two did one b"]);
	t("workflow: a failed item is null", r.result.bad, [null, "ok"]);
	t("workflow: args", r.result.args, { pr: 7 });
	t("workflow: concurrency limit", peak, 2);
	t("workflow: agent count (retry included)", r.agents, 9);
	t("workflow: progress (phase, labels, log)", [progress[0], progress[1], progress.at(-1)], ["phase: scan", "scan: lister", "done {\"pr\":7}"]);
	const ac = new AbortController(); ac.abort();
	const stopped = await m.runWorkflow({ source: "export const meta = { name: 'x' };\nreturn await agent('a');" }, undefined, { runAgent, concurrency: 2, signal: ac.signal });
	t("workflow: aborted agent() is null", stopped.result, null);
	t("validate", [m.validate({ a: 1 }, { type: "object", required: ["a", "b"] }), m.validate([1, "x"], { type: "array", items: { type: "number" } }), m.validate("b", { enum: ["a", "b"] })], ["$.b is missing", "$[1] should be number", null]);
}

// --- workflows switch themselves on for a prompt that asks for one
{
	const list = [{ name: "band-name", description: "Invent a band name from a random animal and a random color" }, { name: "deep-research", description: "Research a question across many sources in parallel and write a cited report" }, { name: "review-pr", description: "Review a pull request in parallel: one agent per changed file, then summarize the findings" },
		{ name: "release", description: "Prepare a release: bump the version, write the changelog and tag it" }];
	for (const [p, want] of [
		["run the release workflow for 2.1", ["release"]],
		["/review-pr 42", ["review-pr"]],
		["can you review-pr #42 please", ["review-pr"]],
		["review pull request 42 and summarize the findings per changed file", ["review-pr"]],
		["prepare a release: bump the version and write the changelog", ["release"]],
		["Come up with a band name from a random animal and a random color.", ["band-name"]],
		["research this question across many sources and write a cited report: is Rust faster than Go?", ["deep-research"]],
	]) t(`trigger: "${p}"`, m.workflowMatches(p, list), want);
	for (const p of [
		"fix the failing test in src/app.ts",
		"review my changes",
		"what is the latest release of node?",
		"update the GitHub release workflow yaml",
		"explain `run the release workflow` in this snippet",
		"bump the version in package.json",
		"write a changelog entry for the fix",
		"Morning job sweep. Run the scrape command as established: search the portals, dedupe against the tracker, rank the new postings against the profile, research the top companies, write a short report and email the shortlist.",
	]) t(`no trigger: "${p}"`, m.workflowMatches(p, list), []);
	const sec = m.workflowSection([list[2]]);
	t("the section: two lines, names the tool and the workflow", [sec.split("\n").length, /workflow\(\{name: "review-pr"/.test(sec)], [2, true]);
	console.log(`      (section: ${sec.length} characters)`);
}

// --- the extension on a fake pi API
async function load(cwd, env = {}) {
	const saved = process.cwd(); process.chdir(cwd);
	for (const k of ["LETS_CODE_SUBAGENT_DEPTH", "LETS_CODE_CLAUDE_TRUST", "LETS_CODE_CLAUDE_ENV", "LETS_CODE_SUBAGENTS_ON"]) delete process.env[k];
	Object.assign(process.env, env);
	const mod = await importModule();
	const handlers = {}; const commands = {}; const tools = {}; const mcp = []; const sent = []; const messages = [];
	let active = ["read", "bash", "edit", "write", "grep"];
	mod.default({
		on(ev, h) { (handlers[ev] ??= []).push(h); return () => {}; },
		registerCommand(n, o) { commands[n] = o; }, registerTool(d) { tools[d.name] = d; },
		registerMcpServer(n, c) { mcp.push([n, c]); }, sendUserMessage(text, o) { sent.push([text, o ?? null]); }, sendMessage(msg) { messages.push(msg); },
		getActiveTools: () => active, setActiveTools(l) { active = l; },
	});
	process.chdir(saved);
	const notes = []; const selects = [];
	console.error = (msg) => notes.push(String(msg));
	const ctx = (ui) => ({ cwd, hasUI: !!ui, signal: undefined, abort() {}, isIdle: () => true, sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/s.jsonl" },
		ui: { notify: (msg) => notes.push(msg), select: async (title, opts) => { selects.push(title); return ui?.answer ?? opts[0]; }, setStatus() {} } });
	const emit = async (ev, e, c) => { let out; for (const h of handlers[ev] ?? []) { const r = await h(e, c); if (r !== undefined) out = r; } return out; };
	return { handlers, commands, tools, mcp, sent, messages, notes, selects, ctx, emit, active: () => active };
}
{
	const proj = join(work, "live"); mkdirSync(proj);
	const log = join(proj, "hook.log");
	w(join(claude, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo 'session context'" }] }] } }));
	w(join(proj, ".claude", "settings.json"), JSON.stringify({
		permissions: { deny: ["Read(./private/**)", "WebFetch"], ask: ["Bash(git push *)"], allow: ["Bash(ls *)"] },
		hooks: {
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `cat >> ${log}; echo >> ${log}`}] },
				{ matcher: "Bash", hooks: [{ type: "command", command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(/^rm /.test(j.tool_input.command)){console.error("rm is not allowed here");process.exit(2)}if(j.tool_input.command==="ls")console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{command:"ls -1"}}}))})'` }] }],
			PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"formatted\"}}'" }] }],
			UserPromptSubmit: [{ hooks: [{ type: "command", command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(/secret/.test(j.prompt)){console.error("no secrets");process.exit(2)}console.log("ticket ABC-1")})'` }] }],
			Stop: [{ hooks: [{ type: "command", command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.stop_hook_active)console.log(JSON.stringify({decision:"block",reason:"run the tests first"}))})'` }] }],
		},
	}));
	w(join(proj, ".claude", "commands", "greet.md"), "---\ndescription: Greets\n---\nSay hello to $ARGUMENTS. Branch: !`echo main`\n");
	w(join(proj, ".claude", "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidies up\n---\nTidy $ARGUMENTS\n");
	w(join(proj, ".claude", "workflows", "wf.js"), "export const meta = { name: 'wf', description: 'demo' };\nreturn 1;");

	// untrusted, no UI: project parts skipped with a note, deny still applies
	let x = await load(proj);
	t("commands and skills registered (no /workflow without subagents)", Object.keys(x.commands).sort(), ["greet", "tidy"]);
	await x.emit("session_start", { reason: "startup" }, x.ctx(null));
	t("untrusted without a UI: one note", x.notes.filter((n) => /not trusted/.test(n)).length, 1);
	t("deny applies untrusted", (await x.emit("tool_call", { toolName: "read", toolCallId: "1", input: { path: "private/k" } }, x.ctx(null)))?.block, true);
	t("project hooks do not run untrusted", await x.emit("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "rm -rf x" } }, x.ctx(null)), undefined);
	t("a bare deny takes the tool away (none here)", x.active(), ["read", "bash", "edit", "write", "grep"]);
	const bm = await x.emit("before_agent_start", { prompt: "hi", systemPromptOptions: { contextFiles: [] } }, x.ctx(null));
	t("user SessionStart hook ran: its stdout is context for the first prompt", bm?.message?.content, m.hookContext("session context"));
	await x.commands.greet.handler("Ann", { ...x.ctx(null), isIdle: () => false });
	t("a project command with !`cmd` is not run untrusted", [x.sent.length, x.notes.some((n) => /runs shell commands/.test(n))], [0, true]);

	// with a UI: asked once; trusting runs everything
	x = await load(proj, { LETS_CODE_SUBAGENTS_ON: "1" });
	t("/workflow and /wf with subagents on", ["workflow", "wf"].every((n) => n in x.commands) && "workflow" in x.tools, true);
	const c = x.ctx({ answer: "Trust this folder" });
	await x.emit("session_start", { reason: "startup" }, c);
	t("asked once, listing the hooks", [x.selects.length, /PreToolUse: cat >>/.test(x.selects[0] ?? "")], [1, true]);
	t("the answer is remembered", m.rememberedTrust(proj), true);
	t("trust passed on to subagents", process.env.LETS_CODE_CLAUDE_TRUST, "1");
	const blocked = await x.emit("tool_call", { toolName: "bash", toolCallId: "3", input: { command: "rm -rf build" } }, c);
	t("PreToolUse exit 2 blocks with the hook's stderr", blocked, { block: true, reason: "PreToolUse hook: rm is not allowed here" });
	t("the hook saw Claude's stdin", JSON.parse(readFileSync(log, "utf8").split("\n")[0]).tool_name, "Bash");
	const ev = { toolName: "bash", toolCallId: "4", input: { command: "ls" } };
	t("allow + updatedInput", [await x.emit("tool_call", ev, c), ev.input.command], [undefined, "ls -1"]);
	t("an allowed call is marked for the mandate", globalThis.__letsCodeClaudeApproved.has("4"), true);
	const ask = await x.emit("tool_call", { toolName: "bash", toolCallId: "5", input: { command: "git push origin main" } }, x.ctx({ answer: "Deny" }));
	t("ask rule: the user is asked, a no blocks", ask?.block, true);
	const askNoUi = await x.emit("tool_call", { toolName: "bash", toolCallId: "6", input: { command: "git push" } }, x.ctx(null));
	t("ask rule without a UI blocks", /needs approval/.test(askNoUi?.reason ?? ""), true);
	const res = await x.emit("tool_result", { toolName: "write", toolCallId: "7", input: { path: "a.txt", content: "x" }, content: [{ type: "text", text: "wrote" }], isError: false }, c);
	t("PostToolUse additionalContext reaches the model", res?.content?.map((p) => p.text), ["wrote", "\n[lets-code] PostToolUse hook (configured by the user in .claude/settings.json):\nformatted"]);
	t("UserPromptSubmit exit 2 drops the prompt", await x.emit("input", { text: "my secret", source: "interactive" }, c), { action: "handled" });
	await x.emit("input", { text: "fix it", source: "interactive" }, c);
	const b2 = await x.emit("before_agent_start", { prompt: "fix it", systemPromptOptions: { contextFiles: [] } }, c);
	t("SessionStart and UserPromptSubmit context go in with the prompt", b2?.message?.content, m.hookContext("session context\n\nticket ABC-1"));
	const settle = await x.emit("agent_before_settle", { outcome: "completed", continue: false, entries: [], context: { llmMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } }, c);
	t("Stop decision block continues with the reason", [settle?.continue, settle?.entries?.[0]?.content], [true, "Stop hook: run the tests first"]);
	t("second Stop: stop_hook_active lets it end", await x.emit("agent_before_settle", { outcome: "completed", continue: false, entries: [], context: { llmMessages: [] } }, c), undefined);
	t("another extension continuing: Stop does not run", await x.emit("agent_before_settle", { outcome: "completed", continue: true, entries: [], context: { llmMessages: [] } }, c), undefined);
	await x.commands.greet.handler("Ann", c);
	t("command: $ARGUMENTS and !`cmd` expanded, sent as a prompt", x.sent.at(-1)?.[0], "Say hello to Ann. Branch: main\n");
	await x.commands.tidy.handler("src", c);
	t("skill as /name", x.sent.at(-1)?.[0], `<skill name="tidy" location="${join(proj, ".claude", "skills", "tidy", "SKILL.md")}">\nReferences are relative to ${join(proj, ".claude", "skills", "tidy")}.\n\nTidy src\n</skill>`);
	t("resources_discover hands pi each skill folder", (await x.emit("resources_discover", { cwd: proj, reason: "startup" }, c))?.skillPaths, [join(proj, ".claude", "skills", "tidy")]);
	t("workflow tool lists without a name", (await x.tools.workflow.execute("w", {}, undefined, undefined, c)).content[0].text, "- wf: demo");
	const plain = { prompt: "fix the bug", systemPromptOptions: { contextFiles: [], sections: {} } };
	await x.emit("before_agent_start", plain, c);
	t("an unrelated prompt adds no workflow section", plain.systemPromptOptions.sections, {});
	const asks = { prompt: "run the wf workflow", systemPromptOptions: { contextFiles: [], sections: {} } };
	await x.emit("before_agent_start", asks, c);
	t("a prompt that asks for it adds the section", /- wf: demo/.test(asks.systemPromptOptions.sections.lets_code_workflows ?? ""), true);
	const later = { prompt: "thanks", systemPromptOptions: { contextFiles: [], sections: {} } };
	await x.emit("before_agent_start", later, c);
	t("  and it stays for the session", "lets_code_workflows" in later.systemPromptOptions.sections, true);

	// a subagent: the parent's decision, no SessionStart, Stop becomes SubagentStop
	x = await load(proj, { LETS_CODE_SUBAGENT_DEPTH: "1", LETS_CODE_CLAUDE_TRUST: "1", LETS_CODE_AGENT_NAME: "scout" });
	t("child: no commands", Object.keys(x.commands), []);
	await x.emit("session_start", { reason: "startup" }, x.ctx(null));
	t("child: PreToolUse hooks apply", (await x.emit("tool_call", { toolName: "bash", toolCallId: "8", input: { command: "rm x" } }, x.ctx(null)))?.block, true);
	t("child: Stop hooks do not run as Stop", await x.emit("agent_before_settle", { outcome: "completed", continue: false, entries: [], context: { llmMessages: [] } }, x.ctx(null)), undefined);
	rmSync(join(claude, "settings.json"));
}
{
	const proj = join(work, "gone"); mkdirSync(proj);
	w(join(claude, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash", "Edit"] } }));
	const x = await load(proj);
	await x.emit("session_start", { reason: "startup" }, x.ctx(null));
	t("bare deny rules take the tools away", x.active(), ["read", "grep"]);
	rmSync(join(claude, "settings.json"));
}

// --- auto (the default): the project's .claude only, never the user's own
{
	delete process.env.LETS_CODE_CLAUDE_SCOPE;
	const proj = join(work, "auto"); mkdirSync(join(proj, ".git"), { recursive: true });
	w(join(claude, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "u" }] }] }, env: { A: "user" } }));
	w(join(claude, "skills", "mine", "SKILL.md"), "---\ndescription: mine\n---\nx\n");
	w(join(claude, "skills", "synced", "a", "docs", "SKILL.md"), "---\nname: docs\ndescription: d\n---\nx\n");
	w(join(claude, "skills", "synced", "b", "docs", "SKILL.md"), "---\nname: docs\ndescription: d\n---\nx\n");
	w(join(claude, "commands", "hello.md"), "hi");
	w(join(claude, "CLAUDE.md"), "USER MEMORY");
	w(join(proj, ".claude", "skills", "dup", "SKILL.md"), "---\ndescription: d\n---\nx\n");
	w(join(proj, ".claude", "skills", "own", "SKILL.md"), "---\ndescription: o\n---\nx\n");
	w(join(agentDir, "skills", "dup", "SKILL.md"), "---\ndescription: pi's\n---\nx\n");
	t("auto: no user settings (hooks, env, rules)", m.settingsLayers(proj).map((l) => l.scope), []);
	t("auto: no user skills; a name pi has stays pi's", m.discoverSkills(proj).map((s) => s.name), ["own"]);
	t("auto: skill dirs one by one, none duplicated", m.skillDirs(proj), [join(proj, ".claude", "skills", "own")]);
	t("auto: no user commands", m.discoverCommands(proj).map((c) => c.name), []);
	t("auto: no user CLAUDE.md", m.claudeContextFiles(proj, [], true).map((f) => f.content), []);
	t("home folder: its .claude is the user's, not a project", [m.settingsLayers(HOME).length, m.discoverSkills(HOME).length, m.skillDirs(HOME).length, m.discoverCommands(HOME).length], [0, 0, 0, 0]);
	process.env.LETS_CODE_CLAUDE_SCOPE = "all";
	t("all, home folder: the user's skills once each, synced/ left out", m.skillDirs(HOME), [join(claude, "skills", "mine")]);
	for (const p of [join(claude, "settings.json"), join(claude, "skills"), join(claude, "commands"), join(claude, "CLAUDE.md"), join(agentDir, "skills")]) rmSync(p, { recursive: true, force: true });
}

console.error = origError;
rmSync(work, { recursive: true, force: true });
process.exit(fail);
