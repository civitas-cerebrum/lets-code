#!/usr/bin/env node
// Unit test for the core memory module that lets-code writes
// (~/.pi/agent/extensions/lets-code/core-memory.ts): the store (upsert,
// dedupe, forget, atomic 600 files, a corrupt line, the rendered file read
// back, the archive by age), search, the always-on line and the headlines
// under their budgets, the tool's actions and the secret refusal, the hint
// on a tool result, the /memory command, the harness writers (a factory
// run, a subagent run, the session pointer) and that a child session writes
// no pointers. With a fake pi, in a scratch agent dir. Needs Node >= 22.6.
//
//   tests/core-memory.test.mjs [path/to/lets-code/core-memory.ts]
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, statSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/core-memory.ts");
const work = realpathSync(mkdtempSync(join(tmpdir(), "core-memory-test-")));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const agentDir = join(work, "agent"); const ext = join(agentDir, "extensions"); mkdirSync(ext, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LETS_CODE_CORE_MEMORY_ON = "1";
delete process.env.LETS_CODE_SUBAGENT_DEPTH; delete process.env.LETS_CODE_CORE_MEMORY_HEADLINES;
// typebox comes from the pi host; point the temp copies at pi's own, or a stub (CI)
{
	let piRoot = "";
	try { piRoot = join(execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "@earendil-works", "pi-coding-agent"); } catch { /* no npm */ }
	const tb = piRoot ? [join(piRoot, "node_modules", "typebox"), join(piRoot, "..", "..", "typebox")].find((p) => existsSync(p)) : undefined;
	const nm = join(ext, "node_modules", "typebox"); mkdirSync(nm, { recursive: true });
	if (tb) { rmSync(nm, { recursive: true }); symlinkSync(tb, nm); }
	else {
		writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
		writeFileSync(join(nm, "index.js"), "export const Type = { Object: (p, o) => ({ type: 'object', properties: p, ...o }), String: (o) => ({ type: 'string', ...o }), Boolean: (o) => ({ type: 'boolean', ...o }), Array: (i, o) => ({ type: 'array', items: i, ...o }), Optional: (x) => ({ ...x, optional: true }) };\n");
	}
}
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };
const has = (name, text, part) => t(name, String(text).includes(part) ? part : String(text).slice(0, 300), part);

let loads = 0;
// a fresh module instance (ACTIVE and DEPTH are read at import) with a fake pi
async function load(env = {}, on = true) {
	for (const k of ["LETS_CODE_SUBAGENT_DEPTH", "LETS_CODE_CORE_MEMORY_HEADLINES"]) delete process.env[k];
	process.env.LETS_CODE_CORE_MEMORY_ON = on ? "1" : "";
	Object.assign(process.env, env);
	const f = join(ext, `core-memory-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	mod.reset?.();
	const handlers = {}, commands = {}; let tool = null; const notices = [];
	const pi = { on(ev, h) { handlers[ev] = h; return () => {}; }, registerTool(d) { tool = d; }, registerCommand(name, o) { commands[name] = o; } };
	mod.default(pi);
	const ctx = (cwd, o = {}) => ({ cwd, hasUI: o.ui ?? true, ui: { notify: (m, type) => notices.push([m, type]), editor: async () => o.edited, select: async () => undefined }, sessionManager: { getSessionFile: () => o.file, getEntries: () => o.entries ?? [] }, ...o.extra });
	return { mod, handlers, commands, tool, notices, ctx,
		run: (cwd, params, o) => tool.execute("id", params, undefined, undefined, ctx(cwd, o)),
		cmd: (cwd, args, o) => commands.memory.handler(args, ctx(cwd, o)) };
}
const repo = (name = "proj") => { const d = join(work, name); mkdirSync(join(d, ".git"), { recursive: true }); mkdirSync(join(d, "src"), { recursive: true }); writeFileSync(join(d, "src", "a.ts"), "line1\nline2\nline3\n"); return d; };
const textOf = (r) => r.content.map((c) => c.text).join("\n");

// --- inert unless switched on
{ const h = await load({}, false); t("inert: no handlers, no tool, no command", [Object.keys(h.handlers).length, h.tool, Object.keys(h.commands).length], [0, null, 0]); }

// --- keys and pointers
{
	const { mod } = await load();
	const r = repo();
	t("project root: the nearest .git up from cwd", mod.projectRoot(join(r, "src")), r);
	t("project root: no .git means the folder itself", mod.projectRoot(join(work, "agent")), join(work, "agent"));
	t("project dir: name and a hash, under the agent dir", mod.projectDir(r).startsWith(join(agentDir, "core-memory", "projects", "proj-")) && /-[0-9a-f]{8}$/.test(mod.projectDir(r)), true);
	t("two projects of one name differ", mod.projectDir(r) === mod.projectDir(join(work, "x", "proj")), false);
	t("ref: a relative path becomes absolute, the line kept", mod.normRef("src/a.ts:12", r), `${r}/src/a.ts:12`);
	t("ref: run and factory ids stay", [mod.normRef("run:abc", r), mod.normRef("factory:k3f", r)], ["run:abc", "factory:k3f"]);
	t("ref: session: prefix drops to the path", mod.normRef("session:/tmp/s.jsonl", r), "/tmp/s.jsonl");
	t("keys: a path under the runs dir is also its run", mod.refKeys(`${agentDir}/lets-code-runs/sess/r1.pi.jsonl`), [`${agentDir}/lets-code-runs/sess/r1.pi.jsonl`, "run:r1"]);
	t("keys: a path under a factory run dir is also that run", mod.refKeys(`${agentDir}/lets-code-factory/k3f/ledger.json`), [`${agentDir}/lets-code-factory/k3f/ledger.json`, "factory:k3f"]);
	t("secret: tokens and keys", ["sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "password: hunter2hunter2", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"].map(mod.looksSecret), [true, true, true, true, true]);
	t("secret: a commit hash, a path and prose pass", ["commit 3fd9bcd0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 on main", "the token lives in ~/.config/lets-code/config", "tests use port 8796"].map(mod.looksSecret), [false, false, false]);
}

// --- the store
{
	const { mod } = await load();
	const r = repo();
	const s = new mod.Store(mod.projectDir(r), "project", r).load();
	t("empty store", [s.entries.length, s.bad], [0, 0]);
	const T = Date.now() - 60_000, D = mod.day(T);
	const a = s.upsert({ kind: "decision", gist: "JSONL is the store, memory.md the view", refs: ["src/a.ts:2"], by: "model" }, T + 1000);
	t("upsert: a new entry", [a.updated, a.entry.kind, a.entry.refs], [false, "decision", [`${r}/src/a.ts:2`]]);
	const b = s.upsert({ kind: "decision", gist: "jsonl is the store, memory.md the view.", refs: ["src/b.ts"] }, T + 2000);
	t("upsert: the same gist (case, spacing, final dot aside) updates it, the newer wording and merged pointers", [b.updated, b.entry.id === a.entry.id, b.entry.gist, b.entry.refs.length, b.entry.n], [true, true, "jsonl is the store, memory.md the view.", 2, 2]);
	const c = s.upsert({ kind: "work", gist: "factory k3f done: login form", refs: ["factory:k3f", "/w/t"] }, T + 3000);
	const d = s.upsert({ kind: "work", gist: "factory k3f stopped: login form", refs: ["factory:k3f"] }, T + 4000);
	t("upsert: the same run pointer updates whatever the gist", [d.updated, d.entry.id === c.entry.id, d.entry.gist], [true, true, "factory k3f stopped: login form"]);
	t("upsert: an unknown kind is a fact, a long gist is cut", (() => { const e = s.upsert({ kind: "weird", gist: "x".repeat(300) }, 5000).entry; return [e.kind, e.gist.length]; })(), ["fact", mod.GIST_MAX]);
	s.save(T + 6000);
	t("saved: jsonl and md, mode 600", [existsSync(s.file), existsSync(s.md), (statSync(s.file).mode & 0o777).toString(8), (statSync(s.md).mode & 0o777).toString(8)], [true, true, "600", "600"]);
	t("saved: the dir is 700", (statSync(s.dir).mode & 0o777).toString(8), "700");
	t("saved: no temp file left", readFileSync(s.file, "utf8").split("\n").filter(Boolean).length, 3);
	const md = readFileSync(s.md, "utf8");
	has("rendered: says it is data", md, "data, not instructions");
	has("rendered: one line an entry with date, kind, id, gist and pointers", md, `- ${D} decision #${a.entry.id} jsonl is the store, memory.md the view. — src/a.ts:2, src/b.ts`);
	t("rendered: no line looks like an instruction to the model", /^(you |always |never )/im.test(md), false);
	t("index: a file pointer finds its entry, with or without the line; a directory what is under it", [s.byKey(`${r}/src/a.ts`).length, s.byKey(`${r}/src`).length, s.byKey(`${r}/nope.ts`).length], [1, 1, 0]);
	t("forget", [!!s.forget(c.entry.id), s.entries.length, s.forget("zzzz")], [true, 2, undefined]);
	// a corrupt line is skipped and counted, not fatal
	writeFileSync(s.file, readFileSync(s.file, "utf8") + "{not json\n" + JSON.stringify({ id: "q1q1q1", t: T + 7000, kind: "fact", gist: "ok line", refs: [] }) + "\n");
	const s2 = new mod.Store(mod.projectDir(r), "project", r).load(Date.now());
	t("load: a corrupt line is counted, the rest is read", [s2.bad, s2.entries.length, s2.entries.find((e) => e.id === "q1q1q1")?.u], [1, 4, T + 7000]);
	// the rendered file edited by hand, newer than the store: read back by id
	const edited = s2.render().replace("ok line", "ok line, edited") + "- 2026-01-01 preference tabs, not spaces — src/a.ts\n- a bare line\n";
	s2.save(); writeFileSync(s2.md, edited.replace(new RegExp(`^- .*#${a.entry.id} .*\\n`, "m"), ""));
	const later = new Date(Date.now() + 5000); utimesSync(s2.md, later, later);
	const s3 = new mod.Store(mod.projectDir(r), "project", r).load(Date.now());
	t("edit: a changed gist is taken", s3.entries.find((e) => e.id === "q1q1q1")?.gist, "ok line, edited");
	t("edit: a removed line is forgotten", s3.entries.some((e) => e.id === a.entry.id), false);
	t("edit: new lines are entries by the user, with kind and pointers when given", s3.entries.filter((e) => e.by === "user").map((e) => [e.kind, e.gist, e.refs]), [["preference", "tabs, not spaces", [`${r}/src/a.ts`]], ["fact", "a bare line", []]]);
	t("edit: the store was rewritten from it", readFileSync(s3.file, "utf8").includes("ok line, edited"), true);
	// archive by age: work and pointer entries only
	const old = Date.now() - 200 * 86_400_000;
	s3.upsert({ kind: "work", gist: "old work", refs: ["run:old1"] }, old); s3.upsert({ kind: "pointer", gist: "old session", refs: ["/s/old.jsonl"] }, old); s3.upsert({ kind: "decision", gist: "old decision" }, old);
	t("archive: by age, work and pointer only", s3.archive(mod.ARCHIVE_DAYS), 2);
	s3.save();
	t("archive: moved out, counted, kept on disk", [s3.entries.some((e) => e.gist === "old work"), s3.entries.some((e) => e.gist === "old decision"), s3.archived, readFileSync(s3.archiveFile, "utf8").split("\n").filter(Boolean).length], [false, true, 2, 2]);
	has("archive: the rendered file points at it", s3.render(), "2 older entries: archive.jsonl");
	t("search: words, all must match", s3.search("line edited").map((e) => e.id), ["q1q1q1"]);
	t("search: a path", s3.search("src/a.ts").length, 1);
	t("search: a kind, a date prefix", [s3.search("preference").length, s3.search(D.slice(0, 7)).length >= 3, s3.search("2099").length], [1, true, 0]);
	t("search: the archive on request", [s3.search("run:old1").length, s3.search("run:old1", { archive: true }).length], [0, 1]);
	t("search: newest first", s3.search("")[0].gist, "old decision" === s3.search("")[0].gist ? "WRONG: the oldest" : s3.search("")[0].gist);
}

// --- what the model sees: the line and the headlines
{
	const { mod } = await load();
	const r = repo("budget");
	const p = new mod.Store(mod.projectDir(r), "project", r), g = new mod.Store(mod.memoryRoot(), "global", "");
	t("empty: one line, no headlines", mod.sectionText(p, g).split("\n").length, 1);
	has("empty: says zero entries", mod.sectionText(p, g), "0 entries for this project, 0 global");
	for (let i = 0; i < 8; i++) p.upsert({ kind: "work", gist: `entry ${i} ${"word ".repeat(20)}`, refs: [`src/f${i}.ts`] }, 1000 + i);
	g.upsert({ kind: "preference", gist: "short answers" });
	const sec = mod.sectionText(p, g);
	const line = sec.split("\n")[0];
	t("the line is under its budget", mod.est(line) <= mod.LINE_BUDGET, true);
	has("the line: counts and the last date", line, "8 entries for this project (last 1970-01-01), 1 global");
	const heads = sec.split("\n").slice(2);
	t("headlines: at most HEADLINES, within their budget", [heads.length <= mod.HEADLINES, mod.est(heads.join("\n")) <= mod.HEADLINE_BUDGET], [true, true]);
	t("headlines: newest first", heads[0]?.includes("entry 7"), true);
	t("headlines: none when asked", mod.sectionText(p, g, 0).split("\n").length, 1);
	t("headlines: two when only two fit", (() => { const q = new mod.Store(join(work, "q"), "project", r); for (let i = 0; i < 3; i++) q.upsert({ kind: "fact", gist: `f${i} ${"long ".repeat(70)}` }, i); return mod.sectionText(q, g, 3).split("\n").length; })(), 4);
	t("the tool's cost is estimated", mod.toolCost() > 50 && mod.toolCost() < 400, true);
	console.log(`      cost: line ${mod.est(line)} tokens, with ${heads.length} headlines ${mod.est(sec)} tokens, tool ${mod.toolCost()} tokens (3.6 chars a token)`);
}

// --- the tool, the hint and the command in a session
{
	const h = await load();
	const r = repo("sess");
	await h.handlers.session_start({}, h.ctx(r));
	t("start: nothing to report", h.notices, []);
	const sec = { systemPromptOptions: { sections: {} } };
	await h.handlers.before_agent_start(sec);
	has("the section is there from the first turn", sec.systemPromptOptions.sections.lets_code_core_memory, "Core memory (lets-code), not in context: 0 entries");
	t("tool: the name and a short snippet", [h.tool.name, h.mod.est(h.tool.promptSnippet) < 30], ["memory", true]);
	let res = await h.run(r, { action: "remember", kind: "decision", gist: "port 8796 for live tests", refs: ["src/a.ts:2", "run:r9"] });
	has("remember: the rendered line back", textOf(res), "decision #");
	t("remember: not an error", res.isError, false);
	res = await h.run(r, { action: "remember", gist: "the user's words here", by: "user" });
	const st = h.mod.stores(r);
	t("remember: by user when the user asked", st.project.entries.find((e) => e.gist === "the user's words here")?.by, "user");
	res = await h.run(r, { action: "remember", gist: "use sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456 for the proxy" });
	t("remember: a secret is refused", [res.isError, st.project.entries.length], [true, 2]);
	has("  and says why", textOf(res), "looks like a token, key or password");
	res = await h.run(r, { action: "remember", gist: "a global preference", scope: "global", kind: "preference" });
	t("remember: global scope", st.global.entries.length, 1);
	res = await h.run(r, { action: "search", query: "8796" });
	has("search: finds by a word", textOf(res), "port 8796 for live tests");
	res = await h.run(r, { action: "search", query: "preference" });
	has("search: both scopes by default, global marked", textOf(res), "(global)");
	res = await h.run(r, { action: "search", query: "nothing-like-this" });
	has("search: nothing", textOf(res), "No entry matches");
	has("search: says how to reach the archive", textOf(res), "scope: archive");
	st.project.upsert({ kind: "work", gist: "ancient work", refs: ["run:a0"] }, Date.now() - 400 * 86_400_000); st.project.archive(h.mod.ARCHIVE_DAYS); st.project.save();
	t("search: the archive by scope", [textOf(await h.run(r, { action: "search", query: "ancient" })).includes("ancient work"), textOf(await h.run(r, { action: "search", query: "ancient", scope: "archive" })).includes("ancient work")], [false, true]);
	res = await h.run(r, { action: "search", query: "src/a.ts" });
	has("search: by path", textOf(res), "8796");
	res = await h.run(r, { action: "open", ref: "src/a.ts:2" });
	has("open: a file around its line", textOf(res), "2: line2");
	res = await h.run(r, { action: "open", ref: "run:r9" });
	has("open: a run that is not there", textOf(res), "No run r9");
	const sess = join(work, "s.jsonl");
	writeFileSync(sess, [JSON.stringify({ type: "session", id: "x" }), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the login bug" }] } }), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done, see src/a.ts" }] } })].join("\n") + "\n");
	res = await h.run(r, { action: "open", ref: `session:${sess}` });
	has("open: a session file: its first message", textOf(res), "first: fix the login bug");
	has("open: a session file: its last reply", textOf(res), "last reply: done, see src/a.ts");
	res = await h.run(r, { action: "bogus" });
	t("an unknown action is an error", res.isError, true);
	// the hint on a tool result
	const hint = (toolName, input, extra = {}) => h.handlers.tool_result({ toolName, input, content: [{ type: "text", text: "..." }], isError: false, ...extra });
	let out = await hint("read", { path: "src/a.ts" });
	t("hint: a read of a file an entry points at gets one line", out?.content?.map((c) => c.text), ["...", "core memory: 1 entry mentions this (memory search src/a.ts)"]);
	out = await hint("grep", { pattern: "x", path: "src" });
	t("hint: a directory above it too", out?.content?.[1]?.text, "core memory: 1 entry mentions this (memory search src)");
	t("hint: an unrelated file gets nothing", await hint("read", { path: "README.md" }), undefined);
	t("hint: an error result gets nothing", await hint("read", { path: "src/a.ts" }, { isError: true }), undefined);
	t("hint: bash is not lexed", await hint("bash", { command: "cat src/a.ts" }), undefined);
	t("hint: the memory tool itself gets nothing", await hint("memory", { action: "search", query: "src/a.ts" }), undefined);
	out = await hint("read", { path: `${agentDir}/lets-code-runs/s1/r9.json` });
	t("hint: a run's record by its id", out?.content?.[1]?.text?.startsWith("core memory: 1 entry mentions this"), true);
	// forget
	const id = st.project.entries[0].id;
	res = await h.run(r, { action: "forget", ref: `#${id}` });
	t("forget: by id, with or without #", [res.isError, st.project.entries.some((e) => e.id === id)], [false, false]);
	t("forget: unknown", (await h.run(r, { action: "forget", ref: "nope" })).isError, true);
	t("forget: no ref", (await h.run(r, { action: "forget" })).isError, true);
	// the command
	h.notices.length = 0;
	await h.cmd(r, "");
	has("/memory: counts and the file", h.notices[0][0], `1 entries, 1 archived; ${st.project.md}`);
	has("/memory: the token cost", h.notices[0][0], "always on: ~");
	await h.cmd(r, "show words");
	has("/memory show <query>: searches", h.notices[1][0], `1 match "words"`);
	await h.cmd(r, "global");
	has("/memory global", h.notices[2][0], "a global preference");
	await h.cmd(r, "edit", { edited: st.project.render() + "- fact added in the editor\n" });
	t("/memory edit: the editor's text is read back", [h.notices[3][0], st.project.entries.some((e) => e.gist === "added in the editor" || e.gist === "fact added in the editor")], ["core memory: 1 kept, 1 added, 0 removed", true]);
	await h.cmd(r, "edit", { edited: undefined });
	t("/memory edit: cancelled", h.notices[4][0], "unchanged");
	await h.cmd(r, "edit", { ui: false });
	t("/memory edit: without a UI", h.notices.length, 5);
	await h.cmd(r, `forget ${st.project.entries[0].id}`);
	has("/memory forget", h.notices[5][0], "forgot - ");
	await h.cmd(r, "archive");
	has("/memory archive: nothing old", h.notices[6][0], "nothing older than");
	await h.cmd(r, "archive x");
	has("/memory archive: bad days", h.notices[7][0], "Usage:");
	await h.cmd(r, "what");
	has("/memory: usage", h.notices[8][0], "Usage: /memory");
	// a corrupt line is reported at the next start, once
	writeFileSync(st.project.file, readFileSync(st.project.file, "utf8") + "garbage\n");
	h.notices.length = 0; await h.handlers.session_start({}, h.ctx(r));
	has("start: unreadable lines are reported, not fatal", h.notices[0]?.[0], "1 unreadable line skipped");
	t("  as a warning", h.notices[0]?.[1], "warning");
}

// --- the harness writers
{
	const h = await load();
	const r = repo("harness");
	await h.handlers.session_start({}, h.ctx(r));
	// a factory run
	const fdir = join(agentDir, "lets-code-factory", "k3f"); mkdirSync(join(fdir, "artifacts"), { recursive: true });
	writeFileSync(join(fdir, "artifacts", "change.patch"), "diff --git a/src/a.ts b/src/a.ts\n--- a\n+++ b\ndiff --git a/src/new.ts b/src/new.ts\n");
	const L = { v: 1, id: "k3f", repo: r, work: join(work, "wt-k3f"), branch: "factory/k3f", dir: fdir, ticket: "# Add a login form\n\nDetails.", status: "done", note: "", entries: [{ stage: "intake", verdict: "2 criteria" }, { stage: "build", verdict: "DONE" }, { stage: "expert-review", verdict: "REVISE" }, { stage: "build", round: 1, verdict: "DONE" }, { stage: "expert-review", round: 1, verdict: "APPROVE" }, { stage: "judge", verdict: "ACCEPT" }] };
	t("factory: a running run writes nothing", h.mod.noteFactoryRun({ ...L, status: "running" }), undefined);
	const e = h.mod.noteFactoryRun(L);
	t("factory: title, branch, the last verdict per stage, files", e.gist, "factory k3f done: Add a login form; branch factory/k3f; build DONE, expert-review APPROVE, judge ACCEPT; 2 files");
	t("factory: pointers to the run, the worktree and the files", e.refs, ["factory:k3f", join(work, "wt-k3f"), `${r}/src/a.ts`, `${r}/src/new.ts`]);
	const e2 = h.mod.noteFactoryRun({ ...L, status: "stopped", note: "the user stopped it at the plan checkpoint" });
	t("factory: the same run again updates its entry", [e2.id === e.id, e2.gist.startsWith("factory k3f stopped (the user stopped it at the plan checkpoint)")], [true, true]);
	const st = h.mod.stores(r);
	t("factory: on disk", readFileSync(st.project.file, "utf8").includes('"factory:k3f"'), true);
	// a subagent run
	const rec = { id: "r1", agent: "researcher", kind: "expert", task: "compare the two libraries\nin detail", cwd: r, session: "s1", status: "done", sessionFile: `${agentDir}/lets-code-runs/s1/r1.pi.jsonl` };
	t("subagent: a running run writes nothing", h.mod.noteSubagentRun({ ...rec, status: "running" }), undefined);
	t("subagent: a factory stage's run is the factory's entry", h.mod.noteSubagentRun({ ...rec, parent: { tool: "factory" } }), undefined);
	const s = h.mod.noteSubagentRun(rec);
	t("subagent: agent, status, the task's gist", s.gist, "expert researcher done: compare the two libraries in detail");
	t("subagent: pointers to the run, its record and its session", s.refs, ["run:r1", `${agentDir}/lets-code-runs/s1/r1.json`, `${agentDir}/lets-code-runs/s1/r1.pi.jsonl`]);
	// the session pointer, after the first turn and at the end
	const file = join(work, "main.jsonl");
	const entries = [{ type: "message", message: { role: "user", content: "[lets-code] a nudge" } }, { type: "message", message: { role: "user", content: [{ type: "text", text: "please add core memory to lets-code" }] } }, { type: "message", message: { role: "assistant", content: "ok" } }];
	await h.handlers.agent_end({}, h.ctx(r, { file, entries }));
	const p = st.project.entries.find((x) => x.kind === "pointer");
	t("session: a pointer after the first turn, the first message as the gist (nudges aside)", [p?.gist, p?.refs], ["session (1 prompt): please add core memory to lets-code", [file]]);
	entries.push({ type: "message", message: { role: "user", content: "and tests" } });
	await h.handlers.agent_end({}, h.ctx(r, { file, entries }));
	t("session: not rewritten every turn", st.project.entries.filter((x) => x.kind === "pointer").length === 1 && p.gist.startsWith("session (1 prompt)"), true);
	await h.handlers.session_shutdown({ reason: "quit" }, h.ctx(r, { file, entries }));
	t("session: refreshed at the end, the same entry", [st.project.entries.filter((x) => x.kind === "pointer").length, p.gist], [1, "session (2 prompts): please add core memory to lets-code"]);
	t("session: a run's own session is not this session", h.mod.noteSession(h.ctx(r, { file: `${agentDir}/lets-code-runs/s1/r1.pi.jsonl`, entries })), undefined);
	t("session: no file (--no-session), no pointer", h.mod.noteSession(h.ctx(r, { file: undefined, entries })), undefined);
	// the hint for an expert call that resumes a factory run
	const out = await h.handlers.tool_result({ toolName: "expert", input: { action: "run", name: "software-factory", brief: { resume: "k3f" } }, content: [{ type: "text", text: "..." }], isError: false });
	t("hint: an expert call resuming a factory run", out?.content?.[1]?.text, "core memory: 1 entry mentions this (memory search factory:k3f)");
	// the section after entries exist, from a fresh session
	const h2 = await load();
	await h2.handlers.session_start({}, h2.ctx(r));
	const sec = { systemPromptOptions: { sections: {} } };
	await h2.handlers.before_agent_start(sec);
	const text = sec.systemPromptOptions.sections.lets_code_core_memory;
	has("the next session's line counts them", text, "3 entries for this project");
	has("the next session's headlines", text, "Newest:\n- ");
	t("the headlines are the three newest, one line each", text.split("\n").length, 5);
	t("the section stays as it was for the session", (await h2.run(r, { action: "remember", gist: "later" }), await h2.handlers.before_agent_start(sec), sec.systemPromptOptions.sections.lets_code_core_memory === text), true);
	t("headlines off by the setting", await (async () => { const h3 = await load({ LETS_CODE_CORE_MEMORY_HEADLINES: "0" }); await h3.handlers.session_start({}, h3.ctx(r)); const s3 = { systemPromptOptions: { sections: {} } }; await h3.handlers.before_agent_start(s3); return s3.systemPromptOptions.sections.lets_code_core_memory.split("\n").length; })(), 1);
}

// --- a child session reads but the harness writes no pointers there
{
	const h = await load({ LETS_CODE_SUBAGENT_DEPTH: "1" });
	const r = repo("harness");
	await h.handlers.session_start({}, h.ctx(r));
	const before = readFileSync(h.mod.stores(r).project.file, "utf8");
	const sec = { systemPromptOptions: { sections: {} } };
	await h.handlers.before_agent_start(sec);
	has("child: sees the line", sec.systemPromptOptions.sections.lets_code_core_memory, "entries for this project");
	t("child: has the tool", h.tool?.name, "memory");
	const file = join(work, "child.jsonl");
	await h.handlers.agent_end({}, h.ctx(r, { file, entries: [{ type: "message", message: { role: "user", content: "child task" } }] }));
	await h.handlers.session_shutdown({ reason: "quit" }, h.ctx(r, { file, entries: [{ type: "message", message: { role: "user", content: "child task" } }] }));
	t("child: no session pointer", [h.mod.noteSession(h.ctx(r, { file, entries: [] })), readFileSync(h.mod.stores(r).project.file, "utf8") === before], [undefined, true]);
	t("child: no factory or run entries either", [h.mod.noteFactoryRun({ id: "z", status: "done", repo: r, entries: [], ticket: "x" }), h.mod.noteSubagentRun({ id: "z", status: "done", cwd: r })], [undefined, undefined]);
	has("child: search still works", textOf(await h.run(r, { action: "search", query: "factory" })), "factory:k3f");
}

console.log(`${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
