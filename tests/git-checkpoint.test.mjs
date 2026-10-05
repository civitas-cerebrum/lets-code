#!/usr/bin/env node
// Unit test for the checkpoint part of the git guard extension: after a
// successful edit/write/bash in a pi/* repo, the working tree is snapshotted
// under refs/pi-checkpoints/<branch>/<stamp> without touching index or HEAD.
//
//   tests/git-checkpoint.test.mjs [path/to/lets-code-gitguard.ts]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-gitguard.ts");
process.env.LETS_CODE_GIT_GUARD_ON = "1";
process.env.LETS_CODE_GIT_CHECKPOINT_DEBOUNCE_MS = "50";
process.env.LETS_CODE_GIT_CHECKPOINT_KEEP = "3";

const work = realpathSync(mkdtempSync(join(tmpdir(), "gitcp-test-")));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
writeFileSync(join(work, "gitguard.ts"), src);
const { default: register } = await import(pathToFileURL(join(work, "gitguard.ts")).href);

const handlers = {};
register({ on: (ev, h) => { handlers[ev] = h; return () => {}; } });
for (const ev of ["tool_call", "tool_result", "session_shutdown"]) if (!handlers[ev]) throw new Error(`no ${ev} handler`);

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString();
function repo(branch) {
	const d = mkdtempSync(join(work, "repo-"));
	git(d, "init", "-q", "-b", branch);
	writeFileSync(join(d, "tracked.txt"), "v1\n"); writeFileSync(join(d, ".gitignore"), "ignored.txt\n");
	git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
	return d;
}
const result = (toolName, input, cwd, isError = false) => handlers.tool_result({ type: "tool_result", toolCallId: "x", toolName, input, content: [], isError }, { cwd });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refs = (d) => git(d, "for-each-ref", "--format=%(refname)", "refs/pi-checkpoints/").split("\n").filter(Boolean);

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail = 1; console.log(`${ok ? "ok  " : "FAIL"}  ${name} -> ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`); };

const pi = repo("pi/test");
writeFileSync(join(pi, "tracked.txt"), "v2\n");          // modified
writeFileSync(join(pi, "new.txt"), "new\n");             // untracked
writeFileSync(join(pi, "ignored.txt"), "secret\n");      // ignored
await result("write", { path: join(pi, "new.txt") }, pi);
await sleep(400);
let r = refs(pi);
t("one checkpoint after a write", r.length, 1);
t("ref under the branch namespace", r[0].startsWith("refs/pi-checkpoints/pi/test/"), true);
t("modified file captured", git(pi, "show", `${r[0]}:tracked.txt`), "v2\n");
t("untracked file captured", git(pi, "show", `${r[0]}:new.txt`), "new\n");
t("ignored file not captured", (() => { try { git(pi, "show", `${r[0]}:ignored.txt`); return "captured"; } catch { return "absent"; } })(), "absent");
t("HEAD untouched", git(pi, "log", "--oneline").trim().split("\n").length, 1);
t("index untouched (new.txt still untracked)", git(pi, "status", "--short").includes("?? new.txt"), true);
t("branch untouched", git(pi, "branch", "--show-current").trim(), "pi/test");
t("checkpoint parent is HEAD", git(pi, "rev-parse", `${r[0]}^`).trim(), git(pi, "rev-parse", "HEAD").trim());

await result("bash", { command: "ls" }, pi);             // nothing changed since
await sleep(300);
t("no new checkpoint without changes", refs(pi).length, 1);

writeFileSync(join(pi, "new.txt"), "changed\n");
await result("bash", { command: "ls" }, pi, true);       // failed tool call: ignored
await sleep(300);
t("no checkpoint after a failed call", refs(pi).length, 1);

await result("write", { path: "new.txt" }, pi);          // relative path
await result("write", { path: "new.txt" }, pi);          // debounced into one
await sleep(400);
t("second checkpoint after a change (two calls debounced)", refs(pi).length, 2);

for (let i = 0; i < 3; i++) { writeFileSync(join(pi, "new.txt"), `v${i}\n`); await result("edit", { path: join(pi, "new.txt") }, pi); await sleep(300); }
t("pruned to KEEP=3", refs(pi).length, 3);
t("private index lives in .git", existsSync(join(pi, ".git/lets-code-checkpoint.index")), true);

const main = repo("main");
writeFileSync(join(main, "x.txt"), "x\n");
await result("write", { path: join(main, "x.txt") }, main);
await sleep(300);
t("no checkpoint on a non-pi branch", refs(main).length, 0);

const plain = mkdtempSync(join(work, "plain-"));
await result("write", { path: join(plain, "x.txt") }, plain);
await sleep(300);
t("no crash outside a repo", true, true);

// shutdown flushes a pending (debounced) checkpoint
process.env.LETS_CODE_GIT_CHECKPOINT_DEBOUNCE_MS = "50";
writeFileSync(join(pi, "new.txt"), "final\n");
await result("write", { path: join(pi, "new.txt") }, pi);
await handlers.session_shutdown({ type: "session_shutdown" }, { cwd: pi });
r = refs(pi);
t("shutdown flushed the pending checkpoint", git(pi, "show", `${r[r.length - 1]}:new.txt`), "final\n");

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
rmSync(work, { recursive: true, force: true });
process.exit(fail);
