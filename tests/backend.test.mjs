#!/usr/bin/env node
// Unit test for the backend facts extension that lets-code writes
// (~/.pi/agent/extensions/lets-code/backend.ts). Loads it with a fake pi and
// drives before_agent_start and tool_result. Needs Node >= 22.6.
//
//   tests/backend.test.mjs [path/to/lets-code/backend.ts]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/backend.ts");
const work = mkdtempSync(join(tmpdir(), "backend-test-"));
const src = readFileSync(extPath, "utf8").replace(/^import type .*$/m, "");
let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail = 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } else console.log(`ok    ${name}`); };

const B = { server: "vllm", url: "https://vllm.example", api_base: "https://vllm.example/v1", api: "openai-completions", model: "qwen3.8-27b", model_source: "auto",
	context: 262144, output_cap: 32768, thinking: "medium", reasoning: true, vision: true, provider: "lets-code" };
let loads = 0;
async function load(backend) {
	if (backend === undefined) delete process.env.LETS_CODE_BACKEND; else process.env.LETS_CODE_BACKEND = typeof backend === "string" ? backend : JSON.stringify(backend);
	const f = join(work, `backend-${loads++}.ts`); writeFileSync(f, src);
	const mod = await import(pathToFileURL(f).href);
	const handlers = {};
	mod.default({ on(ev, h) { handlers[ev] = h; } });
	const prompt = async (p) => { const sections = { other: "kept" }; await handlers.before_agent_start?.({ prompt: p, systemPromptOptions: { sections } }); return sections; };
	const bash = async (command) => handlers.tool_result?.({ toolName: "bash", input: { command }, content: [{ type: "text", text: "out" }] });
	return { mod, handlers, prompt, bash };
}

try {
	let x = await load(undefined);
	t("outside lets-code: nothing registered", Object.keys(x.handlers), []);
	x = await load("not json");
	t("bad value: nothing registered", Object.keys(x.handlers), []);

	x = await load(B);
	const f = x.mod.facts(B);
	t("facts: model, server, url", /qwen3\.8-27b \(discovered from the server\), served by vllm at https:\/\/vllm\.example/.test(f), true);
	t("facts: api and auth by variable", /openai-completions API at https:\/\/vllm\.example\/v1; auth header: Authorization: Bearer \$LETS_CODE_TOKEN/.test(f), true);
	t("facts: context, cap, thinking, vision", /Context 262k tokens, output cap 33k, thinking medium, vision yes/.test(f), true);
	t("facts: vllm metrics endpoint", /GET https:\/\/vllm\.example\/metrics/.test(f), true);
	t("facts stay short (about 120 tokens)", f.length < 600, true);
	t("facts: no thinking support said plainly", /thinking not supported/.test(x.mod.facts({ ...B, reasoning: false })), true);

	// nothing by default
	t("plain prompt: nothing added", Object.keys(await x.prompt("fix the failing test in parser.py")), ["other"]);
	t("unrelated command: result untouched", await x.bash("pytest -q"), undefined);

	// asked for: the section, kept for the session; then no appending
	for (const p of ["which model are you running on?", "is the LLM backend down", "is the vLLM server slow today", "what's the context window", "check the model endpoint", "how many tok/s do we get", "is the GPU busy"])
		t(`trigger: "${p}"`, x.mod.asksAboutBackend(p), true);
	for (const p of ["add an endpoint `/users` to the API", "explain:\n```\ncurl /v1/models\n```", "rename the model class", "fix the backend's login form"])
		t(`no trigger: "${p.replace(/\n/g, " ")}"`, x.mod.asksAboutBackend(p), false);
	t("asked: section added", (await x.prompt("which model is this?")).lets_code_backend === f, true);
	t("kept for the session", "lets_code_backend" in (await x.prompt("now fix the typo")), true);
	t("asked: probing commands are not appended to", await x.bash("curl -s $BASE/v1/models"), undefined);

	// probed: appended once, never as a section
	x = await load(B);
	for (const c of ["curl -s https://x/v1/models", "env | grep LETS_CODE_", "nvidia-smi", "ps aux | grep vllm", "cat ~/.pi/agent/models.json", "curl -s $U/metrics | grep kv"])
		t(`probe: ${c}`, x.mod.probesBackend(c), true);
	t("not a probe: ls", x.mod.probesBackend("ls -la src"), false);
	const r = await x.bash("curl -s https://vllm.example/v1/models");
	t("probe: facts appended to its result", [r.content.length, r.content[0].text, r.content[1].text.startsWith("\n[lets-code] Backend")], [2, "out", true]);
	t("only once", await x.bash("nvidia-smi"), undefined);
	t("and no section after that", "lets_code_backend" in (await x.prompt("which model is this?")), false);
	t("other tools untouched", await x.handlers.tool_result({ toolName: "read", input: { path: "models.json" }, content: [] }), undefined);
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(fail);
