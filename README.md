<h1 align="center">lets-code</h1>

<p align="center">
  <b>Point the <a href="https://pi.dev">pi</a> coding agent at the LLM running on your own hardware.</b><br>
  One bash script. No cloud, no keys, no config spelunking.
</p>

<p align="center">
  <img alt="bash" src="https://img.shields.io/badge/bash-3.2%2B-4EAA25?logo=gnubash&logoColor=white">
  <img alt="platforms" src="https://img.shields.io/badge/linux%20%7C%20macOS-supported-blue">
  <img alt="servers" src="https://img.shields.io/badge/vLLM%20%7C%20SGLang%20%7C%20Ollama%20%7C%20LM%20Studio-OpenAI--compatible-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
</p>

```
$ lets-code
[lets-code] thinking support: true (startup level: high)
[lets-code] image input: true
[lets-code] connecting: http://localhost:8000  model: Qwen/Qwen3-32B  context: 131072  output cap: 32768  git guard: pi/20261008-2144
```

## Why

You have a GPU box serving a model with vLLM, SGLang or Ollama. You want a
real coding agent on it, not a chat window. pi is that agent, but it has to
be told about your server: the URL, the model id, the true context window,
whether the model thinks, whether it sees images. Get one of those wrong and
you get a silent overflow at hour two, or screenshots that never reach the
model.

lets-code figures all of that out from the server itself, every time you
launch, and adds the guard rails a small local model needs.

## Quick start

```bash
npx @civitas-cerebrum/lets-code setup   # endpoints, token, optional CA; installs pi if missing
lets-code                               # go
```

`setup` keeps to the essentials. `setup full` also turns on the optional
features below (modes, subagents, sandbox, MCP import); `setup granular`
asks about each one.

Setup installs the `lets-code` command itself. No npm? Grab the script:

```bash
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/civitas-cerebrum/lets-code/main/lets-code -o ~/.local/bin/lets-code
chmod +x ~/.local/bin/lets-code && lets-code setup
```

Needs `bash` 3.2+, `curl`, `python3`. `node`/`npm` only if it installs pi for you.

## What you get

| | |
|---|---|
| 🔎 **Discovery** | First reachable endpoint wins. Model id and context window come from `/v1/models`. |
| 🧠 **Thinking probe** | One tiny request with thinking forced on. Reasoning tokens in the reply mean pi gets a thinking model, with per-level budgets vLLM enforces. |
| 👁 **Vision probe** | One tiny request with a red 64×64 image. "Red" in the reply means pi may send screenshots. Setup asks you if the probe can't tell. |
| 📏 **Overflow-proof** | The output cap is reserved in pi's compaction settings, so `input + max_tokens` can never exceed the server window. |
| 🧯 **Memory guard** | When the box runs low on RAM, the session's own runaway process is stopped. Nothing else on the machine is touched. |
| 🛟 **Git guard** | All work on a `pi/*` branch. `reset --hard`, force pushes and friends are refused. The tree is checkpointed before every tool call. |
| 🧭 **Agent guard** | Default bash timeout, a nudge to run tests after untested edits, a wrap-up hint once they pass, and thinking that switches on only while the model struggles. |
| 🧭 **Modes** (optional) | `plan` explores read-only and ends in a numbered plan, `ask` confirms sudo, deletes, installs and out-of-project writes, `auto` is today's behaviour, `yolo` turns the rails off. Zero tokens on allowed calls. |
| 🐝 **Subagents** (optional) | A `subagent` tool runs agent files in their own pi process through the same server and guards: one, several in parallel, or a chain. Costs a few hundred tokens, not thousands. |
| 📦 **Sandbox** (optional) | Bash runs in bubblewrap (Linux) or Seatbelt (macOS) via sandbox-runtime: writes confined to the project, secrets unreadable, network allowlisted. |
| 🔌 **MCP** (optional) | pi has MCP built in; setup imports the servers other clients already have in `.mcp.json` and their own config files. |
| 🔒 **No secrets on disk** | The token lives in a mode-600 config and reaches pi through the environment. pi's telemetry is off unless you turn it on. |

Everything is re-derived at launch, so swapping models on the server needs
no edits here.

## Daily use

```bash
lets-code                         # interactive session
lets-code -p "fix the failing test"   # one-shot; unknown args go to pi
lets-code --model other-id        # pin something for one launch
lets-code --thinking-level low    # quieter model
lets-code --no-git-guard          # you know what you're doing
```

| Flag | Meaning |
|---|---|
| `--url <base>` | Endpoint for this launch (scheme and `/v1` optional) |
| `--model <id>` | Model for this launch (default: discovered) |
| `--context <tok>` | Context window (default: discovered, else 128000) |
| `--output-cap <tok>` | Max output tokens (default 32768) |
| `--api <dialect>` | `openai-completions` (default), `openai-responses`, `anthropic-messages`, `google-generative-ai` |
| `--thinking-level <lvl>` | `off`, `minimal`, `low`, `medium`, `high` (default `medium`), `adaptive[:<lvl>]` (medium, low once the tests pass, bursts up on struggle), or `auto[:<lvl>]` (off, bursts up on struggle); see [Choosing a thinking level](#choosing-a-thinking-level) |
| `--vision` / `--no-vision` | Pin image input instead of probing |
| `--insecure` | Skip TLS verification |
| `--no-mem-guard` / `--no-git-guard` / `--no-agent-guard` | Launch without a guard |
| `--mandate [<mode>]` / `--no-mandate` | Modes on, optionally starting in `plan`, `auto`, `ask`, `yolo` or a role of yours |
| `--subagents` / `--no-subagents` | The `subagent` tool |
| `--sandbox` / `--no-sandbox` | The OS sandbox for bash |
| `--verbose` | Show each endpoint probe |

<details>
<summary><b>Config file and environment</b></summary>

`~/.config/lets-code/config` is shell syntax, mode 600, written by setup.
Every key has an environment override, `LETS_CODE_<KEY>`, which wins.

| Key | Meaning |
|---|---|
| `ENDPOINTS` | Space-separated base URLs, most preferred first. IPs, `localhost`, bare hostnames and `*.local` get `http://`, other domains `https://`. |
| `TOKEN` | API key. Any value works for a server without auth. |
| `CA_PATH` | Root CA for an https endpoint with a private CA (exported as `NODE_EXTRA_CA_CERTS`). |
| `MODEL`, `CONTEXT`, `OUTPUT_CAP`, `API` | Pins; empty means discovered or default. |
| `VISION`, `REASONING` | `true`/`false` pins; empty means probed at launch. |
| `THINKING` | Startup thinking level. Setup suggests one from the context window. |
| `MEM_GUARD`, `GIT_GUARD`, `AGENT_GUARD` | `false` turns a guard off. |
| `TEMPLATE_EFFORT` | `off` skips the chat-template effort probe, `neutral` maps every level to the least-instruction value (see server setup). |
| `MANDATE`, `MODE` | `true` turns modes on; `MODE` is the start mode (empty = `auto`). |
| `SUBAGENTS`, `SANDBOX` | `true` turns the feature on. |

Listing several endpoints lets one config follow you around:
`http://localhost:8000 https://llm.home.example` works on the server box,
on the LAN and over a VPN.

</details>

<details>
<summary><b>Server setup (vLLM, nginx, private TLS)</b></summary>

vLLM needs tool calling and, for thinking models, a reasoning parser:

```bash
vllm serve Qwen/Qwen3-32B --max-model-len 131072 \
  --enable-auto-tool-choice --tool-call-parser hermes --reasoning-parser qwen3
```

Behind nginx, set `proxy_buffering off` so tokens stream. For a private CA
(mkcert, step-ca), give setup the public root certificate. The winning
https endpoint must be trusted, or launched with `--insecure`.

With a reasoning parser, vLLM also enforces the per-level thinking budget
pi sends (`thinking_token_budget`), so a model cannot think its way through
the whole output cap.

Some chat templates carry their own effort control (Qwen3.8 takes
`reasoning_effort`: `low`, `medium`, `xhigh`, default `xhigh`). At launch
lets-code renders the prompt through vLLM's `/tokenize` with each candidate
value; if the template reacts, pi's levels are mapped to the nearest
accepted value and the launch line shows the mapping. `TEMPLATE_EFFORT=off`
skips this; `TEMPLATE_EFFORT=neutral` maps every level to the value with the
least instruction (Qwen3.8: `medium`, which adds none), so levels differ
only in budget.

</details>

<details>
<summary><b>Memory guard (Linux)</b></summary>

A test with an unbounded search can take all RAM and freeze the machine
that serves the model. The guard watches free RAM and only ever acts on
processes this session started:

| Free RAM | Action |
|---|---|
| under 20 % | pi is warned, with the session's largest processes listed |
| under 10 % | new bash commands are blocked, except cleanup (`kill`, `ps`, `free`) |
| under 5 % for 3 s | the largest process is stopped: SIGINT, SIGTERM, SIGKILL, 10 s apart |
| under 2.5 % | the largest process is killed at once |

Nothing is capped; pi is told what was stopped and why. The guard is a pi
extension (`~/.pi/agent/extensions/lets-code-memguard.ts`) and is inert in
sessions not started by lets-code. It defers to a machine-wide
[memguard](https://github.com/civitas-cerebrum/memguard) daemon when one runs.

</details>

<details>
<summary><b>Git guard</b></summary>

Small models make the mistakes a reviewer would catch: a wrong
`reset --hard`, an edit that guts a file, a stray `rm`. So:

- **Work happens on a `pi/*` branch.** At launch, a repo that is not on one
  gets `pi/<timestamp>`; uncommitted changes come along. In the session, a
  hook reads `.git/HEAD` before each edit, write and bash call. On any
  other branch only inspection, `--continue`/`--abort` and a switch back
  to a `pi/*` branch are allowed.
- **Irreversible commands are refused on every branch:** force pushes,
  `branch -D`, `reset --hard`, `checkout <path>`, `clean -f`, `stash drop`,
  writes into `.git`, `rm` of the repo or `.git`, and their aliases and
  abbreviations. The hook parses bash like a shell (quotes, `&&`, `$(…)`,
  heredocs, `sh -c`, `cd`, `git -C`), so it cannot be tricked by spelling.
- **Checkpoints.** Before and after each tool call the working tree is
  snapshotted under `refs/pi-checkpoints/<branch>/<stamp>` through a
  private index. HEAD, index and branches are untouched; nothing is pushed.

```bash
git for-each-ref refs/pi-checkpoints/                            # list
git diff refs/pi-checkpoints/pi/x/20261005-231502.117            # what changed since
git restore --source=refs/pi-checkpoints/pi/x/20261005-231502.117 -- src/a.c
```

The guard costs no tokens: the model only sees a one-line reason when a
call is blocked. Merging the `pi/*` branch back is yours. Outside a git
repo the guard is off. `LETS_CODE_GIT_CHECKPOINTS=0` turns checkpoints off.

</details>

<details>
<summary><b>Agent guard</b></summary>

A pi extension (`~/.pi/agent/extensions/lets-code-agentguard.ts`) with
rules for failure modes measured in sessions against a local thinking
model. Apart from a five-line working-method section in the system prompt
it adds nothing unless a rule acts.

- **Bash timeout.** Calls without a timeout get `LETS_CODE_BASH_TIMEOUT`
  (300 s); a timeout the model passes is kept.
- **Cut-off replies.** A reply cut off by the output limit before any tool
  call is continued with a note to act, up to 3 times per session.
- **Test reminder.** After 3 source edits with no test run in between, the
  model is told to run its tests, up to 5 times per session.
- **Verification.** If pi tries to finish with edits no executed command
  has seen, or right after a failed check, it gets one continuation asking
  for a real run, up to 2 times.
- **Wrap-up.** Once the model's own tests have passed for
  `LETS_CODE_WRAP_TURNS` turns (6) and 2 minutes, or `LETS_CODE_WRAP_MINUTES`
  minutes (5), it is told once to finish if every requirement is covered
  by a test it has run.
- **Adaptive thinking** (`--thinking-level adaptive[:<ceiling>]`, opt-in).
  Rests at medium while the task is unsolved, dials down to low once pi's
  own tests pass and a later turn changes no source, back to medium if they
  fail again, and bursts to the ceiling (default `high`) on the struggle
  signals below. Faster and leaner than fixed medium on medium-sized tasks
  in the benchmark; not yet shown to be faster on hard ones.
- **Firm stop.** If pi keeps calling tools for 6 turns or 4 minutes after
  the wrap-up note without changing any source file, it is told once to
  stop and summarise.
- **Dynamic thinking** (`--thinking-level auto[:<ceiling>]`, default
  `high`). The level is a ceiling. pi starts with thinking off; a struggle
  signal (the same tests still failing after 3 runs, more failures after a
  source edit with the tests untouched, 2 failed edits in a row, 2 syntax
  errors, an identical tool call with no file change in between, 3 tool
  errors in a row, 40 turns without passing tests) raises it to the ceiling
  for a burst that opens with its reason as a one-line goal and ends when
  that reason is resolved, after `LETS_CODE_BURST_TURNS` turns (3), or when
  the tests pass. A new burst needs a new signal, at most
  `LETS_CODE_MAX_BURSTS` (8) per session; a thinking turn without a tool
  call is told once to act. Replayed over 131 benchmark sessions: no burst
  on the 36 easy ones, a median of 3 raised turns out of 57 on hard ones.
- **Final review** (`LETS_CODE_FINAL_REVIEW=auto`: dynamic mode, only after
  a burst, the default; `on`: any level; `0`: off). When the model is about
  to finish with its tests passing, it gets one turn (at the ceiling in
  dynamic mode) to verify each task rule against an executed test. It is
  verification only: a failing new test is checked against the task before
  any source change, no bursts fire after it starts, and finishing needs a
  green run after it.
- **Draft check** (dynamic mode). When half or more of the tests, and at
  least 5, fail in one of the first two test runs, one burst asks the model
  to rethink the design rather than patch failures one at a time.
- **Plan burst** (`LETS_CODE_PLAN_BURST=1`, dynamic mode). Thinking at
  `LETS_CODE_PLAN_LEVEL` (default `low`) for the first turn(s), until the
  first source file is written, plus a prompt line asking for a
  rule-by-rule test plan. At the ceiling one plan turn thought 27-54k chars.
- **Thinking replay window** (`LETS_CODE_THINKING_REPLAY=<n>`, default
  all). pi replays every earlier turn's thinking, about 40% of the prompt by
  the end of a high-thinking session; with a window only the last n turns
  keep theirs.

Test results are read from the usual runners (unittest, pytest, "N passed,
M failed" summaries) and from runs of a test file that print no summary:
exit 0 plus "pass" is green, an `AssertionError` is red.

`LETS_CODE_AGENT_GUARD_LOG=<file>` writes one JSON line per guard action.
`tests/agent-guard.test.mjs` drives the extension with a fake pi.

</details>

<details>
<summary><b>Choosing a thinking level</b></summary>

Measured October 2026 with pi against Qwen3.8-27B (local vLLM, and the same
model on OpenRouter), on six Python tasks from easy to hard, scored by
hidden tests the agent never sees (11 rounds, about 190 sessions):

| Level | Verdict |
|---|---|
| `off` | Fastest on easy and medium tasks, equally correct there; on hard tasks it thrashes (100-170 turns) and usually ends a test or two short. |
| `medium` (default) | The quality bar: strongest first drafts, fully correct on the hard task 2 of 2 times on OpenRouter at 18-19 minutes, and stops on its own. |
| `high` | Worst: rambles, times out, scores lowest. For Qwen3.8 it also brings the template's "consider plausible alternatives" instruction (see server setup). |
| `adaptive` | Same correctness on medium-sized tasks at about 60% of medium's time and half its thinking; on the hard task slower than medium in the runs so far. |
| `auto` | About 80% less thinking than medium, but slower and slightly less correct: starting from off, the first draft is weaker and repairing it takes many cheap turns. |

The fixes that helped at every level are on by default: per-level hard
thinking budgets, the template effort mapping, bash timeouts, cut-off reply
recovery, execution-based verification, and the wrap-up note. Raw data and
the harness live outside this repo.

</details>

<details>
<summary><b>Modes and mandates</b></summary>

With `MANDATE=true` every session runs under a **role**: a scope that says
which tools, paths, kinds of bash command, MCP servers and agents are
allowed, asked about or denied. The four built-in roles are the modes:

| Mode | What changes |
|---|---|
| `auto` | Nothing. Guards as always, no prompts. The default. |
| `ask` | `sudo`, recursive deletes, package installs, `curl \| sh` and writes outside the project are confirmed first: allow once, allow for the session, or deny. |
| `plan` | Edit and write are off, bash is read-only, and the model is told to end with a numbered `Plan:`. Leaving plan mode offers to execute it. |
| `yolo` | The mandate steps aside (the git and memory guards stay unless launched without them). |

Switch with `/mode <name>`, `/plan`, `alt+m` (cycle) or `ctrl+alt+p`. A denied
call costs the model one line under 200 characters; allowed calls cost
nothing. Denials are logged to `~/.pi/agent/lets-code-mandate.log`.

Roles are JSON. `~/.pi/agent/mandate.json` has full authority (add roles,
change defaults); a project's `.pi/mandate.json` may only tighten, and is
read only once the project is trusted. `lets-code mandate init [--global]`
writes a starter. A role can set `tools`, `read` and `write` scopes,
`external` (allow / ask / deny for paths outside them), `bash` decisions per
command group (`readonly`, `git-write`, `build`, `package-install`,
`privileged`, `destructive`, `network-exec`, or your own regex `groups`),
`mcp` (a decision or a server list), `dispatch` (which agents it may start),
`network` on or off and `sandbox` overrides for the sandbox, a `prompt`
section, and extra `protected` paths. `.git`, `.env`, keys and certificates
are protected in every mode but `yolo`.

</details>

<details>
<summary><b>Subagents</b></summary>

With `SUBAGENTS=true` the model gets one tool, `subagent`, and setup writes
three starter agents (`scout`, `worker`, `reviewer`) to `~/.pi/agent/agents`.
An agent is a Markdown file with YAML frontmatter, the same layout pi's own
example and the community packages use:

```markdown
---
name: scout
description: Fast read-only recon; returns the files and key code another agent needs
tools: read, grep, find, ls, bash
role: readonly
---
Investigate quickly and report ...
```

`tools` limits the child's tools, `thinking` sets its level, `role` picks its
mandate role (`readonly` is a built-in without the planning prompt). Project
agents in `.pi/agents/` or `.agents/agents/` are used once the project is
trusted. Calls: `{agent, task}`, `{tasks: [...]}` for parallel work (at most
2 at a time by default, since one GPU serves every agent;
`LETS_CODE_SUBAGENT_CONCURRENCY` changes it), or `{chain: [...]}` with
`{previous}` carrying the prior output. Each child is a `pi` process through
the same provider and guards, with its own context, and cannot start
children of its own. Output is capped at 50 KB per agent.

</details>

<details>
<summary><b>Sandbox</b></summary>

With `SANDBOX=true` the model's bash commands and your own `!` commands run
inside `@anthropic-ai/sandbox-runtime`: bubblewrap plus a filtering proxy
on Linux (install `bubblewrap` and `socat`), Seatbelt on macOS. lets-code
installs the runtime next to the extension on first use. Defaults: writes
allowed in the project, `/tmp` and a few caches; `~/.ssh`, `~/.aws`,
`~/.gnupg`, the lets-code config and pi's auth files unreadable; network
limited to package registries and GitHub. Configure in
`~/.pi/agent/extensions/sandbox.json` and `.pi/sandbox.json` (the same files
as pi's sandbox example), or per mode through a role's `network` and
`sandbox` keys. `/sandbox` shows what is in effect. Without the runtime or
its system packages, bash runs as before and the launch line says so.

</details>

<details>
<summary><b>MCP</b></summary>

pi has MCP built in: `~/.pi/agent/mcp.json` and `.pi/mcp.json` use the same
`mcpServers` shape as the other MCP clients, `pi mcp add` adds a server,
`/mcp` manages them, and tools arrive as `mcp__server__tool` through
codemode so their schemas stay out of the context. `lets-code setup full`
or `granular` imports servers it finds in `.mcp.json`,
`~/.config/mcp/mcp.json`, `~/.claude.json` or `~/.cursor/mcp.json`. Mandate
roles see every MCP call and can allow, ask or deny per server.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Fix |
|---|---|
| `no endpoint reachable` | Server down, wrong URL, or DNS. `lets-code --verbose` shows each probe. |
| `certificate this machine doesn't trust` | Set `CA_PATH`, or `--insecure` to test. |
| Output arrives all at once | A proxy is buffering. nginx: `proxy_buffering off`. |
| Tool-call errors in server logs | Start the server with `--enable-auto-tool-choice --tool-call-parser <p>`. |
| Thinking text in the output | Missing `--reasoning-parser`. |
| Session dies on long tasks | Wrong context size. Check `context:` on the launch line; pin `CONTEXT=` if the server hides `max_model_len`. |
| Model does not see images, or does not think | Check the `image input:` / `thinking support:` launch lines. Pin `VISION=true` / `REASONING=true` if a probe was inconclusive. |
| pi says provider `lets-code` is unknown | Re-run `lets-code`; it re-registers on every launch. |
| `sandbox: not active` on the launch line | Install `bubblewrap` and `socat` (Linux), or run the `npm install` the message names. |
| A call was refused with `mandate(...)` | The current mode forbids it. `/mode auto` lifts the rails for the session, or tighten/loosen the role in `~/.pi/agent/mandate.json`. |

</details>

## Under the hood

Each launch probes the endpoints, reads `/v1/models`, runs the thinking and
vision probes, then writes pi's `models.json` and `settings.json` under the
provider id `lets-code`. Your other providers and settings are untouched.
pi's file-search helpers (`fd`, `ripgrep`) are fetched before the first
start so the first session starts clean. Design notes and the reasoning
behind each decision are in [DESIGN.md](DESIGN.md).

`tests/run.sh` runs the suite CI runs on every pull request: shell tests
for the probes, endpoint parsing, the chat-template effort probe and the
OpenRouter config, node tests for the git guard, checkpoints, agent guard,
mandate, subagents and sandbox config. `tests/mem-guard-live.sh` is a tmux-driven end-to-end run for
the memory guard. Releases are published to npm from GitHub releases.

## License

MIT
