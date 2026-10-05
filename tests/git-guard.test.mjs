#!/usr/bin/env node
// Unit test for the git guard extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-gitguard.ts). Loads it with a fake pi,
// drives the tool_call handler against throwaway repos. Needs Node >= 22.6
// (runs the .ts directly: it only imports types from pi).
//
//   tests/git-guard.test.mjs [path/to/lets-code-gitguard.ts]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-gitguard.ts");
process.env.LETS_CODE_GIT_GUARD_ON = "1";

// Node strips types but does not resolve the type-only import of a package
// that is not installed here; rewrite the extension into a temp copy without it.
const work = realpathSync(mkdtempSync(join(tmpdir(), "gitguard-test-")));
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

let fail = 0, n = 0;
async function check(name, p, wantBlocked) {
	const r = await p;
	const blocked = !!r?.block;
	const ok = blocked === wantBlocked;
	n++;
	if (!ok) fail = 1;
	if (blocked && r.reason.length > 200) { fail = 1; console.log(`FAIL  reason too long (${r.reason.length} chars): ${name}`); }
	console.log(`${ok ? "ok  " : "FAIL"}  ${name} -> ${blocked ? "blocked" : "allowed"}${blocked ? `: ${r.reason.slice(0, 60)}…` : ""}`);
}
const bash = (cmd, cwd, want) => check(`bash [${relative(work, cwd).split("-")[0]}] ${cmd}`, call("bash", { command: cmd }, cwd), want);

const main = repo("main"), pi = repo("pi/test");
const plain = mkdtempSync(join(work, "plain-"));
mkdirSync(join(main, "sub"));
const wt = join(work, "wt"); git(main, "worktree", "add", "-q", "-b", "pi/wt", wt);
const wtMain = join(work, "wt-main"); git(pi, "worktree", "add", "-q", "-b", "feature", wtMain);
symlinkSync(main, join(plain, "link-to-main"));

console.log("# edit/write by repo state");
await check("write on main",                     call("write", { path: join(main, "a.txt"), content: "x" }, main), true);
await check("edit in subdir on main (rel path)",  call("edit", { path: "sub/a.txt", edits: [] }, main), true);
await check("write new nested dirs on main",      call("write", { path: join(main, "x/y/z.txt"), content: "x" }, main), true);
await check("write via symlink into main",        call("write", { path: join(plain, "link-to-main/a.txt"), content: "x" }, plain), true);
await check("write on pi/test",                   call("write", { path: join(pi, "a.txt"), content: "x" }, pi), false);
await check("write outside any repo",             call("write", { path: join(plain, "a.txt"), content: "x" }, plain), false);
await check("write in worktree on pi/wt",         call("write", { path: join(wt, "a.txt"), content: "x" }, wt), false);
await check("write in worktree on feature",       call("write", { path: join(wtMain, "a.txt"), content: "x" }, wtMain), true);
await check("read on main",                       call("read", { path: join(main, "a.txt") }, main), false);
await check("custom tool on main",                call("my_tool", { x: 1 }, main), false);
{	// ~ expansion: a repo on main under $HOME is judged correctly
	const homeRepo = mkdtempSync(join(homedir(), ".gitguard-test-"));
	try {
		git(homeRepo, "init", "-q", "-b", "main");
		await check("write with ~/ path into main repo", call("write", { path: `~/${relative(homedir(), homeRepo)}/a.txt`, content: "x" }, plain), true);
	} finally { rmSync(homeRepo, { recursive: true, force: true }); }
}

console.log("# bash off-branch: only plain inspection / switching");
await bash("ls -la", main, true);
await bash("npm test", main, true);
await bash("git status", main, false);
await bash("git status --short", main, false);
await bash("git log --oneline -5", main, false);
await bash("git diff HEAD~1", main, false);
await bash("git branch -a", main, false);
await bash("git branch --show-current", main, false);
await bash("git stash list", main, false);
await bash("git fetch origin", main, false);
await bash("git switch -c pi/fix", main, false);
await bash("git switch --create pi/fix", main, false);
await bash("git checkout -b pi/fix", main, false);
await bash("git switch pi/test", main, false);
await bash("git checkout pi/test", main, false);
await bash("git -C . switch -c pi/fix", main, false);
await bash("git stash", main, true);                        // stash push could be lost with a later drop; make the branch first
await bash("git checkout .", main, true);
await bash("git checkout main -- src/a.c", main, true);
await bash("git branch -D pi/t", main, true);
await bash("git branch -f main HEAD~10", main, true);
await bash("git stash drop", main, true);
await bash("git stash clear", main, true);
await bash("git log --output=x.txt", main, true);
await bash("git diff > out.txt", main, true);

console.log("# bash off-branch: compound commands hide nothing");
await bash("git status; rm -rf src", main, true);
await bash("git log\nrm -rf src", main, true);
await bash("git status && make install", main, true);
await bash("git status || make install", main, true);
await bash("git status | tee out.txt", main, true);
await bash("git status $(rm -rf src)", main, true);
await bash("git status `rm -rf src`", main, true);
await bash("git switch main && rm -rf src", main, true);
await bash("git switch -c pi/x && git checkout -b hotfix", main, true);

console.log("# naming rule (both branches)");
await bash("git checkout -b feature/x", main, true);
await bash("git switch -c hotfix", pi, true);
await bash("git switch --create hotfix", pi, true);
await bash("git switch -chotfix", pi, true);
await bash("git checkout -b hotfix", pi, true);
await bash("git checkout --orphan hotfix", pi, true);
await bash("git branch hotfix", pi, true);
await bash("git branch hotfix && git switch hotfix", pi, true);
await bash("git -C . checkout -b hotfix", pi, true);
await bash("git worktree add -b hotfix ../wt2", pi, true);
await bash("git switch -c pi/x && git checkout -b hotfix", pi, true);
await bash("git switch -c pi/other", pi, false);
await bash("git branch pi/other", pi, false);
await bash("git worktree add -b pi/wt3 ../wt3", pi, false);
await bash("git branch -a", pi, false);
await bash("git branch --list 'pi/*'", pi, false);

console.log("# destructive commands refused on any branch");
await bash("npm test", pi, false);
await bash("git add -A && git commit -m wip", pi, false);
await bash("git push -u origin pi/test", pi, false);
await bash("git push", pi, false);
await bash("git push -f origin main", pi, true);
await bash("git push --force origin main", pi, true);
await bash("git push --force-with-lease", pi, true);
await bash("git push origin --delete main", pi, true);
await bash("git push origin +main", pi, true);
await bash("git push origin pi/test:main", pi, true);
await bash("git branch -D main", pi, true);
await bash("git branch -d pi/old", pi, true);
await bash("git branch -M main", pi, true);
await bash("git branch --delete old", pi, true);
await bash("git branch -m pi/a pi/b", pi, false);
await bash("git reset --hard HEAD~5", pi, true);
await bash("git reset --hard", pi, true);
await bash("git reset --merge", pi, true);
await bash("git reset HEAD~1", pi, false);
await bash("git reset --soft HEAD~1", pi, false);
await bash("git checkout .", pi, true);
await bash("git checkout -- a.txt", pi, true);
await bash("git checkout main -- a.txt", pi, true);
await bash("git checkout -f pi/other", pi, true);
await bash("git restore a.txt", pi, true);
await bash("git restore --staged a.txt", pi, false);
await bash("git restore --staged --worktree a.txt", pi, true);
await bash("git restore -S -W a.txt", pi, true);
await bash("git clean -fdx", pi, true);
await bash("git clean -f", pi, true);
await bash("git clean -n", pi, false);
await bash("git stash drop", pi, true);
await bash("git stash clear", pi, true);
await bash("git stash pop", pi, false);
await bash("git stash", pi, false);
await bash("git update-ref -d refs/heads/main", pi, true);
await bash("git reflog expire --expire=now --all", pi, true);
await bash("git gc --prune=now", pi, true);
await bash("git gc", pi, false);
await bash("git filter-branch --all", pi, true);
await bash("git worktree remove --force ../wt", pi, true);
await bash("git worktree remove ../wt", pi, false);
await bash("git --no-pager push -f", pi, true);
await bash("git -C /tmp/x push --force", pi, true);
await bash("git -c user.name=x reset --hard", pi, true);
await bash("echo ok; git push --force", pi, true);
await bash("rm -rf .git", pi, true);
await bash("rm -fr .git", pi, true);
await bash("rm -rf ./.git/", pi, true);
await bash("rm -rf sub/.git", pi, true);
await bash("rm -r -f .git", pi, true);
await bash("rm -rf .", pi, true);
await bash("rm -rf ./", pi, true);
await bash("rm -rf *", pi, true);
await bash("rm -rf ~", pi, true);
await bash("rm -rf /", pi, true);
await bash("rm -rf $HOME", pi, true);
await bash("cd build && rm -rf .git", pi, true);
await bash("rm -rf build", pi, false);
await bash("rm -rf build/*", pi, false);
await bash("rm .gitignore", pi, false);
await bash("rm -rf .github", pi, false);

console.log("# directories a command moves into are judged too");
await bash(`cd ${main} && echo x > a.txt`, pi, true);
await bash(`cd "${main}" && echo x > a.txt`, pi, true);
await bash(`pushd ${main}; echo x > a.txt`, pi, true);
await bash(`git -C ${main} commit -am x`, pi, true);
await bash(`cd ${pi} && echo x > a.txt`, main, true);        // cwd is still main
await bash(`cd ${plain} && echo x > a.txt`, pi, false);
await bash(`cd ${wt} && echo x > a.txt`, pi, false);
await bash("cd sub && ls", pi, false);
await bash("cd - && ls", pi, false);

console.log("# detached HEAD");
git(main, "checkout", "-q", "--detach");
await check("write on detached HEAD", call("write", { path: join(main, "a.txt"), content: "x" }, main), true);
await bash("git switch -c pi/from-detached", main, false);

console.log(`\n${n} cases, ${fail ? "FAILURES" : "all passed"}`);
rmSync(work, { recursive: true, force: true });
process.exit(fail);
