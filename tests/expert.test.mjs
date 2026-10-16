#!/usr/bin/env node
// Unit test for the experts extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/experts.ts), with the subagents
// module next to it (its runner and agent files). Loads both with a fake pi
// API, a fake UI and a fake `pi` binary on PATH. Needs Node >= 22.6.
//
//   tests/experts.test.mjs [path/to/lets-code/experts.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, chmodSync, readdirSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/experts.ts");
const subPath = join(dirname(extPath), "subagents.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "expert-test-")));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const agentDir = join(work, "agent"); const ext = join(agentDir, "extensions"); mkdirSync(ext, { recursive: true }); mkdirSync(join(agentDir, "agents"));
const bin = join(work, "bin"); mkdirSync(bin);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LETS_CODE_SUBAGENTS_ON = "1";
process.env.LETS_CODE_EXPERTS_ON = "1";
process.env.LETS_CODE_MODEL = "test-model";
process.env.PATH = `${bin}:${process.env.PATH}`;
for (const k of ["LETS_CODE_SUBAGENT_DEPTH", "LETS_CODE_ROLE", "LETS_CODE_MODE"]) delete process.env[k];

// fake pi: records argv, replies with the task
writeFileSync(join(bin, "pi"), `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const id = Date.now() + "-" + Math.random().toString(36).slice(2);
fs.writeFileSync(path.join(process.env.FAKE_PI_DIR, "call-" + id + ".json"), JSON.stringify({ argv: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR, depth: process.env.LETS_CODE_SUBAGENT_DEPTH }));
const task = process.argv[process.argv.length - 1];
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Result for: " + task.replace(/^Task: /, "") }], usage: { input: 10, output: 5 } } }) + "\\n");
`);
chmodSync(join(bin, "pi"), 0o755);
const fake = join(work, "fake"); mkdirSync(fake); process.env.FAKE_PI_DIR = fake;
const calls = () => readdirSync(fake).filter((f) => f.startsWith("call-")).map((f) => JSON.parse(readFileSync(join(fake, f), "utf8")));
const clearCalls = () => readdirSync(fake).forEach((f) => rmSync(join(fake, f)));

// the agents: two experts usable anywhere, one only on Termux, one that needs its setup, a plain agent
const A = (f, s) => writeFileSync(join(agentDir, "agents", f), s);
A("helper.md", "---\nname: helper\ndescription: Answers questions about artifacts\ntools: read, bash\nexpert: true\nuse_for: questions about artifacts\njob: Looks into a built artifact and answers one question\nbrief:\n  - target (required): absolute path or URL of the artifact\n  - question (required): what to find out\n  - purpose: what the answer is for\n---\nYou help.\n");
A("phone.md", "---\nname: phone\ndescription: Phone tasks\nexpert: true\nplatform: termux\ndispatch_rule: Phone actions go to expert phone.\nbrief:\n  - goal (required): the user's goal, verbatim\n---\nYou use the phone.\n");
A("tool.md", "---\nname: tool\ndescription: Needs a runtime\nexpert: true\nrequires: rt/ready\nsetup: rt/setup.sh\nsetup_note: installs the runtime\n---\nYou use the runtime.\n");
A("scout.md", "---\nname: scout\ndescription: finds things\n---\nYou look around.\n");
mkdirSync(join(agentDir, "rt"));
writeFileSync(join(agentDir, "rt", "setup.sh"), "echo 'installing the runtime ...' >&2\ntouch \"$(dirname \"$0\")/ready\"\n");

// typebox comes from the pi host; point the temp copies at pi's own, or a stub (CI)
{
	let piRoot = "";
	try { piRoot = join(execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "@earendil-works", "pi-coding-agent"); } catch { /* no npm */ }
	const tb = piRoot ? [join(piRoot, "node_modules", "typebox"), join(piRoot, "..", "..", "typebox")].find((p) => existsSync(p)) : undefined;
	const nm = join(ext, "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	if (tb) { rmSync(nm, { recursive: true }); symlinkSync(tb, nm); }
	else {
		writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
		writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }) };\n");
	}
}
const strip = (f) => readFileSync(f, "utf8").replace(/^import type .*$/m, "");
writeFileSync(join(ext, "subagents.ts"), strip(subPath));
const src = strip(extPath);

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const has = (name, text, part) => t(name, String(text).includes(part) ? part : String(text).slice(0, 400), part);

let loads = 0;
async function load(env = {}) {
	const saved = {};
	for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	const f = join(ext, `experts-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	let tool = null; const commands = {}; const handlers = {};
	await mod.default({ registerTool: (d) => { tool = d; }, registerCommand: (name, d) => { commands[name] = d; }, on(ev, h) { handlers[ev] = h; return () => {}; } });
	for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	return { mod, tool, commands, handlers };
}
// a context: answers = what the confirm dialog says each time (none = no UI)
function ctx(answers) {
	const asked = []; const notes = [];
	return { asked, notes, cwd: work, hasUI: answers !== undefined, ui: { confirm: async (title, msg) => { asked.push(title + "\n" + msg); return answers.shift() ?? false; }, notify: (m) => notes.push(m), setStatus: () => {} } };
}
const run = (tool, params, c) => tool.execute("id", params, undefined, undefined, c);
const out = (r) => r.content.map((c) => c.text).join("\n");
const state = () => JSON.parse(readFileSync(join(agentDir, "lets-code-state.json"), "utf8"));
const onTermux = /\/com\.termux\//.test(process.env.PREFIX ?? "") || existsSync("/data/data/com.termux/files/usr");

// --- switched off: no tool, no tokens
{
	t("off without LETS_CODE_EXPERTS_ON", (await load({ LETS_CODE_EXPERTS_ON: undefined })).tool, null);
	t("off without subagents", (await load({ LETS_CODE_SUBAGENTS_ON: undefined })).tool, null);
	t("a subagent child gets no tool", (await load({ LETS_CODE_SUBAGENT_DEPTH: "1" })).tool, null);
}

// --- what is always in context
writeFileSync(join(agentDir, "lets-code-state.json"), JSON.stringify({ thinkingLevels: { "p/m": "low" }, metrics: true }));
const { tool, commands, mod, handlers } = await load();
{
	// dispatch rules: a section only for usable experts that have one (phone: Termux only)
	const ev = { systemPromptOptions: { sections: { tools: "x" } } };
	await handlers.before_agent_start?.(ev);
	t("dispatch rule: a section only where its expert is usable", ev.systemPromptOptions.sections.lets_code_experts, onTermux ? "Experts (lets-code):\n- Phone actions go to expert phone." : undefined);
	t("dispatch rule: other sections kept", ev.systemPromptOptions.sections.tools, "x");
	t("rulesSection: none -> empty", mod.rulesSection([{ name: "a", expert: {} }]), "");
	t("rulesSection: one line each", mod.rulesSection([{ name: "a", expert: { dispatchRule: "R1" } }, { name: "b", expert: {} }, { name: "c", expert: { dispatchRule: "R2" } }]), "Experts (lets-code):\n- R1\n- R2");
	const names = onTermux ? "helper (questions about artifacts); phone; tool" : "helper (questions about artifacts); tool";
	t("snippet: names usable here, their tasks, the actions", tool.promptSnippet, `expert: these tasks go to the expert named, not done by hand, even quick ones: ${names}. Actions: list | enable | run`);
	t("snippet under 40 words", tool.promptSnippet.split(/\s+/).length <= 40, true);
	t("description under 220 characters", tool.description.length < 220, true);
	t("no guideline (nothing else always on)", tool.promptGuidelines, undefined);
	// many experts: the compact line (keywords, else the first words of use_for)
	const many = Array.from({ length: 20 }, (_, i) => ({ name: `x${i}`, expert: { useFor: "a rather long description of what this one does", keywords: i % 2 ? "kw one" : undefined } }));
	const line = mod.snippet(many);
	t("20 experts: compact line under the budget", [line.length <= mod.LINE_BUDGET + 200, line.includes("x1 (kw one)"), line.includes("x0 (a rather long description…)")], [true, true, true]);
	t("2 experts: full use_for", mod.snippet(many.slice(0, 2)).includes("x0 (a rather long description of what this one does)"), true);
	t("the /experts command", typeof commands.experts?.handler, "function");
}

// --- list: jobs, states, templates; one expert's full template
{
	const l = out(await run(tool, { action: "list" }, ctx([])));
	has("list: job line", l, "- helper: Looks into a built artifact and answers one question");
	has("list: template with required marks", l, "brief: target* (absolute path or URL of the artifact); question* (what to find out); purpose (what the answer is for)");
	has("list: never enabled -> dormant, run asks", l, "[dormant, just run it: the user gets a yes/no dialog to enable it]");
	has("list: setup pending -> not set up", l, "- tool: Needs a runtime [dormant, just run it: the user gets a yes/no dialog to enable it, then it installs the runtime]");
	has("list: no field given -> one required task", l, "brief: task* (the whole task, standing alone)");
	t("list: the plain agent is not an expert", l.includes("scout"), false);
	t("list: platform termux only on Termux", l.includes("- phone:"), onTermux);
	const one = out(await run(tool, { action: "list", name: "helper" }, ctx([])));
	has("list name: required field", one, "- target (required): absolute path or URL of the artifact");
	has("list name: optional field", one, "- purpose: what the answer is for");
	has("list name: call shape", one, 'Call: expert({action: "run", name: "helper", brief: {target: "...", question: "...", purpose: "..."}})');
	t("list name: unknown is an error", (await run(tool, { action: "list", name: "nope" }, ctx([]))).isError, true);
}

// --- run: the brief is checked before anything else
{
	clearCalls(); const c = ctx([true]);
	const r = await run(tool, { action: "run", name: "helper", brief: { target: "/bin/true" } }, c);
	t("missing field: error", r.isError, true);
	has("missing field: names it", out(r), "lacks question");
	has("missing field: returns the template", out(r), "- question (required): what to find out");
	t("missing field: no dialog, no child", [c.asked.length, calls().length], [0, 0]);
	const r2 = await run(tool, { action: "run", name: "helper", brief: "not json" }, ctx([true]));
	has("brief not an object: template", out(r2), "must be an object of the template's fields");
	has("unknown expert", out(await run(tool, { action: "run", name: "nope", brief: {} }, ctx([]))), 'Unknown expert "nope"');
	t("prepareArguments: a JSON string brief becomes the object", tool.prepareArguments({ action: "run", name: "helper", brief: '{"target":"x","question":"y"}' }).brief, { target: "x", question: "y" });
}

// --- enabling needs the user
const brief = { target: "/bin/true", question: "what does --version print", purpose: "a test" };
{
	clearCalls();
	const r = await run(tool, { action: "run", name: "helper", brief }, ctx(undefined));
	t("no UI: refused", r.isError, true);
	has("no UI: says how the user enables it", out(r), "only the user can enable it: /experts enable helper");
	t("no UI: nothing ran", calls().length, 0);
	const c = ctx([false]);
	const r2 = await run(tool, { action: "run", name: "helper", brief }, c);
	has("declined: says so", out(r2), "The user declined to enable the helper expert.");
	t("declined: asked once with the job", [c.asked.length, c.asked[0]?.includes("Looks into a built artifact")], [1, true]);
	const c2 = ctx([true]);
	const r3 = await run(tool, { action: "enable", name: "helper" }, c2);
	has("declined: not asked again in this session", out(r3), "declined the helper expert in this session");
	t("declined: no dialog the second time", c2.asked.length, 0);
	t("declined: not remembered", state().experts, undefined);
}
{
	const fresh = await load();   // a new session
	const c = ctx([true]);
	const r = await run(fresh.tool, { action: "enable", name: "helper" }, c);
	t("enable: the user said yes", [r.isError, out(r)], [false, "The helper expert is enabled."]);
	t("enable: remembered, other keys kept", state(), { thinkingLevels: { "p/m": "low" }, metrics: true, experts: { helper: true } });
	t("enable: state file mode 600", (statSync(join(agentDir, "lets-code-state.json")).mode & 0o777).toString(8), "600");
	has("list: enabled", out(await run(fresh.tool, { action: "list" }, ctx([]))), "[enabled]");
}

// --- run: dispatched through the subagents runner with the brief as headings
{
	clearCalls();
	const s2 = await load();   // remembered: no dialog
	const c = ctx([]);
	const r = await run(s2.tool, { action: "run", name: "helper", brief: { ...brief, extra_note: "keep it short" } }, c);
	t("run: no dialog once remembered", c.asked.length, 0);
	t("run: ok", r.isError, false);
	const call = calls()[0]; const task = call?.argv[call.argv.length - 1] ?? "";
	t("run: one child, one level deeper", [calls().length, call?.depth], [1, "1"]);
	has("run: brief heading per field", task, "## Target\n/bin/true\n\n## Question\nwhat does --version print\n\n## Purpose\na test");
	has("run: an extra field comes last", task, "## Extra note\nkeep it short");
	has("run: the agent's own tools", call?.argv.join(" "), "--tools read,bash");
	has("run: rendered like a subagent result", out(r), "## helper — done, 1 turn");
	clearCalls();
	const p = await run(s2.tool, { action: "run", runs: [{ name: "helper", brief }, { name: "helper", brief: { target: "/bin/false", question: "exit code?" } }] }, c);
	t("runs: two children in parallel", [p.isError, calls().length, out(p).split("## helper").length - 1], [false, 2, 2]);
	t("runs: one bad brief stops all", (await run(s2.tool, { action: "run", runs: [{ name: "helper", brief }, { name: "helper", brief: {} }] }, c)).isError, true);
	t("runs: max 8", (await run(s2.tool, { action: "run", runs: Array(9).fill({ name: "helper", brief }) }, c)).isError, true);
}

// --- setup: runs once enabled, then the expert is ready
{
	const s3 = await load();
	const c = ctx([true]);
	const r = await run(s3.tool, { action: "run", name: "tool", brief: { task: "go" } }, c);
	has("setup: the dialog names it", c.asked[0], "Setup: installs the runtime.");
	t("setup: ran, then the child ran", [r.isError, existsSync(join(agentDir, "rt", "ready"))], [false, true]);
	t("setup: remembered after success", state().experts.tool, true);
	has("setup: list says enabled", out(await run(s3.tool, { action: "list" }, ctx([]))), "- tool: Needs a runtime [enabled]");
	// a setup that fails: a note, not remembered
	rmSync(join(agentDir, "rt", "ready")); writeFileSync(join(agentDir, "rt", "setup.sh"), "echo 'npm not found; run: npm install'; exit 2\n");
	writeFileSync(join(agentDir, "lets-code-state.json"), JSON.stringify({ experts: { ...state().experts, tool: false } }));   // dormant again
	const s4 = await load();
	const r2 = await run(s4.tool, { action: "run", name: "tool", brief: { task: "go" } }, ctx([true]));
	t("setup fails: error with the script's note", [r2.isError, out(r2)], [true, "Setting up the tool expert failed: npm not found; run: npm install."]);
}

// --- dormant by default; /experts
{
	rmSync(join(agentDir, "lets-code-state.json"));
	t("no per-launch switch any more", mod.launchDecisions, undefined);
	const s6 = await load({ LETS_CODE_EXPERTS_LAUNCH: "helper=1", LETS_CODE_TERMUX: "true", LETS_CODE_REA: "true" });
	const c6 = ctx([false]);
	await run(s6.tool, { action: "run", name: "helper", brief }, c6);
	t("dormant despite old switches in the environment: asks the user", c6.asked.length, 1);
	const notes = []; const cc = { hasUI: true, ui: { notify: (m) => notes.push(m), setStatus: () => {}, confirm: async () => { throw new Error("no dialog for a command"); } } };
	await s6.commands.experts.handler("disable helper", cc);
	t("/experts disable: remembered false", [state().experts.helper, notes[notes.length - 1]], [false, "The helper expert is dormant again (remembered)."]);
	has("/experts list: one line per expert, dormant mark", (await s6.commands.experts.handler("list", cc), notes[notes.length - 1]), "○ helper");
	t("/experts list: every line fits the terminal", notes[notes.length - 1].split("\n").every((l) => l.length <= (process.stdout.columns || 80) - 3), true);
	has("/experts list: declined shown plainly", notes[notes.length - 1], "dormant, declined in this session");
	t("/experts list: no tool wording", /just run it|action: "run"/.test(notes[notes.length - 1]), false);
	await s6.commands.experts.handler("helper", cc);
	has("/experts <name>: details with the brief", notes[notes.length - 1], "\nBrief\n  target    required");
	has("/experts <name>: how to enable", notes[notes.length - 1], "/experts enable helper");
	await s6.commands.experts.handler("enable helper", cc);
	t("/experts enable: no dialog, remembered", [notes[notes.length - 1], state().experts.helper], ["The helper expert is enabled (remembered).", true]);
	await s6.commands.experts.handler("enable nope", cc);
	has("/experts enable unknown", notes[notes.length - 1], 'Unknown expert "nope"');
	t("completions", (await s6.commands.experts.getArgumentCompletions("en")).map((x) => x.value), ["enable"]);
	t("completions: a full word offers nothing", (await s6.commands.experts.getArgumentCompletions("list")).length, 0);
	t("completions: names", (await s6.commands.experts.getArgumentCompletions("enable he")).map((x) => x.value), ["enable helper"]);
}

// --- the subagent tool: experts are not listed there, and a call is pointed here
{
	const f = join(ext, "subagents-copy.ts"); writeFileSync(f, readFileSync(join(ext, "subagents.ts")));
	const sub = await import(pathToFileURL(f).href);
	let st = null; sub.default({ registerTool: (d) => { st = d; }, on() { return () => {}; } });
	t("subagent: experts not in its agents", sub.discoverAgents(work, false).map((a) => a.name), ["scout"]);
	t("subagent: description without them", st.description.includes("helper"), false);
	const r = await st.execute("id", { agent: "helper", task: "x" }, undefined, undefined, { cwd: work, isProjectTrusted: false });
	t("subagent: pointed at the expert tool", [r.isError, out(r).startsWith('"helper" is an expert: use expert({action: "run", name: "helper", brief})')], [true, true]);
	// experts off: still not listed, and simply unknown
	const g = join(ext, "subagents-off.ts"); writeFileSync(g, readFileSync(join(ext, "subagents.ts")));
	delete process.env.LETS_CODE_EXPERTS_ON;
	const off = await import(pathToFileURL(g).href); let so = null; off.default({ registerTool: (d) => { so = d; }, on() { return () => {}; } });
	process.env.LETS_CODE_EXPERTS_ON = "1";
	t("experts off: still not in the subagent tool", off.discoverAgents(work, false).map((a) => a.name), ["scout"]);
	has("experts off: a call is an unknown agent", out(await so.execute("id", { agent: "helper", task: "x" }, undefined, undefined, { cwd: work, isProjectTrusted: false })), 'Unknown agent "helper"');
	t("ungated parse keeps a file whose setup has not run", sub.parseAgentFile("---\nname: z\nexpert: true\nrequires: nothing/here\n---\n", "z.md", "user", undefined, false, true)?.expert?.ready, false);
	t("gated parse hides it", sub.parseAgentFile("---\nname: z\nexpert: true\nrequires: nothing/here\n---\n", "z.md", "user"), null);
	t("bad brief item rejects the file", sub.parseAgentFile("---\nname: z\nexpert: true\nbrief:\n  - no colon here\n---\n", "z.md", "user"), null);
	t("setup outside the agent dir rejects the file", sub.parseAgentFile("---\nname: z\nexpert: true\nsetup: /etc/passwd\n---\n", "z.md", "user"), null);
	t("platform", [sub.platformOk(undefined), sub.platformOk(process.platform), sub.platformOk("no-such-os")], [true, true, false]);
}


// the tester expert as lets-code writes it (tester_write_agent): its fields parse,
// its brief has the two required fields, it is listed only on Linux and macOS,
// and it is not set up until tester/setup has run
{
	const sub = await import(pathToFileURL(join(ext, "subagents.ts")).href);
	const lc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lets-code"), "utf8");
	const from = lc.indexOf("\ntester_write_agent() {");
	const body = lc.slice(lc.indexOf("<<'MD'\n", from) + 7, lc.indexOf("\nMD\n", from) + 1);
	const a = sub.parseAgentFile(body, join(agentDir, "agents", "tester.md"), "user", undefined, false, true);
	t("tester: an expert", [a?.name, !!a?.expert], ["tester", true]);
	t("tester: brief", a?.expert?.brief.map((f) => `${f.name}${f.required ? "*" : ""}`), ["target*", "platform", "goal*", "how_to_run", "scope", "constraints"]);
	t("tester: no agent dir of its own; its prompt", [a?.agentDir, a?.appendPrompt, a?.timeout], [undefined, join(agentDir, "tester", "prompt.md"), 3600]);
	t("tester: setup under the agent dir", a?.expert?.setup, join(agentDir, "tester", "setup"));
	t("tester: not set up before its setup", a?.expert?.ready, false);
	t("tester: Linux and macOS only (not Termux: process.platform android)", [sub.platformOk(a?.expert?.platform), a?.expert?.platform.split(/[,\s]+/).includes("android")], [["linux", "darwin"].includes(process.platform), false]);
	t("tester: use_for whole in the line", a?.expert?.useFor, body.match(/^use_for: (.*)$/m)[1]);
	t("tester: pi's tools", a?.tools, ["bash", "read", "edit", "write", "grep", "find", "ls"]);
}

// the acceptance judge as lets-code writes it (judge_write_agent): ready with
// no setup, on every platform, read-and-run tools only, under the reviewer role
{
	const sub = await import(pathToFileURL(join(ext, "subagents.ts")).href);
	const lc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lets-code"), "utf8");
	const from = lc.indexOf("\njudge_write_agent() {");
	const body = lc.slice(lc.indexOf("<<'MD'\n", from) + 7, lc.indexOf("\nMD\n", from) + 1);
	const a = sub.parseAgentFile(body, join(agentDir, "agents", "acceptance-judge.md"), "user", undefined, false, true);
	t("judge: an expert", [a?.name, !!a?.expert], ["acceptance-judge", true]);
	t("judge: brief", a?.expert?.brief.map((f) => `${f.name}${f.required ? "*" : ""}`), ["criteria*", "artifact*", "claim", "how_to_run", "constraints"]);
	t("judge: its prompt, no agent dir", [a?.agentDir, a?.appendPrompt, a?.timeout], [undefined, join(agentDir, "acceptance-judge", "prompt.md"), 1800]);
	t("judge: not ready while its prompt is missing", a?.expert?.ready, existsSync(join(agentDir, "acceptance-judge", "prompt.md")));
	mkdirSync(join(agentDir, "acceptance-judge"), { recursive: true }); writeFileSync(join(agentDir, "acceptance-judge", "prompt.md"), "x");
	const b = sub.parseAgentFile(body, join(agentDir, "agents", "acceptance-judge.md"), "user", undefined, false, true);
	t("judge: ready with its files alone, no setup", [b?.expert?.setup, b?.expert?.ready], [undefined, true]);
	rmSync(join(agentDir, "acceptance-judge"), { recursive: true, force: true });
	t("judge: every platform", [a?.expert?.platform, sub.platformOk(a?.expert?.platform)], [undefined, true]);
	t("judge: read and run, no edit or write", a?.tools, ["read", "bash", "grep", "find", "ls"]);
	t("judge: the reviewer role", a?.role, "reviewer");
	t("judge: use_for whole in the line", a?.expert?.useFor, body.match(/^use_for: (.*)$/m)[1]);
}

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
