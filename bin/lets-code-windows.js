#!/usr/bin/env node
// lets-code on Windows: what `lets-code` runs from cmd, PowerShell or Windows
// Terminal. npm's lets-code.cmd and lets-code.ps1 shims would run the script
// with whatever `bash` is on PATH: often none, or WSL's System32\bash.exe,
// which cannot see this install. scripts/postinstall.js points those shims
// here instead, and this runs the script with Git Bash, found the way pi finds
// it (pi's settings.json shellPath, then Git for Windows, then a bash.exe on
// PATH that is not WSL's). In Git Bash itself npm's sh shim runs the script
// directly, as on Linux and macOS.
//
// `lets-code update` of this npm install is done here, by npm itself: the
// script cannot replace its own package while Git Bash holds it open.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function isFile(f) {
	try { return fs.statSync(f).isFile(); } catch { return false; }
}

function findBash() {
	const env = process.env, c = [];
	try {
		const dir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
		const s = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
		if (s && typeof s.shellPath === "string" && s.shellPath) c.push(s.shellPath);
	} catch {}
	for (const v of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) if (env[v]) c.push(path.join(env[v], "Git", "bin", "bash.exe"));
	if (env.LOCALAPPDATA) c.push(path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
	// git.exe on PATH is ...\Git\cmd\git.exe: its bash is ...\Git\bin\bash.exe
	for (const name of ["git.exe", "bash.exe"]) {
		const r = spawnSync("where", [name], { encoding: "utf8", windowsHide: true });
		for (const l of String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
			if (/\\(system32|windowsapps)\\/i.test(l)) continue;
			c.push(name === "git.exe" ? path.join(path.dirname(path.dirname(l)), "bin", "bash.exe") : l);
		}
	}
	return c.find(isFile);
}

const script = path.join(__dirname, "..", "lets-code");
const args = process.argv.slice(2);

if (args[0] === "update" && process.platform === "win32") {
	if (args.length > 2 || (args[1] && args[1] !== "--snapshot")) {
		console.error("[lets-code] ERROR: usage: lets-code update [--snapshot]");
		process.exit(1);
	}
	const spec = args[1] === "--snapshot" ? "github:civitas-cerebrum/lets-code" : "@civitas-cerebrum/lets-code@latest";
	// the postinstall points the new shims back here; npm 12 runs it only when allowed
	const cmd = `npm install -g --allow-scripts=@civitas-cerebrum/lets-code ${spec}`;
	console.log(`[lets-code] installed by npm — running: ${cmd}`);
	// npm is npm.cmd: only a shell runs it; the command is ours, nothing to quote
	const r = spawnSync(cmd, { stdio: "inherit", shell: true });
	if (r.status !== 0) {
		console.error("[lets-code] ERROR: npm install failed — see the npm output above.");
		process.exit(1);
	}
	process.exit(0);
}

const bash = findBash();
if (!bash) {
	console.error("[lets-code] ERROR: Git Bash not found. lets-code (like pi) runs in Git Bash on Windows:");
	console.error("[lets-code]   install Git for Windows (winget install Git.Git, or https://git-scm.com/download/win),");
	console.error('[lets-code]   or name your bash in ~/.pi/agent/settings.json as "shellPath".');
	process.exit(1);
}

// MSYS=noglob: Git Bash would expand a * in an argument (`lets-code -p "fix
// *.ts"`) as cmd.exe does not; the arguments reach lets-code as typed.
const msys = (process.env.MSYS || "").split(/\s+/).filter(Boolean);
if (!msys.includes("noglob")) msys.push("noglob");
const env = { ...process.env, MSYS: msys.join(" ") };

// Ctrl+C reaches every program in the console; lets-code and pi handle it,
// and this launcher waits for them instead of dying first.
process.on("SIGINT", () => {});
process.on("SIGBREAK", () => {});
const r = spawnSync(bash, [script.replace(/\\/g, "/"), ...args], { stdio: "inherit", env });
if (r.error) {
	console.error(`[lets-code] ERROR: could not run ${bash}: ${r.error.message}`);
	process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
