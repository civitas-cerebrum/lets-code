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
import { join, relative, basename } from "node:path";
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

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString();
function repo(branch) {
	const d = mkdtempSync(join(work, "repo-"));
	git(d, "init", "-q", "-b", branch);
	git(d, "commit", "-q", "--allow-empty", "-m", "init");
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
const tag = (cwd) => basename(cwd).replace(/-.*$/, "");
const bash = (cmd, cwd, want) => check(`bash [${tag(cwd)}] ${JSON.stringify(cmd)}`, call("bash", { command: cmd }, cwd), want);

const main = repo("main"), pi = repo("pi/test");
const plain = mkdtempSync(join(work, "plain-"));
mkdirSync(join(main, "sub"));
mkdirSync(join(pi, "build"));
writeFileSync(join(pi, "a.txt"), "a"); git(pi, "add", "a.txt"); git(pi, "commit", "-q", "-m", "a");
writeFileSync(join(main, "m.txt"), "m"); git(main, "add", "m.txt"); git(main, "commit", "-q", "-m", "m");
const wt = join(work, "wt"); git(main, "worktree", "add", "-q", "-b", "pi/wt", wt);
const wtMain = join(work, "wt-main"); git(pi, "worktree", "add", "-q", "-b", "feature", wtMain);
symlinkSync(main, join(plain, "link-to-main"));
symlinkSync(main, join(pi, "link-to-main"));

console.log("# edit/write by repo state");
await check("write on main",                     call("write", { path: join(main, "a.txt"), content: "x" }, main), true);
await check("edit in subdir on main (rel path)",  call("edit", { path: "sub/a.txt", edits: [] }, main), true);
await check("write new nested dirs on main",      call("write", { path: join(main, "x/y/z.txt"), content: "x" }, main), true);
await check("write via symlink into main",        call("write", { path: join(plain, "link-to-main/a.txt"), content: "x" }, plain), true);
await check("write via symlink inside pi repo",   call("write", { path: "link-to-main/a.txt", content: "x" }, pi), true);
await check("write with .. into main",            call("write", { path: `../${basename(main)}/a.txt`, content: "x" }, pi), true);
await check("write with @ prefix into main",      call("write", { path: `@${join(main, "a.txt")}`, content: "x" }, pi), true);
await check("write with file:// into main",       call("write", { path: pathToFileURL(join(main, "a.txt")).href, content: "x" }, pi), true);
await check("write on pi/test",                   call("write", { path: join(pi, "a.txt"), content: "x" }, pi), false);
await check("write with @ prefix on pi/test",     call("write", { path: "@a.txt", content: "x" }, pi), false);
await check("write outside any repo",             call("write", { path: join(plain, "a.txt"), content: "x" }, plain), false);
await check("write in worktree on pi/wt",         call("write", { path: join(wt, "a.txt"), content: "x" }, wt), false);
await check("write in worktree on feature",       call("write", { path: join(wtMain, "a.txt"), content: "x" }, wtMain), true);
await check("write into .git/HEAD",               call("write", { path: join(pi, ".git/HEAD"), content: "x" }, pi), true);
await check("edit .git/refs/heads/main",          call("edit", { path: ".git/refs/heads/main", edits: [] }, pi), true);
await check("write into worktree gitdir",         call("write", { path: join(wt, ".git"), content: "x" }, wt), true);
await check("write .gitignore on pi/test",        call("write", { path: join(pi, ".gitignore"), content: "x" }, pi), false);
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
await bash("echo x > a.txt", main, true);
await bash("git status", main, false);
await bash("git status --short", main, false);
await bash("git log --oneline -5", main, false);
await bash("git diff HEAD~1", main, false);
await bash("git branch -a", main, false);
await bash("git branch --show-current", main, false);
await bash("git branch --merged", main, false);
await bash("git stash list", main, false);
await bash("git fetch origin", main, false);
await bash("git reflog", main, false);
await bash("git show-ref", main, false);
await bash("git config --get user.name", main, false);
await bash("git switch -c pi/fix", main, false);
await bash("git switch -c pi/fix main", main, false);
await bash("git switch --create pi/fix", main, false);
await bash("git checkout -b pi/fix", main, false);
await bash("git checkout -b pi/fix origin/main", main, false);
await bash("git switch pi/test", main, false);
await bash("git checkout pi/test", main, false);
await bash("git -C . switch -c pi/fix", main, false);
await bash("git status 2>/dev/null", main, false);
await bash("git status 2>&1", main, false);
await bash("git stash", main, true);                        // stash push could be lost with a later drop; make the branch first
await bash("git checkout .", main, true);
await bash("git checkout main -- src/a.c", main, true);
await bash("git branch -D pi/t", main, true);
await bash("git branch -f main HEAD~10", main, true);
await bash("git stash drop", main, true);
await bash("git stash clear", main, true);
await bash("git log --output=x.txt", main, true);
await bash("git diff > out.txt", main, true);
await bash("git status 2>err.txt", main, true);
await bash("git merge --abort", main, true);               // no merge in progress: not an abort, don't allow

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
await bash("git status & make", main, true);
await bash("(git status; make)", main, true);
await bash("{ git status; make; }", main, true);
await bash("git status # make", main, false);
await bash("git status; git log", main, false);
await bash("git status && git switch -c pi/x", main, false);

console.log("# naming rule (both branches)");
await bash("git checkout -b feature/x", main, true);
await bash("git switch -c hotfix", pi, true);
await bash("git switch --create hotfix", pi, true);
await bash("git switch --create=hotfix", pi, true);
await bash("git switch -chotfix", pi, true);
await bash("git checkout -b hotfix", pi, true);
await bash("git checkout --orphan hotfix", pi, true);
await bash("git branch hotfix", pi, true);
await bash("git branch hotfix main", pi, true);
await bash("git branch hotfix && git switch hotfix", pi, true);
await bash("git branch -m main", pi, true);                 // rename current pi/test to main
await bash("git branch -m pi/a b", pi, true);
await bash("git -C . checkout -b hotfix", pi, true);
await bash("git worktree add -b hotfix ../wt2", pi, true);
await bash("git worktree add ../wt2", pi, true);            // implicit branch wt2
await bash("git switch -t origin/hotfix", pi, true);
await bash("git checkout --track origin/hotfix", pi, true);
await bash("git switch -c pi/x && git checkout -b hotfix", pi, true);
await bash("git switch -c pi/other", pi, false);
await bash("git branch pi/other", pi, false);
await bash("git branch -m pi/a pi/b", pi, false);
await bash("git worktree add -b pi/wt3 ../wt3", pi, false);
await bash("git worktree add ../pi-wt4 pi/test", pi, false);  // existing branch, no creation
await bash("git switch -t origin/pi/x", pi, false);
await bash("git branch -a", pi, false);
await bash("git branch --list 'pi/*'", pi, false);
await bash("git branch -vv", pi, false);
await bash("git branch --set-upstream-to=origin/pi/test", pi, false);

console.log("# destructive commands refused on any branch");
await bash("npm test", pi, false);
await bash("git add -A && git commit -m wip", pi, false);
await bash("git push -u origin pi/test", pi, false);
await bash("git push", pi, false);
await bash("git push origin HEAD:pi/test", pi, false);
await bash("git push origin pi/test:pi/test", pi, false);
await bash("git push origin HEAD:refs/heads/pi/test", pi, false);
await bash("git push -f origin main", pi, true);
await bash("git push --force origin main", pi, true);
await bash("git push --force-with-lease", pi, true);
await bash("git push origin --delete main", pi, true);
await bash("git push origin +main", pi, true);
await bash("git push origin :pi/old", pi, true);
await bash("git push origin pi/test:main", pi, true);
await bash("git push --mirror backup", pi, true);
await bash("git push --prune origin", pi, true);
await bash("git branch -D main", pi, true);
await bash("git branch -d pi/old", pi, false);                // safe delete (refuses unmerged)
await bash("git branch -M main", pi, true);
await bash("git branch --delete --force old", pi, true);
await bash("git branch -m pi/a pi/b", pi, false);
await bash("git tag -d v1", pi, true);
await bash("git tag v1", pi, false);
await bash("git reset --hard HEAD~5", pi, true);
await bash("git reset --hard", pi, true);
await bash("git reset --merge", pi, true);
await bash("git reset HEAD~1", pi, false);
await bash("git reset --soft HEAD~1", pi, false);
await bash("git reset a.txt", pi, false);
await bash("git checkout .", pi, true);
await bash("git checkout -- a.txt", pi, true);
await bash("git checkout main -- a.txt", pi, true);
await bash("git checkout a.txt", pi, true);                   // an existing path
await bash("git checkout HEAD a.txt", pi, true);
await bash("git checkout HEAD~1 a.txt", pi, true);
await bash("git checkout -f pi/other", pi, true);
await bash("git checkout -B pi/test main", pi, true);
await bash("git checkout -p", pi, true);
await bash("git checkout pi/other", pi, false);
await bash("git checkout -b pi/new", pi, false);
await bash("git checkout --detach", pi, false);
await bash("git switch -f main", pi, true);
await bash("git switch --discard-changes main", pi, true);
await bash("git switch -C pi/test main", pi, true);
await bash("git switch pi/other", pi, false);
await bash("git restore a.txt", pi, true);
await bash("git restore --staged a.txt", pi, false);
await bash("git restore --staged .", pi, false);
await bash("git restore --staged --worktree a.txt", pi, true);
await bash("git restore -S -W a.txt", pi, true);
await bash("git restore --source=HEAD~1 a.txt", pi, true);
await bash("git clean -fdx", pi, true);
await bash("git clean -f", pi, true);
await bash("git clean -n", pi, false);
await bash("git clean -nd", pi, false);
await bash("git clean --dry-run -x", pi, false);
await bash("git stash drop", pi, true);
await bash("git stash clear", pi, true);
await bash("git stash pop", pi, false);
await bash("git stash", pi, false);
await bash("git stash push -- a.txt", pi, false);
await bash("git rm --cached -r .", pi, false);
await bash("git rm -r --cached .", pi, false);
await bash("git rm a.txt", pi, false);
await bash("git rm -f a.txt", pi, true);
await bash("git update-ref -d refs/heads/main", pi, true);
await bash("git symbolic-ref HEAD refs/heads/main", pi, true);
await bash("git symbolic-ref HEAD", pi, false);
await bash("git reflog expire --expire=now --all", pi, true);
await bash("git reflog", pi, false);
await bash("git gc --prune=now", pi, true);
await bash("git gc", pi, false);
await bash("git filter-branch --all", pi, true);
await bash("git worktree remove --force ../wt", pi, true);
await bash("git worktree remove ../wt", pi, false);
await bash("git worktree prune", pi, false);
await bash("git rebase main", pi, false);
await bash("git commit --amend --no-edit", pi, false);
await bash("git --no-pager push -f", pi, true);
await bash("git -C /tmp/x push --force", pi, true);
await bash("git -c user.name=x reset --hard", pi, true);
await bash("git -C 'dir with space' push -f", pi, true);
await bash("echo ok; git push --force", pi, true);
await bash("env git push -f", pi, true);
await bash("sudo git push -f", pi, true);
await bash("sudo -u ay git push -f", pi, true);
await bash("command git push -f", pi, true);
await bash("PAGER=cat git push -f", pi, true);
await bash("timeout 10 git push -f", pi, true);
await bash("nohup git push -f &", pi, true);
await bash("sh -c 'git push -f'", pi, true);
await bash("bash -c \"git reset --hard\"", pi, true);
await bash("eval git push -f", pi, true);
await bash("xargs git push -f", pi, true);
await bash("g''it push -f", pi, true);
await bash("git pu''sh -f", pi, true);
await bash("\"git\" push -f", pi, true);
await bash("git\\ status", pi, false);
await bash("git push -\"f\"", pi, true);
await bash("rm -rf .git", pi, true);
await bash("rm -fr .git", pi, true);
await bash("rm -Rf .git", pi, true);
await bash("rm --recursive --force .git", pi, true);
await bash("rm -rf ./.git/", pi, true);
await bash("rm -rf sub/.git", pi, true);
await bash("rm -r -f .git", pi, true);
await bash("rm -rf -- .git", pi, true);
await bash("rm -rf .git/refs", pi, true);
await bash("rm .git/HEAD", pi, true);
await bash("rm -rf .", pi, true);
await bash("rm -Rf .", pi, true);
await bash("rm -rf ./", pi, true);
await bash("rm -rf *", pi, true);
await bash("rm -fR *", pi, true);
await bash("rm -rf .*", pi, true);
await bash("rm -rf .[!.]*", pi, true);
await bash("rm -rf .g*", pi, true);
await bash("rm -rf .git*", pi, true);
await bash("rm -rf ./.git*", pi, true);
await bash("rm -rf ~", pi, true);
await bash("rm -rf /", pi, true);
await bash("rm -rf $HOME", pi, true);
await bash('rm -rf "$PWD"', pi, true);
await bash("rm -rf ${PWD}", pi, true);
await bash("rm -rf $(pwd)", pi, true);
await bash(`rm -rf ${pi}`, pi, true);
await bash(`rm -rf ../${basename(pi)}`, pi, true);
await bash("rm -rf ..", pi, true);
await bash("cd .. && rm -rf " + basename(pi), pi, true);
await bash("cd build && rm -rf ../.git", pi, true);
await bash("mv .git /tmp", pi, true);
await bash("mv .git .git-bak", pi, true);
await bash(`mv ${pi} /tmp/x`, pi, true);
await bash("shred -u .git/index", pi, true);
await bash("rm -rf build", pi, false);
await bash("rm -rf build/*", pi, false);
await bash("rm -rf build/.gitkeep", pi, false);
await bash("rm .gitignore", pi, false);
await bash("rm -rf .github", pi, false);
await bash("rm -rf .gitlab-ci.yml", pi, false);
await bash("rm -rf *.log", pi, false);
await bash("rm -rf ./*.o", pi, false);
await bash("rm -f a.txt", pi, false);
await bash("mv a.txt b.txt", pi, false);
await bash("mv build /tmp/build-old", pi, false);
await bash("find . -name '*.pyc' -delete", pi, false);

console.log("# false positives that must stay allowed on pi/*");
await bash("git commit -m 'doc: never run git reset --hard'", pi, false);
await bash("git commit -am 'note: git push -f is bad'", pi, false);
await bash("grep -r 'git push -f' .", pi, false);
await bash("git log --grep='git push --force'", pi, false);
await bash("echo 'rm -rf .git' > notes.md", pi, false);
await bash("echo \"git reset --hard is dangerous\" >> notes.md", pi, false);
await bash("cat <<'EOF' > doc.md\nnever run git reset --hard\nor rm -rf .git\nEOF", pi, false);
await bash("cat <<EOF > doc.md\nrm -rf .git\nEOF\ngit status", pi, false);
await bash("python3 -c \"print('git push -f')\"", pi, false);
await bash("npm run clean", pi, false);
await bash("make clean", pi, false);
await bash("git push -u origin pi/test", pi, false);
await bash("git log -p -- a.txt", pi, false);
await bash("git diff main...HEAD", pi, false);
await bash("git show HEAD:a.txt > a.txt", pi, false);
await bash("git revert HEAD", pi, false);
await bash("sed -i 's/a/b/' a.txt", pi, false);
await bash("cp a.txt b.txt", pi, false);
await bash("tee out.txt < a.txt", pi, false);
await bash("git ls-files | xargs wc -l", pi, false);
await bash("cd sub 2>/dev/null || true; ls", pi, false);

console.log("# writes aimed at another repo (on main) from a pi/* cwd");
await bash(`cd ${main} && echo x > a.txt`, pi, true);
await bash(`cd "${main}" && echo x > a.txt`, pi, true);
await bash(`pushd ${main}; echo x > a.txt`, pi, true);
await bash(`git -C ${main} commit -am x`, pi, true);
await bash(`git -C "${main}" commit -am x`, pi, true);
await bash(`git --git-dir=${main}/.git --work-tree=${main} commit -am x`, pi, true);
await bash(`GIT_DIR=${main}/.git GIT_WORK_TREE=${main} git commit -am x`, pi, true);
await bash(`cd .. && cd ${basename(main)} && echo x > a.txt`, pi, true);
await bash(`cd -- ../${basename(main)} && echo x > a.txt`, pi, true);
await bash(`cd -P ../${basename(main)} && echo x > a.txt`, pi, true);
await bash(`cd "$(dirname "$PWD")/${basename(main)}" && echo x > a.txt`, pi, true);  // unresolvable cd target: fall back to the lexed $(..) commands
await bash(`echo x > ../${basename(main)}/a.txt`, pi, true);
await bash(`echo x >> ../${basename(main)}/a.txt`, pi, true);
await bash(`cp a.txt ../${basename(main)}/`, pi, true);
await bash(`tee ../${basename(main)}/a.txt < a.txt`, pi, true);
await bash(`sed -i s/m/x/ ../${basename(main)}/m.txt`, pi, true);
await bash(`touch ../${basename(main)}/new.txt`, pi, true);
await bash(`sh -c "cd ${main} && echo x > a.txt"`, pi, true);
await bash(`cat ../${basename(main)}/m.txt`, pi, false);             // reading another repo is fine
await bash(`cd ${pi} && echo x > a.txt`, main, false);               // moved into the pi repo first
await bash(`cd ${pi}; echo x > a.txt`, main, false);
await bash(`cd ${pi} && echo x > ../${basename(main)}/a.txt`, main, true);
await bash("cd $PROJECT && echo x > a.txt", pi, true);               // unresolvable cd: writes refused
await bash("cd $PROJECT && make", pi, false);                        // ... but plain commands run
await bash("cd $(mktemp -d) && git init", pi, true);
await bash("cd $PROJECT && cd /tmp && echo x > a.txt", pi, false);   // resolved again by an absolute cd
await bash(`cd ${plain} && echo x > a.txt`, pi, false);
await bash(`cd ${wt} && echo x > a.txt`, pi, false);
await bash("cd sub && ls", pi, false);
await bash("cd - && ls", pi, false);
await bash("cd && ls", pi, false);

console.log("# operations in progress");
{
	// rebase conflict on pi/test: HEAD detached, but the rebase belongs to pi/test
	const rb = repo("main");
	writeFileSync(join(rb, "f"), "base\n"); git(rb, "add", "f"); git(rb, "commit", "-q", "-m", "base");
	git(rb, "switch", "-q", "-c", "pi/rb"); writeFileSync(join(rb, "f"), "pi\n"); git(rb, "commit", "-qam", "pi");
	git(rb, "switch", "-q", "main"); writeFileSync(join(rb, "f"), "main\n"); git(rb, "commit", "-qam", "main");
	git(rb, "switch", "-q", "pi/rb");
	try { git(rb, "rebase", "main"); } catch { /* conflict expected */ }
	await check("rebase conflict on pi/rb: edit the conflicted file", call("edit", { path: join(rb, "f"), edits: [] }, rb), false);
	await bash("git add f && git rebase --continue", rb, false);
	await bash("git rebase --abort", rb, false);
	await bash("git status", rb, false);
	await bash("git reset --hard", rb, true);
	// rebase conflict on main (detached): blocked, with the op named
	git(rb, "rebase", "--abort");
	git(rb, "switch", "-q", "main");
	try { git(rb, "rebase", "pi/rb"); } catch { /* conflict */ }
	await check("rebase conflict on main: edit blocked", call("edit", { path: join(rb, "f"), edits: [] }, rb), true);
	await bash("git rebase --abort", rb, false);
	await bash("git rebase --continue", rb, false);
	await bash("git switch -c pi/rescue", rb, false);
	await bash("ls", rb, true);
	git(rb, "rebase", "--abort");
	// merge conflict on pi/rb
	git(rb, "switch", "-q", "pi/rb");
	try { git(rb, "merge", "main"); } catch { /* conflict */ }
	await check("merge conflict on pi/rb: edit allowed", call("edit", { path: join(rb, "f"), edits: [] }, rb), false);
	await bash("git merge --abort", rb, false);
	await bash("git merge --continue", rb, false);
	git(rb, "merge", "--abort");
	// bisect on pi/rb
	git(rb, "bisect", "start", "HEAD", "HEAD~1");
	await check("bisect on pi/rb: edit allowed", call("edit", { path: join(rb, "f"), edits: [] }, rb), false);
	await bash("git bisect good", rb, false);
	await bash("git bisect reset", rb, false);
	git(rb, "bisect", "reset");
}

console.log("# detached HEAD");
git(main, "checkout", "-q", "--detach");
await check("write on detached HEAD", call("write", { path: join(main, "a.txt"), content: "x" }, main), true);
await bash("git switch -c pi/from-detached", main, false);
await bash("git checkout main", main, true);   // not a pi/* branch

console.log("# performance");
{
	const t0 = Date.now();
	const big = "echo " + "x".repeat(200_000) + "; git status";
	await bash(big, pi, false);
	const t1 = Date.now();
	await check(`200 KB command judged in ${t1 - t0} ms (< 500)`, Promise.resolve(t1 - t0 < 500 ? undefined : { block: true, reason: "slow" }), false);
	const t2 = Date.now();
	await bash("cd . && ".repeat(5000) + "ls", pi, false);
	const t3 = Date.now();
	await check(`5000 cd chain judged in ${t3 - t2} ms (< 2000)`, Promise.resolve(t3 - t2 < 2000 ? undefined : { block: true, reason: "slow" }), false);
}

console.log(`\n${n} cases, ${fail ? "FAILURES" : "all passed"}`);
rmSync(work, { recursive: true, force: true });
process.exit(fail);
