#!/usr/bin/env node
// Runs after `npm install`. In a checkout of this repository it points git
// at the versioned hooks in .githooks (commit-msg strips AI attribution
// trailers). Anywhere else, such as a global or npx install of the published
// package, there is no repository to configure and this exits at once.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
if (root.includes(`${path.sep}node_modules${path.sep}`)) process.exit(0);
if (!fs.existsSync(path.join(root, ".git"))) process.exit(0);
if (!fs.existsSync(path.join(root, ".githooks", "commit-msg"))) process.exit(0);

const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
if (r.status === 0) console.log("[lets-code] git hooks: core.hooksPath = .githooks");
process.exit(0);
