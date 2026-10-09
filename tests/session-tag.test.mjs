#!/usr/bin/env node
// Unit test for the session tag extension that lets-code writes
// (~/.pi/agent/extensions/lets-code-sessiontag.ts). Loads it with a fake pi
// and drives before_provider_headers. Needs Node >= 22.6.
//
//   tests/session-tag.test.mjs [path/to/lets-code-sessiontag.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code-sessiontag.ts");
const work = mkdtempSync(join(tmpdir(), "session-tag-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");

let fail = 0, n = 0;
const t = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

let loads = 0;
async function load(env) {
	for (const k of ["LETS_CODE_SESSION_ID", "LETS_CODE_SUBAGENT_DEPTH"]) delete process.env[k];
	Object.assign(process.env, env);
	const f = join(work, `sessiontag-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {};
	mod.default({ on(ev, h) { handlers[ev] = h; } });
	const send = (headers) => { handlers.before_provider_headers?.({ type: "before_provider_headers", headers }, {}); return headers; };
	return { mod, handlers, send };
}

try {
	// inert without an id
	let x = await load({});
	t("no id: no handler", Object.keys(x.handlers), []);

	// main session
	x = await load({ LETS_CODE_SESSION_ID: "Mac:lets-code:3f9a1c" });
	let h = x.send({ "User-Agent": "pi (darwin 25.6.0; arm64)", Authorization: "Bearer k" });
	t("header set", h["X-Lets-Code-Session"], "Mac:lets-code:3f9a1c");
	t("UA appended", h["User-Agent"], "pi (darwin 25.6.0; arm64) lets-code/Mac:lets-code:3f9a1c");
	t("other headers kept", h.Authorization, "Bearer k");
	t("idempotent", x.send({ ...h })["User-Agent"], h["User-Agent"]);
	h = x.send({ "user-agent": "custom/1" });
	t("lowercase UA replaced by one key", [h["user-agent"], h["User-Agent"]], [undefined, "custom/1 lets-code/Mac:lets-code:3f9a1c"]);
	h = x.send({});
	t("no UA: pi default + tag", /^pi \(.+\) lets-code\/Mac:lets-code:3f9a1c$/.test(h["User-Agent"]), true);

	// subagent
	t("subagent tag", x.mod.sessionTag({ LETS_CODE_SESSION_ID: "Mac:p:ab", LETS_CODE_SUBAGENT_DEPTH: "1" }, 4242), "Mac:p:ab/sub1.4242");
	t("depth 0 = main", x.mod.sessionTag({ LETS_CODE_SESSION_ID: "Mac:p:ab", LETS_CODE_SUBAGENT_DEPTH: "0" }, 4242), "Mac:p:ab");
	// header-safe: no CR/LF/spaces survive
	t("sanitised", x.mod.sessionTag({ LETS_CODE_SESSION_ID: "a b\r\nX-Evil: 1" }), "abX-Evil:1");
	t("empty after cleaning = off", x.mod.sessionTag({ LETS_CODE_SESSION_ID: " \n" }), "");
} finally { rmSync(work, { recursive: true, force: true }); }

console.log(`\n${n} checks, ${fail ? "FAILURES" : "all passed"}`);
process.exit(fail);
