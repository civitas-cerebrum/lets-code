#!/usr/bin/env node
// Unit test for the git guard extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-gitguard.ts). Loads it with a fake pi,
// drives the tool_call handler against throwaway repos. Needs Node >= 22.6
// (runs the .ts directly: it only imports types from pi).
//
//   tests/git-guard.test.mjs [path/to/lets-code-gitguard.ts]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(process.env.HOME, ".pi/agent/extensions/lets-code-gitguard.ts");
process.env.LETS_CODE_GIT_GUARD_ON = "1";

// Node strips types but does not resolve the type-only import of a package
// that is not installed here; rewrite the extension into a temp copy without it.
const work = mkdtempSync(join(tmpdir(), "gitguard-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
const extCopy = join(work, "gitguard.ts");
writeFileSync(extCopy, src);
const { default: register } = await import(pathToFileURL(extCopy).href);

let handler;
register({ on: (ev, h) => { if (ev === "tool_call") handler = h; return () => {}; } });
if (!handler) throw new Error("extension did not register a tool_call handler");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
function repo(branch) {
	const d = mkdtempSync(join(work, "repo-"));
	git(d, "init", "-q", "-b", branch);
	git(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
	return d;
}
const call = (toolName, input, cwd) => handler({ type: "tool_call", toolCallId: "x", toolName, input }, { cwd });

let fail = 0;
async function check(name, p, wantBlocked) {
	const r = await p;
	const blocked = !!r?.block;
	const ok = blocked === wantBlocked;
	if (!ok) fail = 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${name} -> ${blocked ? "blocked" : "allowed"}${blocked ? `: ${r.reason.slice(0, 70)}…` : ""}`);
}

const main = repo("main"), pi = repo("pi/test");
const plain = mkdtempSync(join(work, "plain-"));
mkdirSync(join(main, "sub"));
const wt = join(work, "wt"); git(main, "worktree", "add", "-q", "-b", "pi/wt", wt);
const wtMain = join(work, "wt-main"); git(pi, "worktree", "add", "-q", "-b", "feature", wtMain);

await check("write on main",                    call("write", { path: join(main, "a.txt"), content: "x" }, main), true);
await check("edit in subdir on main (rel path)", call("edit", { path: "sub/a.txt", edits: [] }, main), true);
await check("bash on main: ls",                 call("bash", { command: "ls -la" }, main), true);
await check("bash on main: git status",         call("bash", { command: "git status" }, main), false);
await check("bash on main: git switch -c pi/x", call("bash", { command: "git switch -c pi/fix" }, main), false);
await check("bash on main: git checkout -b bad", call("bash", { command: "git checkout -b feature/x" }, main), true);
await check("bash on main: git stash",          call("bash", { command: "git stash" }, main), false);
await check("read on main",                     call("read", { path: join(main, "a.txt") }, main), false);
await check("write on pi/test",                 call("write", { path: join(pi, "a.txt"), content: "x" }, pi), false);
await check("bash on pi/test: anything",        call("bash", { command: "npm test" }, pi), false);
await check("bash on pi/test: new non-pi branch", call("bash", { command: "git switch -c hotfix" }, pi), true);
await check("bash on pi/test: new pi branch",   call("bash", { command: "git switch -c pi/other" }, pi), false);
await check("write outside any repo",           call("write", { path: join(plain, "a.txt"), content: "x" }, plain), false);
await check("write in worktree on pi/wt",       call("write", { path: join(wt, "a.txt"), content: "x" }, wt), false);
await check("write in worktree on feature",     call("write", { path: join(wtMain, "a.txt"), content: "x" }, wtMain), true);
git(main, "checkout", "-q", "--detach");
await check("write on detached HEAD",           call("write", { path: join(main, "a.txt"), content: "x" }, main), true);

rmSync(work, { recursive: true, force: true });
process.exit(fail);
