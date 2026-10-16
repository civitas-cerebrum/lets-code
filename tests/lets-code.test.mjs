#!/usr/bin/env node
// Unit test for the index of the one pi extension lets-code writes
// (~/.pi/agent/extensions/lets-code/index.ts), which loads each feature
// module next to it. With fake modules in a scratch copy: each present
// module (<feature>.ts or <feature>/index.ts, sync or async) loads once, in
// order; one that throws on import or in setup is reported by name, with a
// UI and without, and the others still load; missing ones are skipped.
// Needs Node >= 22.6.
//
//   tests/lets-code.test.mjs [path/to/lets-code/index.ts]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/index.ts");
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

const work = mkdtempSync(join(tmpdir(), "lets-code-index-test-"));
let n = 0;
// a scratch extension dir: the index plus the given modules ({ path: source })
async function load(modules, ui) {
	const dir = join(work, `ext-${n++}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.ts"), src);
	for (const [p, body] of Object.entries(modules)) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		writeFileSync(join(dir, p), body);
	}
	globalThis.__loaded = [];
	const handlers = {};
	const pi = { on(ev, h) { (handlers[ev] ??= []).push(h); } };
	const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
	await mod.default(pi);
	const notes = [], errs = [];
	const origErr = console.error;
	console.error = (m) => errs.push(String(m));
	try {
		for (const h of handlers.session_start ?? []) await h({}, ui ? { hasUI: true, ui: { notify: (m, k) => notes.push([m, k]) } } : { hasUI: false });
	} finally { console.error = origErr; }
	return { mod, loaded: globalThis.__loaded, handlers, notes, errs };
}
const ok = (name) => `export default function (pi) { globalThis.__loaded.push(${JSON.stringify(name)}); pi.on("x-${name}", () => {}); }\n`;

{
	const r = await load({ "footer.ts": ok("footer"), "agent-guard.ts": ok("agent-guard"), "subagents.ts": ok("subagents"),
		"sandbox/index.ts": `export default async function (pi) { await new Promise((r) => setTimeout(r, 5)); globalThis.__loaded.push("sandbox"); }\n`,
		"grounding.ts": `export default function (pi) { globalThis.__loaded.push("grounding"); throw new Error("setup broke"); }\n`,
		"mandate.ts": `import "./no-such-module.ts";\nexport default function () { globalThis.__loaded.push("mandate"); }\n`,
		"unknown.ts": ok("unknown") }, true);
	t("present modules load once each, in order (async waited for)", r.loaded, ["agent-guard", "footer", "grounding", "sandbox", "subagents"]);
	t("each module got the real pi", Object.keys(r.handlers).filter((k) => k.startsWith("x-")).sort(), ["x-agent-guard", "x-footer", "x-subagents"]);
	t("one notification with a UI", r.notes.length, 1);
	t("  as an error", r.notes[0]?.[1], "error");
	t("  naming the setup that threw", /grounding \(setup broke\)/.test(r.notes[0]?.[0] ?? ""), true);
	t("  naming the module that failed to import", /mandate \(/.test(r.notes[0]?.[0] ?? ""), true);
	t("  and not the ones that loaded", /footer|sandbox|agent-guard/.test(r.notes[0]?.[0] ?? ""), false);
	t("nothing on stderr with a UI", r.errs, []);
	t("a file that is not a feature is not loaded", r.loaded.includes("unknown"), false);
	t("the feature list", r.mod.FEATURES, ["agent-guard", "backend", "claude-code", "footer", "git-guard", "grounding", "mandate", "memory-guard", "sandbox", "session-tag", "experts", "subagents", "thinking"]);
}
{
	const r = await load({ "backend.ts": `export default function () { throw "plain"; }\n`, "session-tag.ts": ok("session-tag") }, false);
	t("without a UI: the failure goes to stderr", r.errs.length === 1 && /backend \(plain\)/.test(r.errs[0]), true);
	t("without a UI: the others still load", r.loaded, ["session-tag"]);
}
{
	const r = await load({ "git-guard.ts": `export const x = 1;\n`, "memory-guard.ts": ok("memory-guard") }, true);
	t("a module without a default function is reported", /git-guard \(no default export function\)/.test(r.notes[0]?.[0] ?? ""), true);
	t("  and the rest load", r.loaded, ["memory-guard"]);
}
{
	const r = await load({}, true);
	t("no modules: nothing loads, nothing reported", [r.loaded, r.notes, r.handlers.session_start], [[], [], undefined]);
}
{
	const r = await load({ "footer.ts": ok("footer"), "footer/index.ts": ok("footer-dir") }, true);
	t("<feature>.ts wins over <feature>/index.ts", r.loaded, ["footer"]);
}

rmSync(work, { recursive: true, force: true });
process.exit(fail);
