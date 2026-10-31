#!/usr/bin/env node
// Unit test for the platform helpers lets-code appends to its modules
// (lc_ts_platform in ./lets-code: lcwNative, lcwKey, lcwCommand, ...). The
// block is cut out of the script by its TS terminator (it has lines that
// start with "}"), written to a scratch .mjs with its functions exported,
// and run on this platform; the pure ones also with process.platform faked
// as win32, so their Windows side is checked on Linux and macOS too.
//
//   tests/platform.test.mjs [path/to/lets-code]
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "lets-code");
const s = readFileSync(script, "utf8");
const at = s.indexOf("\nlc_ts_platform() {");
const open = at < 0 ? -1 : s.indexOf("cat <<'TS'\n", at);
const end = open < 0 ? -1 : s.indexOf("\nTS\n", open);
if (end < 0) { console.log("FAIL  no lc_ts_platform block in " + script); process.exit(1); }
const block = s.slice(open + "cat <<'TS'\n".length, end + 1);
const names = [...block.matchAll(/^function (lcw\w+)\(/gm)].map((m) => m[1]);

const work = mkdtempSync(join(tmpdir(), "platform-test-"));
const modFile = join(work, "platform.mjs");
writeFileSync(modFile, block + `\nexport { ${names.join(", ")} };\n`);
const P = await import(pathToFileURL(modFile).href);

let fail = 0;
const t = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { fail = 1; console.log(`FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`);
};

const realWin = process.platform === "win32";
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const asWin = (f) => {
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	try { return f(); } finally { Object.defineProperty(process, "platform", platform); }
};
const asPosix = (f) => {
	Object.defineProperty(process, "platform", { ...platform, value: "linux" });
	try { return f(); } finally { Object.defineProperty(process, "platform", platform); }
};

try {
	t("helpers found", ["lcwIsWin", "lcwNative", "lcwPosix", "lcwKey", "lcwUnder", "lcwProg", "lcwSocket", "lcwCommand"].every((n) => names.includes(n)), true);
	t("lcwIsWin follows process.platform", [asWin(() => P.lcwIsWin()), asPosix(() => P.lcwIsWin()), P.lcwIsWin()], [true, false, realWin]);

	// ---- off Windows: everything as it was
	asPosix(() => {
		t("posix: lcwNative leaves paths", ["/c/Users/x", "/tmp/a", "~/b", "C:\\x"].map(P.lcwNative), ["/c/Users/x", "/tmp/a", "~/b", "C:\\x"]);
		t("posix: lcwPosix leaves backslashes", P.lcwPosix("a\\b"), "a\\b");
		t("posix: lcwKey keeps case", P.lcwKey("/A/B"), "/A/B");
		t("posix: lcwUnder", [P.lcwUnder("/a/b", "/a"), P.lcwUnder("/a", "/a/"), P.lcwUnder("/ab", "/a"), P.lcwUnder("/A/b", "/a")], [true, true, false, false]);
		t("posix: lcwSocket is the path", P.lcwSocket("/run/x.sock"), "/run/x.sock");
		t("posix: lcwCommand is the name", P.lcwCommand("npm"), ["npm"]);
		t("posix: lcwBash is bash", P.lcwBash(), "bash");
		t("posix: lcwSpawnOpts keeps detached", P.lcwSpawnOpts({ detached: true }), { windowsHide: true, detached: true });
		if (typeof process.getuid === "function") {
			t("posix: lcwPrivateDir 0700 mine", P.lcwPrivateDir({ mode: 0o40700, uid: process.getuid() }), true);
			t("posix: lcwPrivateDir 0777", P.lcwPrivateDir({ mode: 0o40777, uid: process.getuid() }), false);
			t("posix: lcwPrivateDir another owner", P.lcwPrivateDir({ mode: 0o40700, uid: process.getuid() + 1 }), false);
		}
	});

	// ---- Windows (faked here unless this is Windows): the pure helpers
	asWin(() => {
		t("win: /c/Users/x -> C:\\Users\\x", P.lcwNative("/c/Users/x"), "C:\\Users\\x");
		t("win: /d -> D:\\", P.lcwNative("/d"), "D:\\");
		t("win: /tmp/a -> under the temp dir", P.lcwNative("/tmp/a"), join(tmpdir(), "/a"));
		t("win: ~/b -> under the home dir", P.lcwNative("~/b"), join(homedir(), "/b"));
		t("win: ~ alone", P.lcwNative("~"), join(homedir(), ""));
		t("win: relative, native, UNC and non-strings left", [P.lcwNative("a/b"), P.lcwNative("C:\\x"), P.lcwNative("//srv/share"), P.lcwNative(""), P.lcwNative(undefined)], ["a/b", "C:\\x", "//srv/share", "", undefined]);
		// /usr/x: under Git's root, from the bash found (set here, as found once)
		const had = Object.prototype.hasOwnProperty.call(globalThis, "__lcwBash"), was = globalThis.__lcwBash;
		const root = realWin ? "C:\\Git" : "/opt/Git";
		globalThis.__lcwBash = realWin ? "C:\\Git\\usr\\bin\\bash.exe" : "/opt/Git/usr/bin/bash.exe";
		try {
			t("win: Git's root from bin\\bash.exe or usr\\bin\\bash.exe", P.lcwGitRoot(), root);
			t("win: /usr/bin/x -> under Git's root", P.lcwNative("/usr/bin/x"), join(root, "/usr/bin/x"));
			globalThis.__lcwBash = "bash.exe";
			t("win: no root without an absolute bash", [P.lcwGitRoot(), P.lcwNative("/usr/bin/x")], ["", "/usr/bin/x"]);
		} finally { if (had) globalThis.__lcwBash = was; else delete globalThis.__lcwBash; }

		t("win: lcwPosix", P.lcwPosix("C:\\Users\\x\\a b"), "C:/Users/x/a b");
		t("win: lcwKey folds case and separators", P.lcwKey("C:/Users/X\\Repo"), "c:\\users\\x\\repo");
		t("win: lcwSamePath", [P.lcwSamePath("C:\\A\\b", "c:/a/B"), P.lcwSamePath("C:\\A", "C:\\B")], [true, false]);
		t("win: lcwUnder", [P.lcwUnder("C:\\A\\b", "c:/a"), P.lcwUnder("C:\\A", "C:\\A\\"), P.lcwUnder("C:\\Ab", "C:\\A"), P.lcwUnder("c:/a/b/c", "C:\\A\\B")], [true, true, false, true]);
		// (forward slashes: node's path.basename off Windows splits only at /)
		const sk = P.lcwSocket("C:/Users/x/.pi/agent/lets-code-sessions/bus sock");
		t("win: lcwSocket is a named pipe", /^\\\\\.\\pipe\\lets-code-[0-9a-f]+-bus_sock$/.test(sk), true);
		t("win: lcwSocket by path key (case)", P.lcwSocket("c:/USERS/X/.pi/agent/lets-code-sessions/bus sock"), sk);
		t("win: lcwSocket differs per path", P.lcwSocket("C:/other/bus sock") !== sk, true);
		t("win: lcwSpawnOpts drops detached", P.lcwSpawnOpts({ detached: true, cwd: "x" }), { windowsHide: true, cwd: "x" });
		t("win: lcwPrivateDir (no mode bits there)", P.lcwPrivateDir({ mode: 0o40777, uid: 12345 }), true);

		// lcwCommand with a full path (no `where` to fake): an npm .cmd shim
		// runs as node and its script; another .cmd through cmd.exe; an .exe as is
		const bin = join(work, "npm-bin"); mkdirSync(bin);
		const shim = join(bin, "pi.cmd");
		writeFileSync(shim, [
			"@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
			'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
			'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*', "",
		].join("\r\n"));
		t("win: lcwCommand(npm .cmd shim) -> node + its script", P.lcwCommand(shim), [process.execPath, join(bin, "node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js")]);
		const other = join(bin, "tool.bat");
		writeFileSync(other, "@echo off\r\necho hi\r\n");
		t("win: lcwCommand(other .bat) -> cmd.exe", P.lcwCommand(other), [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", other]);
		const exe = join(bin, "tool.exe");
		t("win: lcwCommand(.exe path) as is", P.lcwCommand(exe), [exe]);
		t("lcwPi: LETS_CODE_PI as a JSON array", (() => { process.env.LETS_CODE_PI = '["node","/x/cli.js"]'; try { return P.lcwPi(); } finally { delete process.env.LETS_CODE_PI; } })(), ["node", "/x/cli.js"]);
		t("lcwPi: LETS_CODE_PI as a path", (() => { process.env.LETS_CODE_PI = "C:\\pi\\pi.exe"; try { return P.lcwPi(); } finally { delete process.env.LETS_CODE_PI; } })(), ["C:\\pi\\pi.exe"]);
	});

	// ---- not platform dependent
	t("lcwProg", ["C:\\Git\\usr\\bin\\bash.exe", "git.EXE", "/usr/bin/env", "npm.cmd", "x.Bat", "node"].map(P.lcwProg), ["bash", "git", "env", "npm", "x", "node"]);

	// ---- on this platform, for real
	t("lcwHome", P.lcwHome(), realWin ? homedir() : (process.env.HOME || homedir()));
	const b = P.lcwBash();
	t("lcwBash: bash, or an existing bash.exe on Windows", realWin ? (b === "bash.exe" || (existsSync(b) && statSync(b).isFile())) : b === "bash", true);
	const a = join(work, "a"), z = join(work, "z");
	writeFileSync(a, "new"); writeFileSync(z, "old");
	P.lcwRename(a, z);
	t("lcwRename replaces", [readFileSync(z, "utf8"), existsSync(a)], ["new", false]);
	// lcwKillTree stops a child and what it started
	const kid = spawn(process.execPath, ["-e", "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)"], P.lcwSpawnOpts({ detached: true, stdio: "ignore" }));
	await new Promise((r) => setTimeout(r, 500));
	const gone = new Promise((r) => kid.on("exit", () => r(true)));
	P.lcwKillTree(kid.pid);
	t("lcwKillTree stops the child", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 10000))]), true);
	P.lcwKillTree(0);   // no pid: nothing
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
