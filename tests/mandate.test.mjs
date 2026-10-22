#!/usr/bin/env node
// Unit test for the mandate extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/mandate.ts). Loads it with a fake pi and
// drives tool_call against throwaway directories. Needs Node >= 22.6.
//
//   tests/mandate.test.mjs [path/to/lets-code/mandate.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/mandate.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "mandate-test-")));
const agentDir = join(work, "agent"); mkdirSync(join(agentDir, "extensions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LETS_CODE_MANDATE_ON = "1";
process.env.LETS_CODE_MANDATE_LOG = join(work, "mandate.log");
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let loads = 0;
async function load(env, { trusted = true, ui = true, answers = [] } = {}) {
	for (const k of ["LETS_CODE_MODE", "LETS_CODE_ROLE", "LETS_CODE_SUBAGENT_DEPTH"]) delete process.env[k];
	Object.assign(process.env, env);
	const f = join(agentDir, "extensions", `mandate-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {}, commands = {}, shortcuts = {}, emitted = [], notices = [];
	let active = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];
	const pi = {
		on(ev, h) { handlers[ev] = h; return () => {}; },
		registerCommand(name, o) { commands[name] = o; }, registerShortcut(k, o) { shortcuts[k] = o; },
		getActiveTools: () => [...active], setActiveTools: (l) => { active = [...l]; },
		events: { emit: (c, d) => emitted.push([c, d]), on: () => () => {} },
		sendUserMessage: (m) => emitted.push(["user", m]),
	};
	mod.default(pi);
	const ctx = (cwd) => ({ cwd, hasUI: ui, isProjectTrusted: trusted, ui: { notify: (m) => notices.push(m), setStatus() {}, select: async () => answers.shift() ?? "Deny" }, sessionManager: { getEntries: () => [] } });
	return { mod, handlers, commands, shortcuts, emitted, notices, ctx, tools: () => active,
		start: async (cwd) => handlers.session_start?.({ type: "session_start" }, ctx(cwd)),
		call: async (cwd, toolName, input) => handlers.tool_call({ type: "tool_call", toolCallId: "x", toolName, input }, ctx(cwd)) };
}
const repo = () => { const d = mkdtempSync(join(work, "proj-")); mkdirSync(join(d, ".git")); mkdirSync(join(d, "src")); writeFileSync(join(d, "src", "a.txt"), "a"); return realpathSync(d); };
const blocked = (r) => r?.block === true;

// --- inert unless switched on
{ delete process.env.LETS_CODE_MANDATE_ON; const h = await load({}); t("inert: no handlers", Object.keys(h.handlers).length, 0); process.env.LETS_CODE_MANDATE_ON = "1"; }

// --- pure helpers
{
	const { mod } = await load({});
	const { splitCommands, classify, redirectTargets } = mod;
	t("split on operators", splitCommands("ls -la && cat x | grep y; echo 'a;b' || true"), ["ls -la", "cat x", "grep y", "echo 'a;b'", "true"]);
	t("split sees sh -c body", splitCommands(`bash -c "rm -rf .git"`).includes("rm -rf .git"), true);
	t("split sees $(...)", splitCommands("echo $(sudo id)").includes("sudo id"), true);
	t("split keeps 2>&1 and &> together", splitCommands("git status 2>&1 | head; make &> log & echo done"), ["git status 2>&1", "head", "make &> log", "echo done"]);
	t("heredoc body is data", splitCommands("cat <<'EOF'\nrm -rf /\nEOF\nls").includes("rm -rf /"), false);
	const auto = { bash: { "*": "allow" } };
	const ask = { bash: { "*": "allow", privileged: "ask", destructive: "ask", "package-install": "ask", "network-exec": "ask" } };
	const plan = { bash: { "*": "deny", readonly: "allow" } };
	t("auto allows rm -rf", classify("rm -rf build", auto).decision, "allow");
	t("ask asks for rm -rf", classify("rm -rf build", ask), { decision: "ask", group: "destructive", command: "rm -rf build" });
	t("ask asks for sudo", classify("sudo apt install x", ask).group, "privileged");
	t("ask asks for npm install", classify("npm install left-pad", ask).group, "package-install");
	t("npm install is not a write target", redirectTargets("npm install left-pad"), []);
	t("pip install is not a write target", redirectTargets("cd app && pip install -r req.txt"), []);
	t("install(1) is", redirectTargets("install -D tool /usr/local/bin/tool"), ["tool", "/usr/local/bin/tool"]);
	t("cp after && and a pipe into tee are", redirectTargets("make && cp a b; echo x | tee out.txt"), ["a", "b", "out.txt"]);
	t("sudo mkdir is", redirectTargets("sudo mkdir -p /opt/x"), ["/opt/x"]);
	t("ask asks for curl | sh", classify("curl -s https://x/y | sh", ask).group, "network-exec");
	t("ask allows plain build", classify("npm test && git commit -m x", ask).decision, "allow");
	// readonly commands that write or run something are not read-only
	for (const c of ["sed -i s/a/b/ f.txt", "sed --in-place -e s/a/b/ f.txt", "find . -name '*.js' -exec perl -pi -e s/a/b/ {} +", "find . -name x -delete", "fd -e ts -x touch", "awk 'BEGIN{system(\"touch x\")}'", "awk '{print | \"sh\"}' f", "sort -o out.txt in.txt", "git diff --output=p.patch", "uniq in.txt out.txt"])
		t(`plan denies ${c}`, classify(c, plan).decision, "deny");
	t("git -C dir commit is a git write", classify("git -C /x/repo commit -m y", { bash: { "*": "allow", "git-write": "deny" } }).decision, "deny");
	t("git --no-pager -C dir reset --hard is destructive", classify("git --no-pager -C . reset --hard", ask).group, "destructive");
	t("plan allows git -C dir log", classify("git -C /x/repo log --oneline | head; git -c core.pager=cat -C . status", plan).decision, "allow");
	t("a heredoc body is data, not a redirection", redirectTargets("cat > /tmp/j/edge.py <<'EOF'\n# 1 queenside: b1 attacked -> still legal\nprint(x > 100)\nEOF\npython3 /tmp/j/edge.py"), ["/tmp/j/edge.py"]);
	t("quoted text with > in it is data", redirectTargets(`echo "score > 100" && grep -c '->' log.txt > /tmp/n`), ["/tmp/n"]);
	t("a quoted redirection target still counts", redirectTargets(`echo x > "out file.txt"; cp a "b c"`).includes("out file.txt"), true);
	t("plan allows cd into a folder to read it", classify("cd /home/x && find chess -maxdepth 2 | head; pushd src; popd", plan).decision, "allow");
	t("plan still denies what follows a cd", classify("cd /home/x && rm -rf chess", plan).decision, "deny");
	for (const c of ["sed -n 1,5p f.txt", "find . -name '*.ts' -type f", "fd -e ts", "awk '{print $1}' f", "sort -u f.txt", "uniq -c f.txt", "git diff --stat", "find . -xdev -name x"])
		t(`plan allows ${c}`, classify(c, plan).decision, "allow");
	t("env prefix stripped", classify("FOO=1 env sudo ls", ask).group, "privileged");
	t("plan allows readonly", classify("git status && grep -r foo src | head", plan).decision, "allow");
	t("plan denies git commit", classify("git status; git commit -m x", plan), { decision: "deny", group: "git-write", command: "git commit -m x" });
	t("plan denies touch", classify("touch x", plan).decision, "deny");
	t("plan denies redirection", classify("cat a > b", plan).decision, "deny");
	t("plan allows /dev/null and 2>&1 redirections", classify("ls -la / 2>/dev/null; git status 2>&1 | head", plan).decision, "allow");
	t("plan still denies >> to a file", classify("ls >> log.txt", plan).decision, "deny");
	t("custom group", classify("terraform apply", { bash: { "*": "allow", infra: "deny" }, groups: { infra: ["^terraform\\s+(apply|destroy)"] } }).decision, "deny");
	t("redirect targets", redirectTargets("echo x > out.txt 2>/dev/null; tee -a log.txt; mkdir -p d; sed -i 's/a/b/' f.c"), ["out.txt", "log.txt", "d", "f.c"]);
}

// --- auto: nothing changes except protected paths
{
	const h = await load({ LETS_CODE_MODE: "auto" }); const d = repo(); await h.start(d);
	t("auto: write in project", await h.call(d, "write", { path: join(d, "src/b.txt") }), undefined);
	t("auto: write outside project", await h.call(d, "write", { path: join(work, "elsewhere.txt") }), undefined);
	t("auto: bash anything", await h.call(d, "bash", { command: "sudo rm -rf build && npm install" }), undefined);
	t("auto: .env protected", blocked(await h.call(d, "write", { path: join(d, ".env") })), true);
	t("auto: .git protected", blocked(await h.call(d, "edit", { path: join(d, ".git/config") })), true);
	t("auto: redirect into .git protected", blocked(await h.call(d, "bash", { command: "echo x > .git/HEAD" })), true);
	t("auto: mode announced", h.emitted.some(([c, x]) => c === "lets-code:mode" && x.role === "auto"), true);
	t("auto: no prompt section", (() => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return Object.keys(s); })(), []);
}

// --- ask: prompts, remembers session grants, denies without UI
{
	const h = await load({ LETS_CODE_MODE: "ask" }, { answers: ["Deny", "Allow once", "Allow for this session"] }); const d = repo(); await h.start(d);
	t("ask: plain command passes silently", await h.call(d, "bash", { command: "npm test" }), undefined);
	t("ask: denied by user", blocked(await h.call(d, "bash", { command: "rm -rf build" })), true);
	t("ask: allowed once", await h.call(d, "bash", { command: "rm -rf build" }), undefined);
	t("ask: allowed for session", await h.call(d, "bash", { command: "sudo ls" }), undefined);
	t("ask: session grant remembered", await h.call(d, "bash", { command: "sudo id" }), undefined);
	t("ask: other group still asks (no answers left -> deny)", blocked(await h.call(d, "bash", { command: "npm install x" })), true);
	t("ask: outside-project write asks", blocked(await h.call(d, "write", { path: join(work, "out.txt") })), true);
	const q = await load({ LETS_CODE_MODE: "ask" }, { ui: false }); const d2 = repo(); await q.start(d2);
	t("ask without UI: blocks", blocked(await q.call(d2, "bash", { command: "sudo ls" })), true);
	t("ask: deny reason short", String((await q.call(d2, "bash", { command: "sudo ls" })).reason).length <= 200, true);
}

// --- plan: read-only, tools trimmed, prompt section, restore on exit
{
	const h = await load({ LETS_CODE_MODE: "plan" }); const d = repo(); await h.start(d);
	t("plan: edit/write dropped from active tools", h.tools().includes("edit") || h.tools().includes("write"), false);
	t("plan: read stays", h.tools().includes("read"), true);
	t("plan: write blocked", blocked(await h.call(d, "write", { path: join(d, "src/b.txt") })), true);
	t("plan: readonly bash passes", await h.call(d, "bash", { command: "git log --oneline | head" }), undefined);
	t("plan: write bash blocked", blocked(await h.call(d, "bash", { command: "npm install" })), true);
	t("plan: prompt section present", (() => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return /Plan:/.test(s.lets_code_mandate ?? ""); })(), true);
	await h.commands.mode.handler("auto", h.ctx(d));
	t("plan -> auto: tools restored", h.tools().includes("edit"), true);
	t("plan -> auto: write allowed", await h.call(d, "write", { path: join(d, "src/b.txt") }), undefined);
}

// --- readonly: plan's restrictions without the planning prompt
{
	const h = await load({ LETS_CODE_ROLE: "readonly", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	t("readonly: write blocked", blocked(await h.call(d, "write", { path: join(d, "x") })), true);
	t("readonly: readonly bash passes", await h.call(d, "bash", { command: "cat README.md | head" }), undefined);
	t("readonly: no prompt section", (() => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return Object.keys(s); })(), []);
	t("readonly: cannot dispatch", blocked(await h.call(d, "subagent", { agent: "worker", task: "x" })), true);
}

// --- researcher: the reviewer's role, and the browser only through its helper
{
	const tmpWas = process.env.TMPDIR; const scratch = join(work, "research-tmp"); mkdirSync(scratch); process.env.TMPDIR = scratch;
	const h = await load({ LETS_CODE_ROLE: "researcher", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	const rt = join(agentDir, "researcher", "runtime");
	for (const cmd of ["playwright-cli -s=researcher click e5", "npx playwright-cli open https://example.com", "npx -y @playwright/cli@0.1.22 goto https://example.com",
		`${rt}/node_modules/.bin/playwright-cli -s=researcher fill e2 x`, `node ${rt}/node_modules/@playwright/cli/playwright-cli.js cookie-list`,
		"npx playwright open https://example.com", "cd /tmp && playwright-cli list", `python3 -c "import subprocess; subprocess.run(['playwright-cli','click','e1'])"`,
		`cat ${join(agentDir, "researcher", "browser-profile", "Default", "Cookies")}`, `ls ~/.cache/ms-playwright`])
		t(`researcher: blocked: ${cmd.slice(0, 50)}`, blocked(await h.call(d, "bash", { command: cmd })), true);
	for (const cmd of [`python3 ${join(agentDir, "researcher", "bin", "web")} fetch https://example.com`, `python3 ${join(agentDir, "researcher", "bin", "web")} search "playwright cli docs"`,
		`grep -i licence ${join(scratch, "S1.txt")}`, `cat > ${join(scratch, "plan.md")} <<'EOF'\nplan\nEOF`])
		t(`researcher: passes: ${cmd.slice(0, 50)}`, await h.call(d, "bash", { command: cmd }), undefined);
	t("researcher: still no edit tool", blocked(await h.call(d, "edit", { path: join(d, "src", "a.txt") })), true);
	t("researcher: still no git writes", blocked(await h.call(d, "bash", { command: "git commit -am x" })), true);
	if (tmpWas === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpWas;
}

// --- reviewer: reviewers' and judges' role: runs tests, writes only under the temp dir,
// leaves the work's git state and dependencies alone
{
	// the role's temp dir is outside the project here (these projects sit in the real one)
	const tmpWas = process.env.TMPDIR; const scratch = join(work, "judge-tmp"); mkdirSync(scratch); process.env.TMPDIR = scratch;
	const h = await load({ LETS_CODE_ROLE: "reviewer", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	t("reviewer: edit tool not available", blocked(await h.call(d, "edit", { path: join(d, "src", "a.txt") })), true);
	t("reviewer: test runner passes", await h.call(d, "bash", { command: "npm test 2>&1 | tail -n 20" }), undefined);
	t("reviewer: pytest passes", await h.call(d, "bash", { command: "python3 -m pytest -q tests" }), undefined);
	t("reviewer: output to the temp dir passes", await h.call(d, "bash", { command: `node app.js > ${join(scratch, "out.txt")}` }), undefined);
	t("reviewer: output into the work blocked", blocked(await h.call(d, "bash", { command: "node app.js > out.txt" })), true);
	t("reviewer: sed -i in the work blocked", blocked(await h.call(d, "bash", { command: "sed -i 's/a/b/' src/a.txt" })), true);
	t("reviewer: sed -i in a temp copy passes", await h.call(d, "bash", { command: `sed -i 's/a/b/' ${join(scratch, "copy", "a.txt")}` }), undefined);
	t("reviewer: git checkout blocked", blocked(await h.call(d, "bash", { command: "git checkout main" })), true);
	t("reviewer: git stash blocked", blocked(await h.call(d, "bash", { command: "git stash" })), true);
	t("reviewer: git diff passes", await h.call(d, "bash", { command: "git diff HEAD~1 -- src" }), undefined);
	t("reviewer: npm install blocked", blocked(await h.call(d, "bash", { command: "npm install left-pad" })), true);
	t("reviewer: rm -rf blocked", blocked(await h.call(d, "bash", { command: "rm -rf src" })), true);
	t("reviewer: cannot dispatch", blocked(await h.call(d, "subagent", { agent: "worker", task: "x" })), true);
	t("reviewer: no prompt section", (() => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return Object.keys(s); })(), []);
	if (tmpWas === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpWas;
}

// --- developer: the developer expert's role: edits and runs in its workspace
// (the working folder) and the temp dir, never outside; no git writes, installs,
// recursive deletes or sudo
{
	const tmpWas = process.env.TMPDIR; const scratch = join(work, "dev-tmp"); mkdirSync(scratch); process.env.TMPDIR = scratch;
	const h = await load({ LETS_CODE_ROLE: "developer", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	const outside = repo();
	t("developer: edit in the workspace passes", await h.call(d, "edit", { path: join(d, "src", "a.txt") }), undefined);
	t("developer: write a new file passes", await h.call(d, "write", { path: join(d, "src", "new.js") }), undefined);
	t("developer: write outside blocked", blocked(await h.call(d, "write", { path: join(outside, "src", "x.js") })), true);
	t("developer: edit outside blocked", blocked(await h.call(d, "edit", { path: join(outside, "src", "a.txt") })), true);
	t("developer: no prompt for outside (denied)", h.notices.length, 0);
	t("developer: .git protected", blocked(await h.call(d, "write", { path: join(d, ".git", "config") })), true);
	t("developer: test runner passes", await h.call(d, "bash", { command: "npm test 2>&1 | tail -n 20" }), undefined);
	t("developer: output in the workspace passes", await h.call(d, "bash", { command: "node gen.js > src/out.txt" }), undefined);
	t("developer: output to the temp dir passes", await h.call(d, "bash", { command: `node app.js > ${join(scratch, "out.txt")}` }), undefined);
	t("developer: output outside blocked", blocked(await h.call(d, "bash", { command: `node app.js > ${join(outside, "out.txt")}` })), true);
	t("developer: git diff passes", await h.call(d, "bash", { command: "git diff -- src" }), undefined);
	t("developer: git commit blocked", blocked(await h.call(d, "bash", { command: "git commit -am wip" })), true);
	t("developer: git stash blocked", blocked(await h.call(d, "bash", { command: "git stash" })), true);
	t("developer: npm install blocked", blocked(await h.call(d, "bash", { command: "npm install left-pad" })), true);
	t("developer: rm -rf blocked", blocked(await h.call(d, "bash", { command: "rm -rf src" })), true);
	t("developer: sudo blocked", blocked(await h.call(d, "bash", { command: "sudo ls" })), true);
	t("developer: cannot dispatch", blocked(await h.call(d, "subagent", { agent: "worker", task: "x" })), true);
	t("developer: no prompt section", (() => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return Object.keys(s); })(), []);
	if (tmpWas === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpWas;
}

// --- a user's global role named reviewer merges over the built-in: the
// fields it sets win, the rest stays; a project may only tighten it
{
	writeFileSync(join(agentDir, "mandate.json"), JSON.stringify({ roles: { reviewer: { bash: { "git-write": "allow" }, tools: ["read", "bash", "subagent"], dispatch: ["worker"] } } }));
	const tmpWas = process.env.TMPDIR; process.env.TMPDIR = join(work, "judge-tmp");   // outside the project
	const h = await load({ LETS_CODE_ROLE: "reviewer", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	if (tmpWas === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpWas;
	t("user's reviewer: its git rule wins", await h.call(d, "bash", { command: "git stash" }), undefined);
	t("user's reviewer: its dispatch wins", await h.call(d, "subagent", { agent: "worker", task: "x" }), undefined);
	t("user's reviewer: built-in install rule kept", blocked(await h.call(d, "bash", { command: "pip install requests" })), true);
	t("user's reviewer: its tools win (edit still out)", blocked(await h.call(d, "edit", { path: join(d, "src", "a.txt") })), true);
	t("user's reviewer: built-in temp-dir write scope kept", blocked(await h.call(d, "bash", { command: "node app.js > out.txt" })), true);
	mkdirSync(join(d, ".pi")); writeFileSync(join(d, ".pi", "mandate.json"), JSON.stringify({ roles: { reviewer: { bash: { build: "deny" } } } }));
	const p = await load({ LETS_CODE_ROLE: "reviewer", LETS_CODE_SUBAGENT_DEPTH: "1" }); await p.start(d);
	t("project reviewer: can tighten (tests denied)", blocked(await p.call(d, "bash", { command: "npm test" })), true);
	rmSync(join(agentDir, "mandate.json"));
}

// --- yolo bypasses everything
{
	const h = await load({ LETS_CODE_MODE: "yolo" }); const d = repo(); await h.start(d);
	t("yolo: .env write passes", await h.call(d, "write", { path: join(d, ".env") }), undefined);
}

// --- manifests: global roles, project tighten-only, broken file fails closed
{
	writeFileSync(join(agentDir, "mandate.json"), JSON.stringify({ default: "ask", roles: { ask: { bash: { build: "ask" } }, ci: { tools: ["read", "bash"], bash: { "*": "deny", readonly: "allow", build: "allow" }, dispatch: [] } } }));
	const h = await load({}); const d = repo();
	mkdirSync(join(d, ".pi")); writeFileSync(join(d, ".pi", "mandate.json"), JSON.stringify({ roles: { ask: { bash: { build: "allow", privileged: "deny" }, bypass: true }, hacker: { bypass: true } } }));
	await h.start(d);
	t("manifest default role used", h.emitted.find(([c]) => c === "lets-code:mode")[1].role, "ask");
	t("global role: build asks", blocked(await h.call(d, "bash", { command: "npm test" })), true);            // no answers -> deny
	t("project cannot loosen build", blocked(await h.call(d, "bash", { command: "npm run build" })), true);
	t("project can tighten privileged", (await h.call(d, "bash", { command: "sudo ls" })).reason.includes("not allowed"), true);
	t("project cannot add a role / set bypass", h.notices.some((m) => /cannot add role 'hacker'/.test(m)) && h.notices.some((m) => /cannot set bypass/.test(m)), true);
	const c = await load({ LETS_CODE_MODE: "ci" }); const d3 = repo(); await c.start(d3);
	t("custom role: tools allowlist", blocked(await c.call(d3, "write", { path: join(d3, "x") })), true);
	t("custom role: build allowed", await c.call(d3, "bash", { command: "npm test" }), undefined);
	t("custom role: dispatch denied", blocked(await c.call(d3, "subagent", { agent: "worker", task: "x" })), true);
	const u = await load({}, { trusted: false }); const d4 = repo(); mkdirSync(join(d4, ".pi")); writeFileSync(join(d4, ".pi", "mandate.json"), "{ roles: { ask: { bash: { privileged: \"deny\" } } } }");
	await u.start(d4);
	t("untrusted project manifest ignored", u.notices.some((m) => /ignored \(project not trusted\)/.test(m)), true);
	writeFileSync(join(agentDir, "mandate.json"), "{ not json");
	const b = await load({ LETS_CODE_MODE: "ask" }); const d5 = repo(); await b.start(d5);
	t("broken global manifest: warns and keeps built-ins", b.notices.some((m) => /using built-in roles/.test(m)) && blocked(await b.call(d5, "bash", { command: "sudo ls" })), true);
	rmSync(join(agentDir, "mandate.json"));
}

// --- subagent role: no commands registered, role from env
{
	const h = await load({ LETS_CODE_ROLE: "plan", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	t("subagent: no /mode command", Object.keys(h.commands).length, 0);
	t("subagent: role from LETS_CODE_ROLE", blocked(await h.call(d, "write", { path: join(d, "x") })), true);
	t("mcp denied in plan", blocked(await h.call(d, "mcp__fs__read_file", { path: "x" })), true);
}
// --- mcp server allowlist
{
	writeFileSync(join(agentDir, "mandate.json"), JSON.stringify({ roles: { auto: { mcp: ["fs"] } } }));
	const h = await load({ LETS_CODE_MODE: "auto" }); const d = repo(); await h.start(d);
	t("mcp allowed server", await h.call(d, "mcp__fs__read_file", {}), undefined);
	t("mcp other server denied", blocked(await h.call(d, "mcp__web__fetch", {})), true);
	rmSync(join(agentDir, "mandate.json"));
}
// --- orchestrator: reads and dispatches experts, changes no file
{
	const h = await load({ LETS_CODE_MODE: "orchestrator" }); const d = repo(); await h.start(d);
	const prompt = () => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return s.lets_code_mandate ?? ""; };
	t("orchestrator: edit/write dropped from active tools", h.tools().includes("edit") || h.tools().includes("write"), false);
	t("orchestrator: subagent stays", h.tools().includes("subagent"), true);
	const w = await h.call(d, "write", { path: join(d, "src/b.txt") });
	t("orchestrator: write blocked", blocked(w), true);
	t("orchestrator: the reason says to delegate", /hand it to an expert/.test(w?.reason ?? ""), true);
	t("orchestrator: reason short", String(w?.reason).length <= 200, true);
	t("orchestrator: readonly bash passes", await h.call(d, "bash", { command: "git diff --stat; grep -rn foo src | head" }), undefined);
	t("orchestrator: tests are the experts'", blocked(await h.call(d, "bash", { command: "npm test" })), true);
	t("orchestrator: sed -i blocked", blocked(await h.call(d, "bash", { command: "sed -i s/a/b/ src/a.txt" })), true);
	t("orchestrator: redirection blocked", blocked(await h.call(d, "bash", { command: "echo x > src/a.txt" })), true);
	t("orchestrator: mcp denied", blocked(await h.call(d, "mcp__fs__write_file", { path: "x" })), true);
	t("orchestrator: dispatches an expert", await h.call(d, "expert", { action: "run", name: "developer", brief: {} }), undefined);
	const wk = await h.call(d, "subagent", { agent: "worker", task: "write greet.py" });
	t("orchestrator: no worker: code goes through the factory", [blocked(wk), /code goes through software-factory/.test(wk?.reason ?? "")], [true, true]);
	t("orchestrator: general for setup and checks", await h.call(d, "subagent", { agent: "general", task: "move old files to a backup" }), undefined);
	t("an exclusion with *", [h.mod.mayDispatch({ dispatch: ["*", "!worker"] }, "worker"), h.mod.mayDispatch({ dispatch: ["*", "!worker"] }, "scout")], [false, true]);
	t("orchestrator: dispatches the factory", await h.call(d, "expert", { action: "run", name: "software-factory", brief: {} }), undefined);
	t("orchestrator: prompt section", /Orchestrator mode/.test(prompt()), true);
	await h.commands.mode.handler("plan", h.ctx(d)); await h.shortcuts["alt+m"].handler(h.ctx(d));
	t("orchestrator: next after plan in the cycle", h.emitted.at(-1)?.[1]?.role, "orchestrator");
	await h.commands.orchestrator.handler("", h.ctx(d));
	t("/orchestrator leaves: tools restored", h.tools().includes("edit"), true);
	t("/orchestrator leaves: write allowed", await h.call(d, "write", { path: join(d, "src/b.txt") }), undefined);
	await h.commands.mode.handler("ask", h.ctx(d));
	t("factory hook engages it", globalThis.__letsCodeOrchestrate(h.ctx(d), "factory run"), true);
	t("factory hook: write blocked", blocked(await h.call(d, "write", { path: join(d, "src/b.txt") })), true);
	t("factory hook: told the user", h.notices.some((m) => /orchestrator \(factory run\)/.test(m)), true);
	t("factory hook: twice is a no-op", globalThis.__letsCodeOrchestrate(h.ctx(d), "factory run"), false);
	await h.commands.orchestrator.handler("", h.ctx(d));
	t("/orchestrator goes back to the mode it came from", h.emitted.at(-1)?.[1]?.role, "ask");
}
// --- a child never inherits the orchestrator
{
	const h = await load({ LETS_CODE_MODE: "orchestrator", LETS_CODE_ROLE: "orchestrator", LETS_CODE_SUBAGENT_DEPTH: "1" }); const d = repo(); await h.start(d);
	t("orchestrator child: gets the default role", await h.call(d, "write", { path: join(d, "src/b.txt") }), undefined);
	t("orchestrator child: no orchestrator hook command", Object.keys(h.commands).length, 0);
}
// --- mandate off: the orchestrator alone, dormant until engaged
{
	delete process.env.LETS_CODE_MANDATE_ON; process.env.LETS_CODE_ORCHESTRATOR_ON = "1";
	const h = await load({}); const d = repo(); await h.start(d);
	const prompt = () => { const s = {}; h.handlers.before_agent_start({ systemPromptOptions: { sections: s } }); return Object.keys(s); };
	t("dormant: write allowed", await h.call(d, "write", { path: join(d, "src/b.txt") }), undefined);
	t("dormant: any bash", await h.call(d, "bash", { command: "rm -rf build && npm install" }), undefined);
	t("dormant: no prompt section", prompt(), []);
	t("dormant: only /orchestrator", Object.keys(h.commands), ["orchestrator"]);
	t("dormant: tools untouched", h.tools().includes("edit"), true);
	t("dormant: a factory run engages it", globalThis.__letsCodeOrchestrate(h.ctx(d), "software factory run"), true);
	t("engaged: write blocked", blocked(await h.call(d, "write", { path: join(d, "src/b.txt") })), true);
	t("engaged: edit dropped", h.tools().includes("edit"), false);
	t("engaged: prompt section", prompt(), ["lets_code_mandate"]);
	await h.start(d);
	t("engaged: stays across a new session", blocked(await h.call(d, "edit", { path: join(d, "src/a.txt") })), true);
	await h.commands.orchestrator.handler("", h.ctx(d));
	t("left: write allowed", await h.call(d, "write", { path: join(d, "src/b.txt") }), undefined);
	t("left: any bash again", await h.call(d, "bash", { command: "npm install" }), undefined);
	t("left: tools restored", h.tools().includes("edit"), true);
	t("left: no prompt section", prompt(), []);
	await h.commands.orchestrator.handler("", h.ctx(d));
	t("/orchestrator engages it too", blocked(await h.call(d, "write", { path: join(d, "src/b.txt") })), true);
	const c = await load({ LETS_CODE_SUBAGENT_DEPTH: "1" });
	t("dormant child: inert", Object.keys(c.handlers).length, 0);
	delete process.env.LETS_CODE_ORCHESTRATOR_ON; process.env.LETS_CODE_MANDATE_ON = "1";
}
t("deny log written", readFileSync(process.env.LETS_CODE_MANDATE_LOG, "utf8").split("\n").filter((l) => l.includes('"deny"')).length > 5, true);

rmSync(work, { recursive: true, force: true });
console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
