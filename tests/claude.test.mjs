#!/usr/bin/env node
// Unit test for the claude module that lets-code writes
// (~/.pi/agent/extensions/lets-code/claude/index.ts) and the proxy next to it
// (server.mjs, bridge.mjs). Starts the proxy through the module's
// ensureProxy() with a fake `claude` that speaks stream-json, runs the MCP
// bridge like the real CLI and records what it is asked. Needs Node >= 22.6.
//
//   tests/claude.test.mjs [path/to/lets-code/claude/index.ts]
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:net";
import http from "node:http";
import { pathToFileURL } from "node:url";

const extPath = process.argv[2] ?? join(homedir(), ".pi/agent/extensions/lets-code/claude/index.ts");
const work = mkdtempSync(join(tmpdir(), "claude-test-"));
const log = join(work, "claude.log");
let failed = 0;
const t = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : ` -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
	if (!ok) failed = 1;
};
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const records = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// fake claude: stream-json in and out, MCP client of the bridge
const fake = join(work, "claude");
writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs"); const cp = require("child_process"); const rl = require("readline");
const argv = process.argv.slice(2); const arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
let model = arg("--model"); const effort = arg("--effort");
const rec = (o) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...o }) + "\\n");
rec({ event: "start", model, effort, thinkingOff: process.env.CLAUDE_CODE_DISABLE_THINKING === "1", display: arg("--thinking-display"), token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ev = (e) => out({ type: "stream_event", event: e });
const srv = JSON.parse(fs.readFileSync(arg("--mcp-config"), "utf8")).mcpServers.pi;
const mcp = cp.spawn(srv.command, srv.args, { stdio: ["pipe", "pipe", "inherit"] });
let rid = 0; const waits = new Map();
rl.createInterface({ input: mcp.stdout }).on("line", (l) => { const m = JSON.parse(l); waits.get(m.id)?.(m.result); waits.delete(m.id); });
const call = (method, params) => new Promise((r) => { const id = ++rid; waits.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
const ready = call("initialize", { protocolVersion: "2025-06-18" }).then(() => call("tools/list", {}));
const text = (s) => { ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }); ev({ type: "content_block_stop", index: 0 }); };
const end = (stop) => { ev({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } }); ev({ type: "message_stop" }); };
let queue = Promise.resolve();
rl.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); queue = queue.then(() => handle(m)); });
async function handle(m) {
  if (m.type === "control_request") {
    rec({ event: "control", request: m.request });
    if (m.request.subtype === "set_model") model = m.request.model;
    return out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
  }
  const said = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  rec({ event: "user", text: said, model });
  const { tools } = await ready;
  ev({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } } });
  if (said.includes("use tool") && tools.length) {
    const id = "toolu_" + Date.now();
    ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__pi__" + tools[0].name, input: {} } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x": 1}' } });
    ev({ type: "content_block_stop", index: 0 }); end("tool_use");
    const r = await call("tools/call", { name: tools[0].name, arguments: { x: 1 }, _meta: { "claudecode/toolUseId": id } });
    ev({ type: "message_start", message: { usage: { input_tokens: 20 } } });
    text("tool said: " + r.content.map((c) => c.text).join("")); end("end_turn");
  } else {
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
    ev({ type: "content_block_stop", index: 0 });
    text("echo[" + model + "]: " + said.slice(-40)); end("end_turn");
  }
  out({ type: "result", subtype: "success", is_error: false });
}
`);
chmodSync(fake, 0o755);

const port = await freePort();
const env = {
	...process.env,
	LETS_CODE_CLAUDE_PORT: String(port),
	LETS_CODE_CLAUDE_STATE: join(work, "state"),
	CLAUDE_BIN: fake,
	FAKE_CLAUDE_LOG: log,
};
Object.assign(process.env, env);
const mod = await import(pathToFileURL(extPath).href);
const base = `http://127.0.0.1:${port}`;
const pids = new Set();

// a chat request; returns { content, reasoning, toolCalls, finish }
async function chat(body, headers = {}) {
	const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ stream: true, ...body }) });
	const res = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
	for (const line of (await r.text()).split("\n")) {
		if (!line.startsWith("data: {")) continue;
		const chunk = JSON.parse(line.slice(6));
		if (chunk.usage) res.usage = chunk.usage;
		const c = chunk.choices?.[0];
		if (!c) continue;
		res.content += c.delta?.content ?? "";
		res.reasoning += c.delta?.reasoning_content ?? "";
		for (const tc of c.delta?.tool_calls ?? []) res.toolCalls.push(tc);
		res.finish = c.finish_reason ?? res.finish;
	}
	return res;
}

try {
	t("ensureProxy starts the proxy", await mod.ensureProxy(env), "");
	const h1 = await mod.health(port);
	t("it runs this module's server.mjs", h1?.version, mod.proxyVersion());
	t("a second ensureProxy leaves it running", [await mod.ensureProxy(env), (await mod.health(port))?.pid], ["", h1?.pid]);
	const models = await (await fetch(`${base}/v1/models`)).json();
	t("/v1/models", models.data.map((m) => m.id), ["claude-haiku", "claude-sonnet", "claude-opus", "claude-fable"]);

	// a conversation: first turn, then a follow-up on another model and effort
	const conv = [{ role: "system", content: "sys A" }, { role: "user", content: "hello" }];
	let r = await chat({ model: "claude-haiku", reasoning_effort: "low", messages: conv });
	t("first turn: answer", [r.content, r.reasoning, r.finish], ["echo[haiku]: hello", "hmm", "stop"]);
	t("usage: cache reads and writes reported apart (pi prices them)", [r.usage?.prompt_tokens, r.usage?.prompt_tokens_details], [350, { cached_tokens: 300, cache_write_tokens: 40 }]);
	let starts = records().filter((x) => x.event === "start");
	t("first turn: claude launched with Haiku, effort low, summaries", starts.map((s) => [s.model, s.effort, s.thinkingOff, s.display]), [["haiku", "low", false, "summarized"]]);
	const first = r;
	conv.push({ role: "assistant", content: r.content }, { role: "user", content: "again" });
	r = await chat({ model: "claude-sonnet", reasoning_effort: "high", messages: conv });
	t("follow-up on Sonnet, effort high: answer", r.content, "echo[sonnet]: again");
	const second = r.content;
	const recs = records();
	t("follow-up: same process", recs.filter((x) => x.event === "start").length, 1);
	t("follow-up: switched like /model and /effort", recs.filter((x) => x.event === "control").map((x) => x.request),
		[{ subtype: "set_model", model: "sonnet" }, { subtype: "apply_flag_settings", settings: { effortLevel: "high" } }]);

	// after a model switch pi sends earlier assistant turns again with their
	// thinking folded into the text: still the same conversation
	conv[2] = { role: "assistant", content: `${first.reasoning}\n\n${first.content}` };
	conv.push({ role: "assistant", content: second }, { role: "user", content: "once more" });
	r = await chat({ model: "claude-sonnet", reasoning_effort: "high", messages: conv });
	t("earlier turn re-sent with its thinking folded in: same process", [r.content, records().filter((x) => x.event === "start").length], ["echo[sonnet]: once more", 1]);
	const third = r.content;

	// pi's tools: a tool call goes to pi, its result back into the same process
	const tools = [{ type: "function", function: { name: "lookup", description: "d", parameters: { type: "object", properties: { x: { type: "number" } } } } }];
	const conv2 = [{ role: "system", content: "sys B" }, { role: "user", content: "use tool please" }];
	r = await chat({ model: "claude-haiku", messages: conv2, tools });
	const tc = r.toolCalls[0];
	t("tool call reaches pi", [r.finish, tc?.function?.name, tc?.function?.arguments, tc?.id?.startsWith("toolu_")], ["tool_calls", "lookup", '{"x": 1}', true]);
	conv2.push({ role: "assistant", content: "", tool_calls: [{ id: tc.id, type: "function", function: tc.function }] }, { role: "tool", tool_call_id: tc.id, content: "42" });
	r = await chat({ model: "claude-haiku", messages: conv2, tools });
	t("tool result goes back to Claude", [r.content, r.finish], ["tool said: 42", "stop"]);

	// thinking off is a launch setting: a new process, the conversation replayed
	conv.push({ role: "assistant", content: third }, { role: "user", content: "quiet now" });
	r = await chat({ model: "claude-sonnet", reasoning_effort: "none", messages: conv });
	starts = records().filter((x) => x.event === "start");
	t("thinking off: a new claude with thinking off at effort low", starts.slice(-1).map((s) => [s.model, s.effort, s.thinkingOff]), [["sonnet", "low", true]]);
	t("thinking off: earlier turns replayed", records().filter((x) => x.event === "user").slice(-1)[0].text.includes("<conversation>"), true);

	// other machines (CLAUDE_URL) come through a reverse proxy and send their
	// user's Claude Code token; their conversations run on it, one process per token
	const T1 = "sk-ant-oat01-" + "a".repeat(40), T2 = "sk-ant-oat01-" + "b".repeat(40);
	const fwd = (tok) => ({ "X-Forwarded-For": "10.6.0.2", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) });
	const via = (tok) => fetch(`${base}/health`, { headers: fwd(tok) }).then((r) => r.status);
	t("through a reverse proxy: no token, junk or an API key refused; a Claude Code token let in",
		[await via(""), await via("nope"), await via("sk-ant-api03-" + "x".repeat(40)), await via(T1)], [401, 401, 401, 200]);
	t("directly (this machine): no token needed", (await fetch(`${base}/health`)).status, 200);
	const rconv = [{ role: "system", content: "sys R" }, { role: "user", content: "hi from afar" }];
	r = await chat({ model: "claude-haiku", messages: rconv }, fwd(T1));
	t("remote turn: answered", r.content, "echo[haiku]: hi from afar");
	r = await chat({ model: "claude-haiku", messages: rconv }, fwd(T2));
	const tokStarts = records().filter((x) => x.event === "start").map((x) => x.token);
	t("remote turns run on the caller's token, one process each", tokStarts.slice(-2), [T1, T2]);
	t("local sessions without a token run on this machine's login", tokStarts.slice(0, -2).every((x) => x === null), true);
	r = await chat({ model: "claude-haiku", messages: [{ role: "system", content: "sys L" }, { role: "user", content: "local with a token" }] }, { Authorization: `Bearer ${T1}` });
	t("a local request with a token runs on it", [r.content, records().filter((x) => x.event === "start").slice(-1)[0].token], ["echo[haiku]: local with a token", T1]);
	t("checkRemote: a proxy that answers", await mod.checkRemote({ LETS_CODE_CLAUDE_URL: base + "/", LETS_CODE_CLAUDE_TOKEN: T1 }), "");
	t("checkRemote: nothing there", (await mod.checkRemote({ LETS_CODE_CLAUDE_URL: `http://127.0.0.1:${await freePort()}` })).includes("not reachable"), true);

	// a newer server.mjs (lets-code updated): the old daemon is replaced
	const dir2 = join(work, "v2"); mkdirSync(dir2);
	const server2 = join(dir2, "server.mjs");
	writeFileSync(server2, readFileSync(join(dirname(extPath), "server.mjs"), "utf8") + "\n// v2\n");
	copyFileSync(join(dirname(extPath), "bridge.mjs"), join(dir2, "bridge.mjs"));
	t("newer server.mjs: restarted", await mod.ensureProxy(env, server2), "");
	const h2 = await mod.health(port);
	t("newer server.mjs: new daemon with its version", [h2?.version === mod.proxyVersion(server2), h2?.pid !== h1?.pid], [true, true]);
	pids.add(h2?.pid);

	// a port taken by something else is reported, not fought over
	const other = await freePort();
	const foreign = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); }).listen(other, "127.0.0.1");
	t("port taken by another server", (await mod.ensureProxy({ ...env, LETS_CODE_CLAUDE_PORT: String(other) })).includes("taken by another server"), true);
	foreign.close();
} finally {
	for (const p of pids) try { process.kill(p, "SIGTERM"); } catch {}
	const h = await mod.health(port).catch(() => null);
	if (h?.pid) try { process.kill(h.pid, "SIGTERM"); } catch {}
	await new Promise((r) => setTimeout(r, 300));
	rmSync(work, { recursive: true, force: true });
}
process.exit(failed);
