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
✦ lets-code Qwen/Qwen3-32B (auto) @ localhost:8000
  131k context · thinking high · vision · 4 guards · 7 extensions
  let's code.
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
features below (modes, sandbox, MCP import); `setup granular`
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
| 🔍 **Grounding guard** | pi looks facts up with its tools instead of guessing them (file contents, paths, names, versions, config, command output), invents nothing and says what it could not verify. Overwriting an existing file it has not read is blocked once: read first, or write again. |
| 🧭 **Backend facts** | The agent knows its backend (server, model, API, context, thinking, vision) without discovering it, at no cost until it needs it: a prompt about the backend adds a short section, or the first command probing it gets the facts in its result. The API key is never written out. |
| 🛟 **Git guard** | All work on a `pi/*` branch. `reset --hard`, force pushes and friends are refused. The tree is checkpointed before every tool call. |
| 🧭 **Agent guard** | Default bash timeout, a nudge to run tests after untested edits, a wrap-up hint once they pass, and thinking that switches on only while the model struggles. |
| 🧭 **Modes** (optional) | `plan` explores read-only and ends in a numbered plan, `ask` confirms sudo, deletes, installs and out-of-project writes, `auto` is today's behaviour, `yolo` turns the rails off. Zero tokens on allowed calls. |
| 🤝 **Claude Code projects** (automatic) | A project whose `.claude/` has hooks or workflow scripts works as it is: its hooks, workflows, skills, `/commands`, agents, permission rules, MCP servers and CLAUDE.md, read live at each start. Your own `~/.claude` stays out unless `CLAUDE_CODE=all`. Project hooks and servers wait for the folder to be trusted, as in Claude Code. |
| 🐝 **Subagents** (on by default) | A `subagent` tool runs agent files in their own pi process through the same server and guards: one, several in parallel, or a chain. Costs a few hundred tokens, not thousands. |
| 📦 **Sandbox** (optional) | Bash runs in bubblewrap (Linux) or Seatbelt (macOS) via sandbox-runtime: writes confined to the project, secrets unreadable, network allowlisted. |
| 🔌 **MCP** (optional) | pi has MCP built in; setup imports the servers other clients already have in `.mcp.json` and their own config files. |
| 🧑‍🔬 **Experts** (on by default) | Subagents with their own knowledge behind one `expert` tool that costs one line of context: the model sees each expert's name and what it is for, asks for a job and a brief template when it needs one, and runs it with a filled-in brief. Every expert is dormant until you say yes (a dialog the first time, remembered); one that needs an install gets it then. |
| 📱 **Termux device** (expert) | On a phone running lets-code in Termux, the `termux-device` expert does phone tasks end to end: launch or bring an app to the front, open a file in an app, fire an intent, prepare a message (WhatsApp, SMS, mail) for you to send, and, once you set up Shizuku or adb, read the screen, tap and type. It checks first what the phone allows and tells you the one setup step that unlocks more. |
| 🔬 **REA** (expert) | Reverse engineering with [REA](https://github.com/morluto/rea) on demand: the `reverse-engineer` expert hands the question to a separate pi that has REA's 170 tools, so they never enter your session. REA is installed when you enable it. |
| 🧪 **Tester** (expert) | Web-app QA the way [achilles](https://github.com/civitas-cerebrum/achilles) does it, on demand: the `tester` expert maps journeys, writes and runs e2e tests with the Steps API of [element-interactions](https://github.com/civitas-cerebrum/element-interactions) (Playwright), verifies a flow or change with evidence, hunts bugs and diagnoses failing e2e tests, in a separate pi; Android and iOS apps too where Appium is set up. Installed when you enable it; Linux and macOS only. |
| ⚖️ **Acceptance judge** (expert) | "Is it done?" answered by trying to break it: the `acceptance-judge` expert takes the acceptance criteria and the work (a diff, branch, commit or PR), runs the checks itself with negative controls, and returns PASS / FAIL / UNVERIFIABLE per criterion with the evidence, then ACCEPT or REJECT. It never edits the work. The method is distilled from achilles' review roles; nothing to install, so it works everywhere, the phone included. |
| 🏗️ **Expert builder** (expert) | Ask for a new expert ("make me an expert that converts and validates config files") and the `expert-builder` expert designs it, distills its sources (docs, a repo, a method, your scripts) into instructions and references, writes the files as your own, lints them and measures how well the model routes to it. It can also prepare a built-in for lets-code on a git branch. Files only, so it works everywhere. |
| 🎛 **Presets** | Save more backends under names (`lets-code setup preset`), then launch one with `lets-code --openrouter` or `lets-code --qwen`. Each is its own pi provider, so sessions on different presets run side by side. |
| 🎨 **lets-code theme** | A pastel take on pi's dark theme that looks the same in every terminal, in tmux and over ssh, next to pi's built-in `dark`, `light` and auto (`system`, the default). The first launch asks which one to use; switch any time in `/settings`. |
| 🔒 **No secrets on disk** | The token lives in a mode-600 config and reaches pi through the environment. pi's telemetry is off unless you turn it on. |

Everything is re-derived at launch, so swapping models on the server needs
no edits here.
A model discovered from the server shows as `(auto)` in the banner; a pinned
model the server does not list gets a warning at launch.

## Daily use

```bash
lets-code                         # interactive session
lets-code -p "fix the failing test"   # one-shot; unknown args go to pi
lets-code --model other-id        # pin something for one launch
lets-code --openrouter            # a saved preset (see Presets below)
lets-code update                  # latest release from npm (--snapshot: latest main)
lets-code --thinking-level low    # quieter model
lets-code --no-git-guard          # you know what you're doing
```

| Flag | Meaning |
|---|---|
| `--<preset>` / `--preset <name>` | Launch against a saved preset |
| `--url <base>` | Endpoint for this launch (scheme and `/v1` optional) |
| `--model <id>` | Model for this launch (default: discovered) |
| `--context <tok>` | Context window (default: discovered, else 128000) |
| `--output-cap <tok>` | Max output tokens (default 32768) |
| `--api <dialect>` | `openai-completions` (default), `openai-responses`, `anthropic-messages`, `google-generative-ai` |
| `--thinking-level <lvl>` | `off`, `minimal`, `low`, `medium`, `high` (default `medium`; a level picked in a session is where the next one starts, and this flag overrides it for one launch), `xhigh` (opt-in, 32k budget, also selectable in-session; see server setup), `adaptive[:<lvl>]` (medium, low once the tests pass, bursts up on struggle), or `auto[:<lvl>]` (off, bursts up on struggle); see [Choosing a thinking level](#choosing-a-thinking-level) |
| `--vision` / `--no-vision` | Pin image input instead of probing |
| `--insecure` | Skip TLS verification |
| `--no-mem-guard` / `--no-git-guard` / `--no-agent-guard` / `--no-grounding` | Launch without a guard |
| `--no-session-tag` | Send no session tag with model requests |
| `--metrics` / `--no-metrics` | Start this launch with the full / minimal footer (`/metrics` switches inside pi, and the size picked there is where later sessions start) |
| `--metrics-log <file>` | Append the footer's numbers to `<file>` as JSON lines, also without a UI (see [Metrics log](#metrics-log)) |
| `--mandate [<mode>]` / `--no-mandate` | Modes on, optionally starting in `plan`, `auto`, `ask`, `yolo` or a role of yours |
| `--subagents` / `--no-subagents` | The `subagent` tool (on by default) |
| `--experts` / `--no-experts` | The `expert` tool (on by default, needs subagents; see [Experts](#experts)) |
| `--claude-code` / `--no-claude-code` | The Claude Code adapter with your `~/.claude` too (`CLAUDE_CODE=all`) / off; by default it switches on by itself where needed (see [Claude Code projects](#claude-code-projects)) |
| `--sandbox` / `--no-sandbox` | The OS sandbox for bash |
| `--verbose` | Show each probe and the full launch detail (API, output cap, guards, session tag) |

<details>
<summary><b>Presets</b></summary>

A preset is another backend saved under a name: a different server, a
gateway like OpenRouter, or a second model on the same box.

```bash
lets-code setup preset            # onboarding: asks the name, server, token, model
lets-code setup preset qwen       # the same, name given
lets-code presets                 # list them
lets-code --qwen                  # launch one (or: --preset qwen)
```

Setup asks for the endpoints, token, CA (for https) and model, then probes
the model for thinking and image input like the main setup. A gateway lists
hundreds of models, so give it a model id; the context window is read from
that model's entry.

Presets live in `~/.config/lets-code/presets/<name>` (shell syntax, mode
600), with the same keys as the config. A preset is applied on top of the
config, so guards and optional features still come from the config, and any
config key can be added to a preset to override it. Environment variables and
flags still win. Each preset registers with pi as its own provider,
`lets-code-<name>`, so two sessions on different presets never rewrite each
other's backend. Names can't shadow a lets-code or pi option.

</details>

<details>
<summary><b>Updating</b></summary>

```bash
lets-code update             # the latest release published to npm
lets-code update --snapshot  # the latest commit on main
lets-code --version          # what you have: a release, main-<commit>, or dev
```

An npm install is updated with `npm install -g`. A copied script (what
setup installs into `~/.local/bin` or `/usr/local/bin`) is replaced in place:
the release tarball is checked against the registry's sha512, a snapshot is
pinned to the commit it was read at, and the download must parse as bash
before it replaces the old file. A git checkout is left to `git pull`.
Extensions and themes are rewritten on the next launch.

</details>

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
| `MEM_GUARD`, `GIT_GUARD`, `AGENT_GUARD`, `GROUNDING` | `false` turns a guard off. |
| `TEMPLATE_EFFORT` | `off` skips the chat-template effort probe, `neutral` maps every level to the least-instruction value (see server setup). |
| `MANDATE`, `MODE` | `true` turns modes on; `MODE` is the start mode (empty = `auto`). |
| `SUBAGENTS` | On by default; `false` turns the `subagent` tool off. |
| `EXPERTS` | On by default (with subagents); `false` turns the `expert` tool off and lists no expert. Each expert is enabled in a session, not here (see [Experts](#experts)); `TERMUX=true` / `REA=true` from earlier versions are migrated once and then ignored. |
| `SANDBOX` | `true` turns the feature on. |
| `METRICS` | lets-code draws pi's footer in one style, in two sizes. Minimal (default): `↑222k ↓25k · 161.7 tok/s · 22.0%/262k (auto)`: tokens sent (cached included) and received, the session's generation speed with a small spinner while a response streams, context use. Full: the directory and branch with the model and thinking level on a first line, then the same line with the latest request's cache hit rate, cost, and the latest response's time to first token and output tokens (two lines that keep their height: `↑222k ↓25k · 22.0%/262k (auto) · cache 198k (86%) · $0.012` and `⠸ 161.7 tok/s · TTFT 1.0s · 2.7k out`; on a narrow terminal the cache shortens to its hit rate, then cost, cache, output and TTFT drop; TTFT is the time to the first token; a line too wide for the terminal breaks between parts onto a second line; only if two lines are not enough do cost, cache, output and TTFT drop, in that order). `true` starts in the full size; `/metrics` (or `/metrics on\|off`) switches inside pi, and the size picked there is remembered (`~/.pi/agent/lets-code-state.json`): later sessions start in it, ahead of `METRICS`; `--metrics` / `--no-metrics` / `LETS_CODE_METRICS` decide for one launch without changing it. tok/s counts from each response's first streamed token, so prompt processing is not in it. |

Listing several endpoints lets one config follow you around:
`http://localhost:8000 https://llm.home.example` works on the server box,
on the LAN and over a VPN.

#### Metrics log

`--metrics-log <file>` (or `LETS_CODE_METRICS_LOG=<file>`) has the footer
extension append one JSON object per line to `<file>` as things happen, for
harnesses and benchmarks. It works without a UI (`-p`, `--mode json`), and
subagents inherit it and write the same file with their `depth`. The file is
only appended to; one that cannot be written is skipped. Every record has
`type`, `ts` (ISO time), `depth` (0 = the top session) and `pid`; times are
in ms, `null` where unknown:

```json
{"type":"session","ts":"…","model":"qwen3.8-27b","provider":"lets-code","context_window":262144,"thinking_level":"medium","depth":0,"pid":4242}
{"type":"request","ts":"…","ttft_ms":500,"gen_ms":2000,"output_tokens":100,"input_tokens":10000,"cached_tokens":8000,"cache_hit_pct":80,"tok_s":50,"estimated":false,"thinking_level":"medium","stop_reason":"toolUse","depth":0,"pid":4242}
{"type":"prompt","ts":"…","duration_ms":4300,"requests":2,"tool_calls":4,"subagent_calls":3,"subagent_tasks":6,"outcome":"completed","depth":0,"pid":4242}
{"type":"session_end","ts":"…","reason":"quit","duration_ms":8000,"prompts":2,"requests":3,"tool_calls":4,"subagent_calls":3,"subagent_tasks":6,"input_tokens":20100,"output_tokens":150,"cached_tokens":18000,"depth":0,"pid":4242}
```

`request`: one per model response; `ttft_ms` from sending to the first
streamed token, `gen_ms` from there to the end, `input_tokens` every prompt
token sent (cached included), `cached_tokens` the cache reads, `estimated`
when the provider gave no output count. `prompt`: one per user prompt, until
pi settles; `outcome` is `completed`, `interrupted` or `error`;
`subagent_tasks` counts each subagent call's tasks or chain steps.
`session_end`: the session's totals at shutdown.

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

`xhigh` is opt-in: start with it (`--thinking-level xhigh` or
`THINKING=xhigh`) or pick it in the session. pi on its own clamps it to
`high` (same 16k budget, same template value); lets-code gives it a 32k
thinking budget (through `samplingParamsByThinkingLevel`) and the template's
`xhigh` effort value. That needs an output cap of at least 40k (budget plus
8k of answer). With no pinned `OUTPUT_CAP`, xhigh requests get a 48k cap of
their own while the other levels keep the default, so `xhigh` can be picked
at any startup level; with `xhigh` as the startup level the default cap
itself rises to 48k. Either way never above a quarter of the context, so
windows under 160k keep `xhigh` clamped to `high` (with a note at launch
when it is the startup level). A pinned cap of 40k or more enables `xhigh`
as well; a smaller pinned cap leaves it clamped. `max` stays clamped by pi:
to `xhigh` when it is enabled, otherwise to `high`.

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
extension (part of lets-code's, `~/.pi/agent/extensions/lets-code/memory-guard.ts`) and is inert in
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

A pi extension (part of lets-code's, `~/.pi/agent/extensions/lets-code/agent-guard.ts`) with
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

The first session starts at `medium` (or `THINKING=` from the config).
A level you pick in a session (Shift+Tab, `/thinking`) is remembered per
model in `~/.pi/agent/lets-code-state.json` and the next session starts
there; `--thinking-level` or `LETS_CODE_THINKING` decide for one launch
without changing it. Subagents start at `medium` unless their agent file
sets `thinking:`. With `auto` or `adaptive` the agent guard moves the level,
so nothing is remembered.

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
allowed, asked about or denied. The four built-in roles are the modes (two
more, `readonly` and `reviewer`, are for subagents):

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

`reviewer`, the role of the starter `reviewer` agent and of the acceptance
judge, runs tests and commands but writes only under the temp dir (no edit
or write tool, redirects and `sed -i` elsewhere refused), and refuses git
writes (`checkout`, `stash`, `commit`, ...), package installs, recursive
deletes, `sudo` and remote shells. A role of the same name in your
`~/.pi/agent/mandate.json` is merged over it like any built-in: the fields
you set win, the others stay as built in (to change it completely, set
each field, or give your role another name). A project's `.pi/mandate.json`
may only tighten it.

</details>

<details>
<summary><b>Subagents</b></summary>

Subagents are on by default (`SUBAGENTS=false` turns them off). The model
gets one tool, `subagent`, and lets-code writes three starter agents
(`scout`, `worker`, `reviewer`) to `~/.pi/agent/agents` when it is empty.
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
mandate role (`readonly` is a built-in without the planning prompt;
`reviewer` also runs tests). The starter `reviewer` agent uses `reviewer`;
one written by an earlier version with `role: readonly` is updated on
launch unless you edited it. Project
agents in `.pi/agents/` or `.agents/agents/` are used once the project is
trusted. Calls: `{agent, task}`, `{tasks: [...]}` for parallel work (at most
2 at a time by default, since one GPU serves every agent;
`LETS_CODE_SUBAGENT_CONCURRENCY` changes it), or `{chain: [...]}` with
`{previous}` carrying the prior output. Each child is a `pi` process through
the same provider and guards, with its own context, and cannot start
children of its own. A child thinks at `medium` unless its agent file sets
`thinking:`; a level switched to in a session does not carry over. Output is
capped at 50 KB per agent.

An agent type can also bring its own environment. These fields are
optional; unknown fields are ignored:

| Field | Meaning |
|---|---|
| `agent_dir` | The child's `PI_CODING_AGENT_DIR`: its own `mcp.json`, skills and settings. Link models, auth and extensions into it to share them (as `~/.pi/agent/rea/agent` does). |
| `skills` | Skill paths passed to the child as `--skill` (`a, b`, `[a, b]` or a `- a` list). |
| `append_prompt` | A file appended to the child's system prompt after the agent's own body. |
| `timeout` | Seconds before the child is stopped (1 to 86400; none by default). |
| `requires` | A path that must exist, otherwise the agent is hidden: not listed, not callable. |
| `requires_env` | An environment variable that must be set (and not `0`), otherwise hidden. |

Paths are relative to `~/.pi/agent`, or absolute under it (or under the
project, for a trusted project's agent); a file that points anywhere else,
or has a bad `timeout`, is ignored. A missing `agent_dir`, skill or
`append_prompt` hides the agent like `requires` does. The
`reverse-engineer` agent lets-code writes is the example (its file also
carries the fields that make it an expert, see
[Experts](#experts)):

```markdown
---
name: reverse-engineer
description: Reverse engineers binaries, apps, APKs, firmware, websites
agent_dir: rea/agent
skills: rea/runtime/node_modules/rea-agents/skills/reverse-engineer-anything
append_prompt: rea/prompt.md
timeout: 3600
requires: rea/runtime/node_modules/rea-agents/package.json
---
```

**Subagent sessions.** Every subagent and expert run is a real pi
session of its own, and you can switch the TUI into it. `/subagents` (or
<kbd>Alt</kbd>+<kbd>S</kbd>) opens a picker in place of the input: the main
session, then the runs, running first, then finished ones, newest first.
Each row shows a status mark (`●` running, `✓` done, `✗` failed or timed
out, `■` stopped), the agent, the task, the elapsed time and the tokens.
<kbd>Enter</kbd> switches into that run's session the way `/resume` does, so
pi draws it like any session: the task, thinking, text, tool calls and their
results, with pi's own keys (<kbd>Ctrl</kbd>+<kbd>O</kbd> and the rest).
<kbd>x</kbd> (twice) stops a running child; the others in the call go on.
`/subagents 2` or `/subagents scout` switches straight to a run.

In a subagent's session the status line says so, for example `subagent
scout · running · alt+s back`, and <kbd>Alt</kbd>+<kbd>S</kbd> or
`/subagents back` returns to the main session; `/subagents` from there
picks another run. The session works like the main one, through the
child's own process (each child is a pi in RPC mode, with the agent's
tools, role, instructions and model):

- **Typing while it works** steers it, as <kbd>Enter</kbd> does while the
  main session streams: the message waits under the chat (`Steering: …`)
  and goes in after the current tool calls.
- **Typing while it rests** (done, stopped, or after a restart) starts its
  next turn. A child that has rested `LETS_CODE_SUBAGENT_IDLE_S` seconds
  (300) has exited; its process starts again on the same session file with
  the agent's settings, so it never runs with the main session's tools or
  role.
- <kbd>Esc</kbd> aborts its turn, as in the main session; the process stays,
  so you can go on.
- `!` and `!!` run in the child's process and land in its session; pi
  shows the output as for any `!` command.
- **Slash commands** work as in the main session. Those that concern the
  conversation act on the child: `/model` and the thinking level
  (<kbd>Shift</kbd>+<kbd>Tab</kbd>, `/thinking`) are passed on to it,
  `/compact` compacts its session (pi also says its own compaction of the
  copy it shows was cancelled), `/name` names its session; `/copy`,
  `/export`, `/share` and `/session` read its session as it is now (the
  view is caught up first). `/new` starts a new main session and `/resume`
  lists the main sessions, as from the main session; `/fork` and `/clone`
  say to go back first (they would fork the copy). The rest (`/subagents`
  and its subcommands, `/metrics`, `/experts`, `/settings`, `/model`'s
  picker, `/hotkeys`, `/reload`, ...) behave exactly as in the main
  session. A `/mode` or `/plan` there sets the main session's mode: a
  subagent's role is fixed by its agent file.
- A dialog the child's guards open (the mandate asking before a command)
  appears here with the agent's name in front.
- When a turn you started in a child ends, its reply is added to the main
  session as a short message (`scout (a subagent the user went on with in
  its own session) replied: …`, as soon as you are back there), so the
  model there knows; it does not start a turn.

Children go when the main session ends (quit, `/new`, `/resume` of another
session), when their run is pruned, or after resting as above.

How live a running child's session is: as live as the main session. The
message on its way (thinking, text, tool calls token by token, a tool's
output as it streams) is drawn above the input as pi draws a streaming
message, with the same components, plus a line with the child's clock and
tokens; each message the child completes (its replies, tool results, your
prompts and steers) is then added to the chat in place, as pi adds one.
The session is never reloaded while you are in it, so nothing jumps or
scrolls back. Switching into or out of a child's session is a session
switch like `/resume`: pi redraws the screen then, and shows its own
footer for a moment while it loads the session.

Switching away from the main session while a call is running does not stop
its children: the call goes on in the background (the tool call shows
`Still running in the background ...` and the turn ends), and once the runs
are done their report is sent to the main session as a message that
continues it, as soon as you are back there. A plain stop
(<kbd>Esc</kbd>) still stops them.

`/subagents toggle` adds the session's runs to the footer, one line each
(running first; mark, name, task on wide terminals, elapsed time, tokens;
condensed on narrow ones), and is remembered for the next launch like
`/metrics`. While a run is going and the footer list is off, the status
says `2 subagents running · alt+s or /subagents to switch`. None of this
costs context: nothing in it reaches the model (the requests of the main
session and of its children are the same byte for byte).

`LETS_CODE_SUBAGENT_KEY` picks another key (pi's key syntax, e.g.
`ctrl+alt+w`), and `none` turns the key off. Each run is kept in
`~/.pi/agent/lets-code-runs/<session id>/`: its session file
(`<run>.pi.jsonl`, outside pi's session store, so not in `/resume`'s list),
the copy the TUI opens (`<run>.view.jsonl`), the agent's instructions
(`<run>.prompt.md`, for a restart) and a transcript (`<run>.json`, what the live part and the lists draw
from, with tool output cut to its first and last few thousand characters),
both mode 0600, so a finished run reopens after `/reload`, a restart with
`-c`, or `/resume`. The newest 30 runs of a session
(`LETS_CODE_SUBAGENT_KEEP_RUNS`) and the newest 20 sessions stay on disk.

</details>

<details>
<summary><b>Sandbox</b></summary>

With `SANDBOX=true` the model's bash commands and your own `!` commands run
inside `@anthropic-ai/sandbox-runtime`: bubblewrap plus a filtering proxy
on Linux (install `bubblewrap` and `socat`), Seatbelt on macOS. lets-code
installs the runtime next to it (`~/.pi/agent/extensions/lets-code/sandbox/`) on first use. Defaults: writes
allowed in the project, `/tmp` and a few caches; `~/.ssh`, `~/.aws`,
`~/.gnupg`, the lets-code config and pi's auth files unreadable; network
limited to package registries and GitHub. Configure in
`~/.pi/agent/extensions/sandbox.json` and `.pi/sandbox.json` (the same files
as pi's sandbox example), or per mode through a role's `network` and
`sandbox` keys. `/sandbox` shows what is in effect. Without the runtime or
its system packages, bash runs as before and the launch line says so.

</details>

<details>
<summary><b>Session tag</b></summary>

Each launch picks an id, `<host>:<project>:<random>` (shown on the launch
line), and every model request carries it as `X-Lets-Code-Session` and at the
end of the User-Agent (`pi (...) lets-code/<id>`). Subagents add
`/sub<depth>.<pid>`. A proxy in front of the model server can then tell
concurrent sessions apart without reading request content: nginx's default
`combined` log already records the User-Agent, or log the header itself with
`$http_x_lets_code_session` in a `log_format`. Only headers change; nothing
reaches the model. Off with `--no-session-tag` or `LETS_CODE_SESSION_TAG=false`.

</details>

<details>
<summary><b>Claude Code projects</b></summary>

<a id="claude-code-projects"></a>A repo whose `.claude/` folder (from the
working folder up to the git root) has hooks in its settings or workflow
scripts works in lets-code without edits: the adapter switches on by itself
there, reads that project's `.claude` where Claude Code keeps it, at each
start, and copies or converts nothing. Anywhere else it does nothing at all,
so a folder with only skills or commands, or your home folder, is left to
pi alone. The launch line says what was found, e.g.
`claude code: 2 commands, 1 skill, 2 hooks, 1 workflow`.

Your own `~/.claude` (its hooks, skills, commands, agents, workflows,
CLAUDE.md, MCP servers and env) is not taken over: it was written for Claude
Code, not for this model, and claude.ai's synced skills there collide by
name. `CLAUDE_CODE=all` (config or `LETS_CODE_CLAUDE_CODE=all`, or
`--claude-code`) brings it in everywhere, as the table below describes. The
home folder's `.claude` never counts as a project. Skills are handed to pi
one folder each: a name pi already has (its own skills) or a second copy of
a name is left out, so there are no skill conflicts. Off with
`--no-claude-code` or `CLAUDE_CODE=false`.

What is read (the `~/.claude` parts only with `CLAUDE_CODE=all`):

| Claude Code | In lets-code |
|---|---|
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` (from the folder up), `~/.claude/CLAUDE.md`, `.claude/rules/*.md` without `paths:` | Context files next to pi's own `AGENTS.md`/`CLAUDE.md`, in Claude's order; `@path` imports are followed (4 hops, each file once; outside the project only in a trusted folder) |
| `.claude/skills/` (up to the git root), `~/.claude/skills/` | pi skills: name and description in the prompt, the body read on use; also `/<name> [args]` |
| `.claude/commands/**/*.md`, `~/.claude/commands/` | `/<name>`, `/<dir>:<name>`; `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` (from 0), named `arguments`, `` !`cmd` `` and ```` ```! ```` blocks run first, `@file` attached; the project's wins over yours |
| `.claude/agents/*.md`, `~/.claude/agents/` | Agents of the `subagent` tool; `tools`/`disallowedTools` mapped to pi's (`Glob` is `find`; tools pi lacks are dropped), `effort` is the thinking level, `permissionMode: plan` the readonly role; `model` and `color` are ignored. A pi agent of the same name wins |
| `hooks` in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` | Run on pi's events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart (startup, resume, clear, compact, fork), Stop, SubagentStop (in subagents), SubagentStart, PreCompact, SessionEnd, Notification (when lets-code waits for an answer). Claude's stdin JSON (tool names and arguments in Claude's names, `transcript_path` is pi's session file), `sh -c` in the project with `CLAUDE_PROJECT_DIR`, in parallel, identical commands once, Claude's timeouts; exit 0 / 2 / other and the JSON output (`continue`, `decision`, `permissionDecision`, `updatedInput`, `additionalContext`, `updatedToolOutput`, `systemMessage`) as Claude defines them. `disableAllHooks` is honoured. A snapshot is taken at session start |
| `permissions.allow` / `ask` / `deny` | deny blocks the call, ask asks you (blocks without a UI), allow skips the mandate's question; a bare tool name in deny removes the tool. `Bash(npm run test *)`, `Bash(git:*)`, `Read(./secrets/**)`, `Edit(/src/**)`, `//abs`, `~/`, `mcp__server`, `Agent(name)`. lets-code's guards and mandate denials still apply on top |
| `.mcp.json`, `mcpServers` in `~/.claude.json` (user and local scope) | Registered with pi's MCP; `${VAR}` / `${VAR:-default}` expanded; `.mcp.json` servers need the folder trusted and Claude's approval (`enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`) or a yes to lets-code's question |
| `.claude/workflows/*.js`, `~/.claude/workflows/` | A `workflow` tool and `/<name> [args]` / `/workflow <name>`; `agent()` (one child pi each, `schema` for JSON answers), `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, at `LETS_CODE_SUBAGENT_CONCURRENCY` agents at a time. Needs subagents on |
| `env` in the settings files | Exported into pi's environment at launch |

Context cost: the adapter itself adds nothing to the prompt. What a project
brings is what Claude Code would load too: its CLAUDE.md files and one line
per skill. The `workflow` tool exists only where workflow scripts do (one
short line), and a prompt that asks for a workflow (its name with "workflow",
`/name`, or wording close to its description) adds a two-line section naming
it, kept for the session. Hook output reaches the model only as Claude
defines it. The skills claude.ai syncs into `~/.claude/skills/synced/` are
left out (about 15 KB for tools that are not here;
`LETS_CODE_CLAUDE_SYNCED_SKILLS=1` brings them in).

**Trust.** Your own files (`~/.claude`, `~/.claude.json`) always count. A
project's hooks, `.mcp.json` servers, settings `env`, allow rules, agents,
workflows and the `` !`cmd` `` of its commands run only in a trusted folder:
trusted in Claude Code (its trust dialog for the folder or a parent), in pi
(`/trust`), or by your answer to lets-code's own question, asked once with
the list of what would run and remembered in
`~/.pi/agent/lets-code-state.json`. Without a UI an undecided folder's
project parts are skipped with a one-line note. deny and ask rules apply
everywhere; they only tighten.

**Not supported:** hook types `prompt`, `agent` and `mcp_tool` (skipped),
hooks in skill or agent frontmatter, the events pi has no moment for
(PermissionRequest, PostToolBatch, the task, worktree, file and model-switch
events, InstructionsLoaded, ConfigChange), `asyncRewake`, SSE and WebSocket
MCP servers, `paths:`-scoped rules and lazily loaded subdirectory CLAUDE.md
files, `WebFetch`/`WebSearch` (pi has no such tools), `defaultMode` and
`additionalDirectories`, per-agent models (lets-code serves one), skill
`context: fork`, managed (enterprise) settings, and plugins.

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
<summary><b>Experts</b></summary>

An expert is a subagent with knowledge of its own: standing instructions
(recipes, traps, a report format), a brief template that says what its
caller must tell it, and, where it needs one, a setup. lets-code ships five,
`acceptance-judge`, `expert-builder` and `reverse-engineer` (anywhere),
`termux-device` (on Termux only) and `tester` (Linux and macOS), and you can
add your own (see [Build your own expert](#build-your-own-expert)). They sit behind one tool, `expert`, whose line in the
context names each expert usable here with a few words on what it is for:

```text
expert: these tasks go to the expert named, not done by hand, even quick ones: acceptance-judge (is it done? a change, PR or branch checked against its ticket's acceptance criteria); expert-builder (making or fixing an expert: from docs, a runbook or scripts; its knowledge, brief and routing); reverse-engineer (reverse engineering: what a compiled binary, app, APK, firmware or minified script does); termux-device (phone tasks: apps, files, intents, messages; screen/taps once set up). Actions: list | enable | run
```

(On Linux and macOS `tester (anything on a web app that needs a browser:
Playwright/e2e tests, checking flows or changes, bugs)` takes
`termux-device`'s place.)

The rest comes on demand, from the tool itself:

| Call | What it does |
|---|---|
| `{action: "list"}` | Each expert with its job, its state and its brief template (`name: "<one>"` for one, with a sample call) |
| `{action: "enable", name}` | Asks you, in a yes/no dialog, and runs the setup on yes. The model never enables one by itself; without a UI (`-p`) the call is refused with a note on how you enable it |
| `{action: "run", name, brief}` | Runs it with the brief: `brief` is an object of the template's fields. A missing required field returns the template and nothing runs. Dormant: the enable dialog first. `runs: [{name, brief}, ...]` runs several in parallel |

The templates:

| Expert | Brief (* required) |
|---|---|
| `acceptance-judge` | `criteria`*: the acceptance criteria verbatim (a list, or the ticket's text); `artifact`*: what to judge, the repo path plus a diff, commit, branch, PR or URL; `claim`: what the implementer says was done and how they checked it; `how_to_run`: test, build or start commands, a dev server URL; `constraints`: what must not be run or touched, time limits |
| `expert-builder` | `domain`*: what the new expert is for, in your words; `sources`: docs, repos, a method or scripts to distill; `scope`: `user` (default, your own) or `builtin` (a lets-code contribution on a branch); `name`; `platform`; `constraints`: what it must never do, limits; for builtin, the checkout and whether to push |
| `termux-device` | `goal`*: the user's goal, verbatim; `confirmed`: only after you approved the exact final step it reported (app, recipient, text) |
| `reverse-engineer` | `target`*: absolute path or URL of the artifact; `question`*: what to find out; `purpose`: what the answer is for |
| `tester` | `target`*: the web URL, the app's project path, or the mobile app id or .apk; `platform`: web (default), android or ios; `goal`*: the QA task in the user's words; `how_to_run`: commands that start the app and run the existing tests; `scope`: which pages, journeys or files, how deep; `constraints`: what not to touch, logins or test data, time limits |

A run is a subagent run (same runner, progress, abort, timeout, depth limit
and `LETS_CODE_SUBAGENT_CONCURRENCY`): the child gets the expert's
instructions as its system prompt and the brief as its task, one heading per
field, and its report comes back. Experts are never listed in the
`subagent` tool; calling one there points at `expert`.

**Tester.** `tester` does QA the way
[achilles](https://github.com/civitas-cerebrum/achilles) does it, without
achilles itself: no skills tree, hooks, gates or pipeline. Its method
(journey mapping, test composition, test IDs, selectors, bug discovery,
failure diagnosis, evidence, what a report holds, what done means) is
distilled into the child's instructions and five short references in
`~/.pi/agent/tester/ref/`. Tests are written with the API achilles drives:
[`@civitas-cerebrum/element-interactions`](https://www.npmjs.com/package/@civitas-cerebrum/element-interactions)
(the Steps API over Playwright, selectors in `page-repository.json`) and,
for Android and iOS, `@civitas-cerebrum/element-repository` with
WebdriverIO against an Appium server. Enabling it runs `tester/setup`: the
pinned packages with npm into `~/.pi/agent/tester/runtime` (about 130 MB),
Playwright's chromium unless it is cached, and a mobile check that says
what is missing (Appium and its driver, `adb` with a device or emulator,
`ANDROID_HOME`, Xcode) without installing it. The child sets up a test
project with `tester/bin/e2e-init` (in your project when the brief names
one, else under `tester/work/`) and looks at pages with
`tester/bin/peek.mjs`. You get its report: the tests written, the command
that runs them, pass/fail counts and the findings with their evidence. It
is not offered on Termux: Playwright has no browser for Android, and
Appium needs a host with the Android SDK. For a unit test, a failing
assertion or `npm test`, the model works as usual.

**Acceptance judge.** `acceptance-judge` answers "is it done?" the way
achilles' review roles do (its verifier and reviewers), without achilles:
an independent judge that assumes the claim is wrong until the artifact
shows otherwise. It numbers the criteria, restates each as checkable
conditions, runs the evidence itself (tests whose assertions it has read,
the command with the criterion's input, the URL), and runs a negative
control where it can: the same check against the merge-base, the change
reverted, or the line broken in a scratch copy must fail ("would it pass
if the change did nothing?"). Verdicts are PASS, FAIL or UNVERIFIABLE per
criterion (AMBIGUOUS when a criterion has two readings; the stricter one is
judged), each with the command, exit code, key output lines and file:line;
no PASS without executed evidence. ACCEPT only when every criterion
passes, else REJECT with the smallest list of what is missing, plus what
the claim relies on outside the criteria. It has `read, bash, grep, find,
ls` and no edit or write; `acceptance-judge/bin/scratch-copy` makes the
throwaway copies under the temp dir, and with `MANDATE=true` the `reviewer`
role enforces that. Nothing is installed. For a panel, the model can run
the same brief two or three times with `runs:` (two at a time) and accept
only if every judge does. A plain code review stays with `reviewer`, and
running the tests with the model.

**Dormant until you say yes.** Every expert starts dormant: listed, nothing
installed, nothing else in the context. It is enabled only by you: the
yes/no dialog when the model first runs it (or proposes `enable`), or
`/experts enable <name>`. The yes is remembered in
`~/.pi/agent/lets-code-state.json` under `experts`, and that is when its
setup runs (REA's install). A no is not asked again in that session and is
not remembered. There is one switch for the whole feature, `EXPERTS`
(`--experts` / `--no-experts`, `LETS_CODE_EXPERTS`), and no switch per
expert: with tens of experts a flag each would not scale.

```text
/experts                     list them with their state
/experts enable <name>       enable (and set up) without a dialog; remembered
/experts disable <name>      dormant again; remembered
```

**Many experts.** Each entry in the line is the name and its `use_for`.
Past about a dozen experts the line switches to a compact form, each
`use_for` replaced by the expert's `keywords` (or its first words), and
`list` gives the rest. Measured with the model's tokenizer, the whole
`expert` tool (line, description and parameters) is about 200 tokens with
2 experts, 260 with 6 and 385 with 20.

**Your own.** Any agent file in `~/.pi/agent/agents` with `expert: true`
is one (a project's agent files never are). On top of the usual agent fields
(`description`, `tools`, `thinking`, `role`, `agent_dir`, `skills`,
`append_prompt`, `timeout`, `requires`; see [Subagents](#subagents);
`role: readonly`, or `role: reviewer` for one that runs checks but
changes nothing):

| Field | Meaning |
|---|---|
| `expert` | `true` |
| `use_for` | A few words on the tasks it takes, shown in the always-on line; write what a user would ask for, not what the expert is |
| `keywords` | Two or three words that replace `use_for` in the compact line |
| `job` | One line for `list` (default: `description`) |
| `brief` | The template, one `- name (required): hint` or `- name: hint` item per field (none: one required `task`) |
| `platform` | `termux`, or Node platform names (`linux`, `darwin`); elsewhere it is not listed |
| `setup` | A script under `~/.pi/agent`, run with bash once the expert is enabled and what `agent_dir`, `skills`, `append_prompt` or `requires` names is missing. Progress on stderr, the reason on its last stdout line when it fails |
| `setup_note` | What the setup does, shown in the dialog |

```markdown
---
name: db-expert
description: Answers questions about our Postgres schema and query plans
tools: read, bash
expert: true
use_for: questions about our Postgres schema, queries and plans
keywords: Postgres, SQL
brief:
  - question (required): what to find out
  - query: the SQL in question, verbatim
---
You know our database. Use psql read-only; ...
```

<a id="build-your-own-expert"></a>
**Build your own expert.** Two ways, with the same checks.

*With the builder.* Enable it once (`/experts enable expert-builder`), then
ask: "make me an expert that writes git commit messages from a diff, from
the conventions in CONTRIBUTING.md". The model sends the builder a brief
(`domain`, `sources`, `scope`, ...), and the builder, in its own pi:
1. surveys the experts and agents you have, so the new one takes no one
   else's tasks;
2. designs it: name, `use_for` and `keywords` in your words, a brief of 2
   to 5 fields, the least tools it needs, refs for knowledge only some steps
   need, helpers in `bin/` for command sequences, a setup only if it
   installs something, a platform only if it cannot work elsewhere, and
   rules for anything irreversible or outward;
3. distills the sources into instructions a 27B child follows (imperative,
   pi's tools only) plus `ref/*.md` read on demand;
4. scaffolds the files with `expert-new` and fills them in: your own file
   in `~/.pi/agent/agents/<name>.md`, never with the `# Written by
   lets-code` line, so lets-code never overwrites it;
5. lints them with `expert-lint` (and the entry's token cost);
6. measures routing with `route-check`: 6 prompts that should go to it, 6
   near-misses, one for a neighbouring expert, each in its own print-mode
   session with every expert dormant, stopped at the routing decision;
   it tunes `use_for` once if recall is under 4/6 or a near-miss went to it;
7. reports the files, the lint and routing numbers, and
   `/experts enable <name>`.

It never enables an expert, never runs a setup or installs anything for it,
and writes only under `~/.pi/agent` (or, for `scope: builtin`, in a git
worktree on a new branch; it commits, and pushes or opens a PR only if the
brief says so). A new expert is in `/experts` and runnable at once, and in
the always-on line from the next session.

*By hand.* The same helpers are yours to run (written by lets-code to
`~/.pi/agent/expert-builder/`):

```text
bin/expert-new init <name> --use-for "..." --brief "file (required): the path" [--ref x.md] [--bin tool] [--setup]
bin/expert-lint --user [--tokens] ~/.pi/agent/agents/<name>.md      # --list: what is there already
bin/route-check prompts.txt --expert <name> [--cwd <folder with the files the prompts name>]
bin/expert-new pack <name>       # a built-in's writer function for lets-code; --test: its test
```

`expert-lint` checks what lets-code's parser would reject (a bad name or
brief item, a duplicate field, a path outside `~/.pi/agent`, a bad
`timeout`), what silently breaks (a missing `use_for`, `use_for` over 100
or `keywords` over 40 characters, tools pi does not have, refs the
instructions name but that do not exist, a setup that nothing gates so it
never runs, a helper or setup that fails `bash -n`, npm without
`--ignore-scripts`, `@latest`, `curl | sh`, sudo, scaffold TODOs left), and
what makes it work less well (no `job`, no `keywords`, no tools listed,
refs never named, harness tool names in the instructions, a prompt past
1,500 words, overlap with another expert's `use_for`), and prints the
entry's cost in the always-on line (`--tokens`: the server's tokenizer
from `models.json`; else an estimate). `--user` refuses the lets-code line,
`--builtin` requires it; `tests/run.sh` lints every built-in this way. The
prompts file of `route-check` has one prompt a line: `+ ` should go to
the expert, `- ` should not, `=<other> ` should go to that other expert; it
prints each verdict and recall, false triggers and precision.

The references in `~/.pi/agent/expert-builder/ref/` are the documentation
for both ways: `format.md` (every field, its meaning and limits),
`use-for.md` (routing, and writing the prompts file), `distill.md`
(turning docs, a repo or a method into instructions), `setup.md` (setup,
pinning, helpers, platforms), `safety.md` (irreversible and outward
actions, consent) and `contribute.md` (the checklist for a built-in).

On borealis the builder made `config-convert` ("make me an expert that
converts and validates JSON/YAML/TOML config files") in 7.5 minutes: a
`cfgconv` helper (convert, validate against a schema), a ref of the traps
between the formats, lint clean, routing recall 6/6 and 5/6 with 1 and 2
benign false triggers in 7 (drafting a YAML block, adding a key). Enabled,
it converted a YAML file to TOML in 4 turns.

lets-code writes and updates its own built-ins (files with the
`# Written by lets-code` line). A file of yours by one of those names is
left alone: it is an expert if it says `expert: true`, otherwise a plain
agent of the `subagent` tool. With `EXPERTS=false` nothing is listed (the
expert files stay out of the `subagent` tool too); with subagents off there
are no experts and the launch says so.

**From earlier versions.** `TERMUX=true` / `REA=true` in the config (or a
preset) are no longer switches: the first launch remembers the expert as
enabled, says so in one line, and ignores the key from then on (remove
it). `false`, empty, the `LETS_CODE_TERMUX` / `LETS_CODE_REA` variables and
the `--termux` / `--rea` flags are gone. So is `REA=manual` and the
`/skill:reverse-engineering` skill: a dormant expert already costs only
its entry in the line.

</details>

<details>
<summary><b>Termux device expert</b></summary>

On Android, lets-code runs in Termux, and the model can reach the phone
itself through Android's `am`. Doing that reliably takes device knowledge a
model guesses wrong (which `am` works without root, `--user 0`, why
`termux-open` fails on files in `~`, how to tell a real launch from a
silent failure), so it is the expert `termux-device` (see
[Experts](#experts)): "open this PDF", "bring Spotify to the front", "send
Taha on WhatsApp that I'm late" go to
`expert({action: "run", name: "termux-device", brief: {goal}})` with the
user's goal verbatim, and the agent reports each command with its exit
code and how far the result is verified. The first run asks you to enable
it (remembered), or `/experts enable termux-device`.

**Tiers.** A non-rooted Termux cannot see the screen or inject input:
`screencap`, `uiautomator dump`, `input`, `content query` and `dumpsys`
all fail for its uid. So the expert starts every task with
`~/.pi/agent/termux/bin/probe` (read-only, about 3 s), uses the best tier
present, and when the goal needs a missing one it does what it can and
tells you the setup step below.

| Tier | Needs | Gives |
|---|---|---|
| 0 intents | nothing | launch apps, open files, deep links; pre-filled messages: WhatsApp's "Send to..." picker with your text (no number needed), a chat with the text (with a number), SMS, mail compose, the share sheet. You tap Send |
| 1 Termux:API | the Termux:API app + `pkg install termux-api` | contacts (name to number), clipboard, dialogs on the phone, notification list, SMS. No screen |
| 2 shell | Shizuku + `rish`, or adb to the phone itself | the screen as text, taps, typing, keys, swipes |

Setup, done by you (the expert never installs, changes settings or enables
debugging; it gives you these steps):

- **Tier 1, Termux:API.** Install the app from the *same source as Termux*
  (`echo $TERMUX_APK_RELEASE`: GITHUB means
  [its GitHub releases](https://github.com/termux/termux-api/releases),
  F_DROID F-Droid, GOOGLE_PLAY_STORE Play; mixed signing keys do not
  work), then `pkg install termux-api`. Each permission (Contacts, SMS) is
  asked on first use. Trade-off: everything that runs in Termux can use
  what you grant. Note: with the commands installed but the app missing,
  `termux-*` calls hang; the probe says so.
- **Tier 2, Shizuku + rish (recommended).** Install
  [Shizuku](https://github.com/RikkaApps/Shizuku/releases) (or from Play).
  Enable Developer options (tap Build number 7 times) and Wireless
  debugging (needs Wi-Fi). In Shizuku: Start via Wireless debugging >
  Pairing, then in Wireless debugging "Pair device with pairing code" and
  type the code into Shizuku's notification; Start. Then Shizuku > Use
  Shizuku in terminal apps > Export files (e.g. to `Download/shizuku`), and
  in Termux:
  ```sh
  cp /sdcard/Download/shizuku/rish /sdcard/Download/shizuku/rish_shizuku.dex $PREFIX/bin/
  sed -i 's/"PKG"/"com.termux"/' $PREFIX/bin/rish
  chmod 700 $PREFIX/bin/rish && chmod 400 $PREFIX/bin/rish_shizuku.dex
  rish -c id    # allow Termux in Shizuku's prompt; prints uid=2000(shell)
  ```
  Wireless debugging can then be turned off; Shizuku runs until reboot
  (after one: Wireless debugging on, Shizuku > Start, no new pairing).
  Wi-Fi changes do not stop it.
- **Tier 2, adb, no extra app.** `pkg install android-tools`; Wireless
  debugging on; with Settings and Termux in split screen, "Pair device
  with pairing code" and `adb pair localhost:<pairing port> <code>`, then
  `adb connect localhost:<port>` with the port the Wireless debugging
  screen shows. The port changes whenever Wireless debugging restarts
  (reboot, Wi-Fi change): `adb connect` again (`adb mdns services` shows
  it); it must stay on while used.

Trade-off of tier 2 either way: anything running in Termux gets shell
rights (read any screen, tap anywhere, install apps, grant permissions)
while the channel is up. adb also keeps adbd listening on the Wi-Fi
network while Wireless debugging is on (paired keys only). Shizuku is the
better fit for a phone used on its own: one start per boot, Wireless
debugging off afterwards, and you can revoke Termux in Shizuku.
Accessibility-service automation apps are not used: they see every
screen, and no reliable open-source one talks to Termux.

**Screen.** With tier 2, `~/.pi/agent/termux/bin/ui dump [<word>]` prints
the screen as one line per useful node (text, description, id, center,
clickable/editable) instead of raw XML; `ui tap <text>|--id|--desc|<x y>`
taps (several matches: it lists them and taps nothing), `ui type`
(ASCII; other text goes through a pre-fill intent or the clipboard),
`ui key`, `ui swipe`; the expert re-dumps after each action to verify.
A screenshot (`ui shot`) is the last resort.

**Consent.** Sending, calling, posting, paying and deleting are the
user's: the expert prepares everything up to the final button (a pre-fill,
or the chat open with the text in the box) and reports
`awaiting-confirmation` with the app, recipient and text. The calling
agent asks you; only a re-run whose brief has `confirmed` taps Send (and
`ui tap` refuses a Send/Call/Pay-like target without `--confirmed`). At
tiers 0 and 1 you tap Send yourself. It reads only what the task needs
from the screen and does not copy chats or contacts into its report.

It may launch apps, open files (copied to `/sdcard/Download`, since other
apps cannot read Termux's home) and run read-only checks; it never
installs, changes settings, force-stops, deletes or reboots, and recommends
the command instead. lets-code writes `~/.pi/agent/agents/termux-device.md`
and `~/.pi/agent/termux/` (`bin/`: probe, ui, uitext.py; `ref/`: tiers,
screen, messaging, read on demand) on every launch on Termux and keeps
them current; elsewhere it is not listed. A file of yours by that name
(without the `# Written by lets-code` line) is left alone.

</details>

<details>
<summary><b>REA (reverse engineering)</b></summary>

[REA](https://github.com/morluto/rea) inspects shipped software: native
binaries (with Ghidra, IDA or Hopper), Electron and JavaScript apps, .NET,
APKs, firmware and websites. It is one MCP server with about 170 tools,
roughly 65k tokens of schemas even in its compact profile, too much to keep
next to a local model's context. So lets-code never registers it in your
session: it is the expert `reverse-engineer` (see [Experts](#experts)),
whose entry in the `expert` line is all that sits in the context.
`expert({action: "run", name: "reverse-engineer", brief: {target, question,
purpose}})` (or several in `runs: [...]`) runs it with progress and in
parallel, stopped after an hour. The first run asks you to enable it and
then installs REA, with progress, in the running session; the answer is
remembered, and later launches keep the install current.

lets-code writes `~/.pi/agent/agents/reverse-engineer.md` and keeps it
current. A file of yours by that name (without the `# Written by lets-code`
line) is left alone.

The child is a fresh pi with its own agent dir, `~/.pi/agent/rea/agent`.
That dir links your models, auth, settings and extensions, so the child
uses the same server and guards, but its `mcp.json` holds only REA, and
REA's own skill loads there. The child works through REA's tools in
codemode and returns a short Answer / Evidence / Unknowns report; nothing
else reaches your session.

REA is pinned (`REA_VERSION` in the script) and installed with npm into
`~/.pi/agent/rea/runtime` by `~/.pi/agent/rea/setup` when you enable it,
about 160 MB. Native analysis needs an engine: add `GHIDRA_INSTALL_DIR` (or
REA's IDA/Hopper variables) to the `env` of the `rea` entry in
`~/.pi/agent/rea/agent/mcp.json`; lets-code keeps that env when it rewrites
the file. The REA server runs outside the bash sandbox with your user's
rights, and mandate modes that deny MCP (`plan`, `readonly`) deny it in the
child too.

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
| Model does not see images, or does not think | The launch banner says `sees images` and `thinking <level>` when they are on (`--verbose` shows each probe). Pin `VISION=true` / `REASONING=true` if a probe was inconclusive. |
| pi says provider `lets-code` is unknown | Re-run `lets-code`; it re-registers on every launch. |
| `sandbox: not active` on the launch line | Install `bubblewrap` and `socat` (Linux), or run the `npm install` the message names. |
| A call was refused with `mandate(...)` | The current mode forbids it. `/mode auto` lifts the rails for the session, or tighten/loosen the role in `~/.pi/agent/mandate.json`. |

</details>

## Under the hood

Each launch probes the endpoints, reads `/v1/models`, runs the thinking and
vision probes, then writes pi's `models.json` and `settings.json` under the
provider id `lets-code`. Your other providers and settings are untouched.
Everything lets-code adds to pi is one extension,
`~/.pi/agent/extensions/lets-code/`, listed once as `lets-code` in pi's
startup `[Extensions]`: an `index.ts` that loads one module per feature
(`footer.ts`, `agent-guard.ts`, `git-guard.ts`, `memory-guard.ts`,
`grounding.ts`, `backend.ts`, `session-tag.ts`, `mandate.ts`,
`subagents.ts`, `experts.ts`, `claude-code.ts`, and `sandbox/` with its npm runtime). A module is written
when its feature is on and stays inert while it is off; one that fails to
load is reported by name and the others still run. The per-feature
directories (`footer/`, `agent-guard/`, ...) and `lets-code-*.ts` files
earlier versions wrote are moved in on the next launch; only files lets-code
wrote are touched. If you have an extension of your own called `lets-code`,
lets-code uses `lets-code-ext/` instead. The banner's extension count is
lets-code's features on this launch plus your own extensions.
pi's file-search helpers (`fd`, `ripgrep`) are fetched before the first
start so the first session starts clean. Design notes and the reasoning
behind each decision are in [DESIGN.md](DESIGN.md).

`tests/run.sh` runs the suite CI runs on every pull request: shell tests
for the probes, endpoint parsing, the chat-template effort probe and the
OpenRouter config, the move into the one extension, node tests for that
extension's index, the git guard, checkpoints, agent guard, mandate,
subagents, experts (and a lint of every built-in expert with the expert
builder's `expert-lint`), the Claude Code adapter and sandbox config. `tests/mem-guard-live.sh` is a tmux-driven end-to-end run for
the memory guard. Releases are published to npm from GitHub releases.

## License

MIT
