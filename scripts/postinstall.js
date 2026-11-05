#!/usr/bin/env node
// Runs after `npm install`.
// - On Windows, in an install of the published package (global or local), it
//   points npm's lets-code.cmd and lets-code.ps1 shims at
//   bin/lets-code-windows.js, which runs the script with Git Bash: npm made
//   them from the script's `#!/usr/bin/env bash`, and so they would run
//   whatever bash is on PATH (none, or WSL's). npm links the shims before it
//   runs postinstall, so they are there to rewrite. The sh shim (for Git Bash
//   itself) is left as npm wrote it.
// - In a checkout of this repository it points git at the versioned hooks in
//   .githooks (commit-msg strips AI attribution trailers).
// Anywhere else there is nothing to do and it exits at once.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const installed = root.includes(`${path.sep}node_modules${path.sep}`);

if (installed && process.platform === "win32") {
	const launcher = path.join(root, "bin", "lets-code-windows.js");
	// a global install: <prefix>\node_modules\@civitas-cerebrum\lets-code, shims in <prefix>;
	// a local one: <project>\node_modules\@civitas-cerebrum\lets-code, shims in node_modules\.bin
	const scoped = path.basename(path.dirname(root)).startsWith("@");
	const modules = scoped ? path.dirname(path.dirname(root)) : path.dirname(root);
	for (const dir of [path.dirname(modules), path.join(modules, ".bin")]) {
		const cmd = path.join(dir, "lets-code.cmd");
		let was = "";
		try { was = fs.readFileSync(cmd, "utf8"); } catch { continue; }
		// only npm's shim of this package (or one written here before)
		if (!/@civitas-cerebrum[\\/]lets-code[\\/]/i.test(was)) continue;
		const rel = path.relative(dir, launcher);
		try {
			fs.writeFileSync(cmd, [
				"@ECHO off",
				"REM Written by lets-code's postinstall: lets-code runs in Git Bash, through bin\\lets-code-windows.js.",
				"SETLOCAL",
				'SET "_prog=node"',
				'IF EXIST "%~dp0\\node.exe" SET "_prog=%~dp0\\node.exe"',
				`"%_prog%" "%~dp0\\${rel}" %*`,
				"",
			].join("\r\n"));
			fs.writeFileSync(path.join(dir, "lets-code.ps1"), [
				"#!/usr/bin/env pwsh",
				"# Written by lets-code's postinstall: lets-code runs in Git Bash, through bin\\lets-code-windows.js.",
				"$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent",
				'$node = "node"',
				'if (Test-Path "$basedir/node.exe") { $node = "$basedir/node.exe" }',
				`& $node "$basedir/${rel.replace(/\\/g, "/")}" @args`,
				"exit $LASTEXITCODE",
				"",
			].join("\r\n"));
			console.log(`[lets-code] Windows: ${cmd} runs lets-code with Git Bash`);
		} catch (e) {
			console.log(`[lets-code] Windows: could not rewrite ${cmd} (${e.message}); run lets-code from Git Bash instead`);
		}
	}
	process.exit(0);
}

if (installed) process.exit(0);
if (!fs.existsSync(path.join(root, ".git"))) process.exit(0);
if (!fs.existsSync(path.join(root, ".githooks", "commit-msg"))) process.exit(0);

const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
if (r.status === 0) console.log("[lets-code] git hooks: core.hooksPath = .githooks");
process.exit(0);
