# Design

lets-code onboards a user, probes a self-hosted LLM endpoint, registers the
model with the pi coding agent so the server window can never overflow, and
starts pi with guards against the mistakes a small model makes. It is one
bash script; pi is the only harness today, `--harness` exists for others.

## Invariants

1. **Fixed provider id.** lets-code owns exactly two slices of pi's state,
   `providers["lets-code"]` in `models.json` and the `lets-code/<model>`
   entries in `settings.json`. Both are re-upserted on every launch; every
   other key is preserved. Writes are tmp+rename; a corrupt file fails loudly.
2. **The token never lands on disk.** `apiKey` is the literal
   `$LETS_CODE_TOKEN`, which pi resolves from the environment at runtime.
3. **Overflow is impossible by construction.** `contextWindow` is the full
   discovered length and `compaction.modelOverrides[…].reserveTokens` is the
   output cap, so pi compacts before `input + max_tokens` can exceed the
   window. pi's thinking budget never exceeds `maxTokens`, and vLLM's hard
   `thinking_token_budget` bounds the thinking section engine-side.
4. **No default hijacking.** `exec pi --provider lets-code --model <id>`;
   pi's global default provider and model are not written.
5. **Permissive probe, strict launch.** Every fallback endpoint is probed
   with TLS verification off, so a LAN entry with a private cert is not
   skipped; the winning https endpoint is then checked strictly.
6. **A runaway command cannot take the machine down**, and **a wrong git
   command cannot destroy work.** See the guards below.

## What is written to pi

| Input | Resolved from | Written |
|---|---|---|
| endpoint | `--url` > `ENDPOINTS`, first reachable | `baseUrl`: `<base>/v1` for OpenAI dialects, bare for others |
| model | `--model` > `MODEL` > `/v1/models` | `models[0].id`, the settings key |
| context | `--context` > `CONTEXT` > `max_model_len` > 128000 | `contextWindow` |
| output cap | `--output-cap` > `OUTPUT_CAP` > 32768 | `maxTokens`, `reserveTokens` |
| api | `--api` > `API` > `openai-completions` | `api` |
| thinking | `REASONING` pin > probe: one `chat/completions` with `enable_thinking: true`; reasoning tokens, a reasoning stream or think markers mean yes | `reasoning: true`, `compat.thinkingFormat: chat-template` with `enable_thinking` and `thinking_budget` template variables, `compat.supportsThinkingTokenBudget`; `modelThinkingLevels[lets-code/<model>]` = startup level |
| template effort | vLLM `/tokenize` renders the prompt with and without each candidate `reasoning_effort` value; a template that reacts gets the mapping (`TEMPLATE_EFFORT=off` skips) | `compat.chatTemplateKwargs.reasoning_effort` as a `thinking.level` template variable, `thinkingLevelMap` from pi's levels to the accepted values |
| vision | `--vision`/`--no-vision` > `VISION` pin > probe: one `chat/completions` with a 64×64 red PNG and "what color is this?"; "red" means yes, an image/multimodal error or "I cannot see images" means no, else inconclusive (setup asks, launch assumes no) | `input: ["text","image"]` or `["text"]` |
| telemetry | pi's own `enableInstallTelemetry` | `false` when the key is absent; an explicit value is kept |

`compat: {supportsDeveloperRole: false, supportsReasoningEffort: false}` is
always written (needed by vLLM and SGLang, harmless elsewhere).
`PI_SKIP_VERSION_CHECK=1` is exported so air-gapped networks do not wait on
pi's update check. `fd` and `ripgrep` are fetched before the first launch
through pi's own downloader (`dist/utils/tools-manager.js`) so the TUI does
not print download notices; the step is skipped under `PI_OFFLINE` and
never fatal.

The suggested thinking level at setup is the largest of pi's published
budgets (1k, 2k, 8k, 16k) that fits a quarter of the context window and
half of the output cap.

## Memory guard

A pi extension watches free RAM and acts only on processes this session
started: descendants of pi, or members of the `lets-code-<pid>.scope`
systemd user scope the launcher creates. Thresholds: warn at 20 %, block
non-cleanup bash at 10 %, stop the largest process at 5 % (SIGINT, SIGTERM,
SIGKILL), kill it at 2.5 %.

There are no memory caps. An earlier cap-based design (`MemoryMax`,
`ulimit -d`) limited sessions even when the machine had RAM to spare, and
taught three things: the default `OOMPolicy=stop` kills the whole scope
after one OOM kill (so the scope sets `continue`); swap at a cap livelocks
instead of triggering the OOM killer; a scope must not be created inside an
already limited cgroup, because it would escape that limit. The extension
defers to a machine-wide memguard daemon when `/run/memguard` exists.

## Git guard

- **Launch:** a repo whose HEAD is not on a `pi/*` branch gets
  `git switch -c pi/<timestamp>`. A merge, rebase or cherry-pick in progress
  is never switched away from.
- **Hook:** before each edit, write and bash call, `.git/HEAD` is read. Off
  a `pi/*` branch, edits are blocked and only git inspection, `--continue`
  and `--abort`, and a switch to a `pi/*` branch pass. On every branch the
  irreversible commands are refused. The bash call is lexed like a shell:
  quotes, brace expansion, operators, subshells, heredocs (data, unless fed
  to a shell), `sh -c`, `eval`, `env`/`sudo`/`xargs` prefixes, `cd`,
  `git -C`, variables assigned in the same call. A path the lexer cannot
  resolve is refused when it would be written or removed. Aliases and
  unique-prefix abbreviations are resolved first. Calls over 500 simple
  commands are refused rather than judged in part.
- **Checkpoints:** the working tree is committed through a private index
  (`.git/lets-code-checkpoint.index`) under
  `refs/pi-checkpoints/<branch>/<stamp>` before each tool call and,
  debounced, after it. Identical trees are not stored twice; 200 per branch
  are kept; untracked files over 20 MB and untracked sets over 500 MB are
  left out; a repo whose snapshot takes over 2 s is snapshotted in the
  background only. Failures go to `.git/lets-code-checkpoint.log`, never to
  the model.
- **Not covered:** indirection the lexer cannot see, such as a variable
  holding a command or a script on disk. The checkpoints are the backstop.

The guard adds nothing to the prompt or to tool results; a blocked call
gets a reason under 200 characters that names a reversible alternative.

## Agent guard

A pi extension for failure modes measured in a 48-session benchmark (6
tasks, 4 thinking levels, 2 runs each) against a local thinking model: a
bash call that never returns blocked sessions for 19 and 38 minutes; a
thinking section cut at its budget continued as plain-text reasoning until
the output cap and the session ended with nothing done; sessions that had
passed every hidden test refactored for 20+ minutes and one broke a working
solution; a refactor went 4 edits without a test run; the model's thinking
hand-evaluated Python in 58 % of hard-task blocks and blamed its own test
expectations six times as often as its code. Each rule answers one of
these: default bash timeout, continuation of a cut-off reply, wrap-up hint,
test reminder, required executed verification, and the auto thinking level
(off until a struggle signal, back to off when tests pass). Replayed over
the benchmark, no signal fired on easy tasks and every thinking-off session
that thrashed on a hard task tripped one within 1 to 4 minutes.

A hard thinking budget was once a fixed `samplingParams` value (half the
output cap) for every level; Qwen3's template ignores the soft hint, so
low, medium and high were the same configuration. pi's per-level budget is
sent instead, via `compat.supportsThinkingTokenBudget`.
## Optional features

Off unless `lets-code setup full` / `granular` or the config turns them on,
so the default setup behaves exactly as before. Each is a module of the
lets-code pi extension written like the guards, inert without its
`LETS_CODE_*_ON` variable.

**One extension.** pi lists every extension it loads by path, so one
directory per feature showed six to ten names. All modules now live in
`~/.pi/agent/extensions/lets-code/` behind one `index.ts`: pi loads only a
directory's `index.ts` (or what its `package.json` `pi.extensions` names; it
does not recurse), so a module never loads on its own as well (checked in
pi 0.87.1 and 1.0.3). The index imports each present module in pi's former
order (alphabetical), awaits its factory (pi allows async ones) and catches
per module: an import or setup error becomes one `ui.notify(..., "error")`
at `session_start` (stderr without a UI) naming the feature, instead of
pi's `[Extension issues]` naming only `lets-code` and dropping every
feature with it. A pi package was not used: it needs a `packages` entry in
settings and still lists one name per extension it declares. Migration
runs every launch and touches only what lets-code wrote (first line
`// Written by lets-code`); the sandbox directory moves whole so its
`node_modules` is kept.

**Mandate.** A role per session (the mode) or per subagent (`LETS_CODE_ROLE`
from the agent file). Decisions are made in `tool_call`: tool allowlist,
path scopes (symlink-resolved), bash command groups over a small shell lexer
(operators, quotes, `sh -c`, `$(...)`, heredoc bodies as data, env/wrapper
prefixes, redirection targets), MCP by server name, dispatch rights for the
`subagent` tool. `ask` prompts through `ctx.ui.select` (once / session /
deny) and blocks without a UI; denies are one line under 200 characters and
go to a JSONL log. The design is kernel-mandate's manifest idea made cheap
for pi: no role tags in prompts (the role travels in the environment of the
child process lets-code spawns), no multi-paragraph denials, and no second
enforcement layer; the sandbox is the binding boundary. Precedence: built-in
roles, then `~/.pi/agent/mandate.json` (may add roles, change defaults),
then `.pi/mandate.json` (tighten only: intersect lists, move allow → ask →
deny, never bypass; read once the project is trusted). A broken manifest
fails closed to the built-in roles. Mode changes are announced on
`pi.events` (`lets-code:mode`) for the sandbox.

**Subagents.** One `subagent` tool (single / parallel / chain), modelled on
pi's example but with a short schema (the community packages measured 6k
to 8k tokens per turn). Agent files: Markdown + YAML frontmatter in
`~/.pi/agent/agents`, `.pi/agents`, `.agents/agents`. A child is `pi --mode
json -p --no-session --provider lets-code --model <id> [--thinking]
[--tools] --append-system-prompt <file> "Task: ..."` with
`LETS_CODE_SUBAGENT_DEPTH` and `LETS_CODE_ROLE` in its environment, parsed
from `message_end` events; concurrency 2 by default (one GPU); depth 1 (a
child registers no tool, so it pays nothing for it); 50 KB output cap.

**Watching a subagent (`/subagents`).** The runner already reads the
child's JSON stream, so it also keeps a transcript per run: the task, the
assistant messages (thinking, text and tool-call blocks, rebuilt from
`message_update` deltas, then replaced by `message_end`), tool runs from
`tool_execution_*`, retries and compaction as notes, and status, tokens and
the parent tool call. The registry lives on `globalThis`, so the copies of
`subagents.ts` that the experts and Claude Code modules import share it,
and `/reload` keeps it. It is saved under `lets-code-runs/<session>/` so
finished runs reopen. We did not let the child write a real pi session
instead (dropping `--no-session`). A session file gets whole messages only
at `message_end`, so the view would not stream. It would also fill pi's
session store, and full tool outputs would go uncapped. Faithfulness comes
from rendering: the view feeds the recorded messages to pi's exported
`UserMessageComponent`, `AssistantMessageComponent` and
`ToolExecutionComponent` (with `create*ToolDefinition` for the built-in
tools' renderers), which are the components the main view uses. A plain
renderer takes over if they fail to load or throw. The UI is one
`ctx.ui.custom` overlay (`width`/`maxHeight` 100%) plus `registerCommand`,
`registerShortcut` and `setStatus`; no pi internals are touched. Zero
context: no tool text, prompt section or message changes. The provider
request was compared byte for byte with and without the feature. Steering
a child would need `--mode rpc` instead of `-p`; that is left for later.

**Sandbox.** The example extension's shape: `createBashTool(cwd,
{operations})` with commands wrapped by `SandboxManager.wrapWithSandbox`,
`user_bash` too. The module is a directory (`lets-code/sandbox/`) with its
own `package.json`, not a `pi` manifest, so pi does not load it directly; lets-code pins the version and runs `npm install` when the
installed one differs. Config merge: defaults, `~/.pi/agent/extensions/
sandbox.json`, `.pi/sandbox.json`, then the active role (`network: off`
empties the allowlist, `sandbox` overrides, `bypass` disables). Runtime and
pi are imported lazily so the extension loads, warns and leaves bash alone
when they are missing.

**MCP.** Nothing to build: pi's `builtin:mcp` reads `~/.pi/agent/mcp.json`
and `.pi/mcp.json`. Setup imports `mcpServers` entries from the standard
files of other clients without overwriting names pi already has.

**REA.** The case MCP cannot cover cheaply: REA's 170 tools and 14 KB skill.
In pi, any server in `mcp.json` adds a `mcp_servers` prompt line, turns on
codemode and spawns the server in every session, and pi reads only the user
and project `mcp.json`. So REA lives only in a child: the expert
`reverse-engineer` (`agents/reverse-engineer.md`, written by lets-code) runs
`pi` with `PI_CODING_AGENT_DIR=~/.pi/agent/rea/agent`: symlinks to every
entry of the main agent dir except `mcp.json`, `mcp-auth.json`, `skills`
and `sessions`, plus its own `mcp.json` with REA alone (compact schemas,
user env kept). Agent files may name an `agent_dir`, `skills`, an
`append_prompt` file, a `timeout` and a `requires` path, all checked
lexically to stay under the agent dir (or a trusted project). The child
inherits the `LETS_CODE_*` environment, so the same provider, guards and
mandate role apply; `LETS_CODE_SUBAGENT_DEPTH` + 1 keeps the subagent tool
out of it. The package is pinned and npm-installed by `rea/setup` when the
user enables the expert; output is capped at 50 KB like a subagent's. The
skill earlier versions used without subagents (and `REA=manual`) is gone:
a dormant expert costs only its entry in the expert line.

**Experts.** Some subagents are only useful with knowledge a model
guesses wrong (the Termux `am` that passes the uid check, REA's setup), and
only useful when the caller says the right things (the user's goal
verbatim; the artifact, the question, what the answer is for). Four
choices follow.

*Always known, short:* one tool whose line names the experts usable on this
machine, each with a few-word `use_for`, and the three actions; jobs,
states and templates come from `list`. Names alone were tried first and
failed: asked to bring an app to the front, the model ran `am` itself
(about 400k tokens) next to a tool listing `termux-device`. The entry is
kept to the name and a few words because there may be tens of experts:
past 900 characters the line switches to each expert's `keywords` (or the
first words of `use_for`), so the whole tool stays under 400 tokens at 20
experts (200 at 2, 260 at 6, 385 at 20; vLLM's tokenizer). A platform check
keeps `termux-device` out of a Linux session. A routing test in print mode
(prompts that should go to an expert without naming it, near-misses such
as "list files in Downloads" or "explain what am start does", and
unrelated ones) found termux-device 6 of 6 and no false trigger in 15;
reverse-engineer took the questions that need it and left one-command ones
(`--version`, `ldd`, `file`) to the model, which is the cheaper answer.
Saying "even quick ones" in the line raised it from 1 to 2-3 of 6 with
no new false triggers.

*A dispatch rule where the line is not enough:* a phone session still did
phone work by hand. Asked "launch email app" after an earlier turn in the
shell, it grepped package names, missed Gmail (`com.google.android.gm`) and
said no mail app was installed. An expert may carry a `dispatch_rule`, one
imperative line (up to 300 characters) that goes into the system prompt
while the expert is usable. termux-device's names the trigger: acting on
the phone or reading its state goes to it with the whole goal, and the
model's own commands only check the result. That costs 77 tokens per
request on Termux and nothing elsewhere. route-check with Termux
simulated (16 prompts: 7 phone tasks including the incident's wording, 6
near-misses such as "find my email in my dotfiles", 3 for the other
experts) went from recall 5/7 to 6/7, with no false trigger before or
after and the other experts' 3 of 3 kept. Adding "account or email
address" to the rule got 7/7, but pulled the dotfiles near-miss to the
expert and lost a neighbour, so that wording was not kept.

*Dormant until the user says yes:* an expert can install things (REA: npm,
160 MB) and run commands on a device, so only the user enables it, through
`ctx.ui.confirm` the first time a run needs it (or the model proposes
`enable`) or `/experts enable`; the model cannot, and without a UI the call
is refused with the way to do it. The yes is remembered
(`lets-code-state.json`, merge-safe like the thinking level and the trust
answer), a no only for the session. There is one switch for the feature
and none per expert: a flag and a config key per expert would not scale
past a handful. The old per-expert keys (`TERMUX=true`, `REA=true`) are
migrated once into the remembered state and then ignored.

*Templates:* a brief is an object of named fields, checked before anything
runs (a missing required field returns the template, so a bad brief costs
one short round trip instead of a wasted child), and rendered as one
heading per field in the child's task.

*One file per expert:* metadata lives in the agent file's frontmatter
(`expert`, `use_for`, `keywords`, `job`, `brief`, `platform`, `setup`,
`setup_note`), so a user's own is written the same way; `requires` and
friends make a dormant expert "not set up" instead of hiding it, and
`setup` is a script (REA's `rea/setup`, which later launches run too to
keep an enabled one current). A run goes through the subagents module's
`runAgent`, so progress, abort, timeouts, depth and concurrency are the
same. Expert files are never listed in the `subagent` tool, whose
description lists agents with their jobs, so nothing is listed twice; a
call there is pointed at the expert tool.

**Tester (achilles' method, not achilles).** achilles is a QA
methodology for Claude Code: 24 skills of 8 to 95 KB, about 50 hooks that
gate an 8-phase pipeline, ledgers, reviewer subagents and a role kernel,
plus a pi adapter on a branch. Its harness assumes a frontier model that
can afford the reading and the gates; for a 27B child it would be context
and ceremony. What carries over is the method and the API underneath. So
`tester` ships the method as about 5,000 words a 27B can follow (a
550-word prompt, and references read per step: Steps API, mobile, order
of work and done criteria, composition, bugs and diagnosis), distilled
from achilles main @ 6384b5f with every harness, hook, ledger, schema and
Claude Code tool name taken out and mapped onto pi's seven tools. The
API is installed pinned, like REA's package: element-interactions 0.3.9,
element-repository 0.3.2, @playwright/test 1.64.1 and webdriverio 9.32.0
(element-repository's peer range is ^9.27). Two helpers replace what the
harness and achilles' browser CLI did: `e2e-init` (a test project from
the pins, installed from npm's cache that setup warmed, never overwriting
a file) and `peek.mjs` (URL, status, title, ARIA snapshot, console errors,
failed requests, screenshot: the selector source). Mobile: the Steps API
is Playwright-only and achilles' own lifecycle is web-only ("mobile
support is on the roadmap"), but element-repository resolves the same
named elements on Android and iOS through WebdriverIO, so mobile tests use
it directly; `mobile-check` reports what is missing instead of installing
an Appium stack. No agent dir: the child needs only its prompt and pi's
tools. `platform: linux, darwin` keeps it off Termux (Node says `android`
there), where Playwright has no browser.

**Acceptance judge (achilles' review roles, not achilles).** achilles
reviews work with gate roles inside its pipeline: a `workflow-reviewer`
(no shell) that turns a phase's exit criteria into a yes/no checklist with
evidence and a surgical fix per miss, a `task-reviewer` and an independent
`verifier` in the role kernel's change loop (only the verifier, which
neither wrote nor reviewed the change, may mark it complete), Stage B
reviewers that are fresh subagents with no stake in the work, the evidence
floor of failure diagnosis, and the negative control of ticket-driven
testing (the merge-base is the control; a test that also passes there
tests something already true). What carries over to a 27B child is the
criteria, not the gates: assume the claim is wrong, re-derive from the
artifact, per criterion a check that was executed and a control that must
fail, PASS / FAIL / UNVERIFIABLE with quoted evidence, no PASS from reading
alone, ACCEPT only when all pass, and never edit the work (separation of
duties). It ships as a 700-word prompt and two references read per step
(criteria into checks and the evidence ladder with test traps; negative
controls per kind of check), from achilles main @ 6384b5f and the review
roles of `release/0.2.0` @ d85fb1f and `contrib/achilles-lessons` @ 90e62c4.
Achilles' verifier may run only the test runner, which is too narrow for
an arbitrary project, and lets-code's `readonly` role denies test runners,
so the judge runs under a new built-in role, `reviewer`: any command, writes
only under the temp dir, no git writes, installs, recursive deletes or remote
shells. The starter `reviewer` agent moved to it from `readonly`, which
refused the tests its instructions ask it to run: one role for every agent
that judges work without changing it. A user's global role of that name
merges over it field by field, as for every built-in, so a manifest written
before it existed keeps what it set. The mandate is off by default, so the instructions and
`scratch-copy` (a copy of the work or of a revision as its own git repo,
dependencies linked, never touching the original) carry it there. No
setup and no platform limit: it needs only pi's tools. A panel is the
existing `runs:` with the same brief repeated; a `judges: N` field that
the runner expands and aggregates would be cleaner for the model but is
left for later, since it changes the generic runner for one expert.

**Expert builder.** Adding an expert had become a recipe followed by
hand four times (termux-device, reverse-engineer, tester,
acceptance-judge): frontmatter that lets-code's parser accepts, a few-word
`use_for` that routes, instructions a 27B child follows, refs read on
demand, a pinned setup with `--ignore-scripts`, a writer and its test, and
a routing measurement in print mode. `expert-builder` ships that recipe as
an expert, plus its tools as files the user can run alone. `expert-lint`
re-implements the parser's rules (same regexes as `parseAgentFile`;
`tests/expert-lint.test.mjs` checks the two agree on the same fixtures)
because the subagents module cannot be imported outside pi (typebox comes
from the host), and adds the checks for what fails silently: a setup with
nothing gating it never runs, a `use_for` past 100 characters is cut, a ref
the instructions never name is never read. CI lints every built-in with it
(they passed with warnings only: no `job` on termux-device, no `tools` on
reverse-engineer, a 401-character job on acceptance-judge); REA's setup was
the one that ran npm without `--ignore-scripts`, and now does not (no
package in its tree has install scripts). `route-check` is PR #38's and
#41's method as a script: one print-mode session per prompt in a scratch
copy of the agent dir (no state file, so every expert is dormant; no
sessions or installs), lets-code's own session variables scrubbed so the
nested session is a top-level one (`LETS_CODE_SUBAGENT_DEPTH` would
otherwise hide the expert tool), stopped at the first `expert` run/enable,
`subagent`, `write`/`edit` or 8 own tool calls, so no expert or task runs.
lets-code exports `LETS_CODE_LAUNCHER` so the helper starts the same
launcher. The builder's own `use_for` was measured the same way (13
prompts, fixtures for the files the prompts name): recall 4/6 with either
wording, no false trigger in 14 near-miss runs; the misses were "fix my
expert's routing" and "a built-in on a branch", which the model began
itself. Prompts that named missing files scored 2/6 before the fixtures
existed, so the prompt now says to create them. Its entry costs 25 tokens
in the line (97 to 122 on Linux, vLLM's tokenizer). A user-scope expert is
written without the lets-code line so launches never overwrite it; a
built-in is drafted in `expert-builder/work/draft` (a user's file of that
name would block the built-in) and packed into a writer function by
`expert-new pack`.

**Claude Code adapter.** Automatic: the launcher switches it on only where
the project's `.claude` (up to the git root) has hooks or workflow scripts,
the parts that need the adapter to work at all; skills and commands alone
leave the folder to pi. It then takes that project's `.claude` only. The
user's `~/.claude` is opt-in (`CLAUDE_CODE=all`): taking it everywhere
brought hooks and skills written for Claude Code into every folder, and
claude.ai's synced skills, two copies of each, as pi skill conflicts. The
home folder's `.claude` is never a project. No converted copy, because it
would go stale: every source is read where Claude Code keeps it, at each
start. pi already loads a directory's `AGENTS.md` or `CLAUDE.md`, the
first it finds; the adapter edits `contextFiles` in `before_agent_start`
(the same list every turn, so the prompt never changes mid-session) to add
what Claude reads and pi does not, in Claude's order, imports after the
file that names them. Skills go to pi through `resources_discover`, so pi's
own loader and prompt format apply; commands, skill and workflow names are
`registerCommand`s whose handler expands the template and sends it as the
prompt (in print mode it waits for the run, which ends the process
otherwise). Hooks map onto pi's events one to one where pi has the moment:
`tool_call` (PreToolUse; `updatedInput` mutates `event.input`, translated
from Claude's argument names), `tool_result`, `input` (UserPromptSubmit;
exit 2 returns `handled`), `before_agent_start` (their context as one
custom message beside the prompt, labelled as the user's hook output: an
unlabelled block read as an injection to a grounded model),
`agent_before_settle` (Stop: `continue` with the reason as an entry, at most
8 times per prompt, `stop_hook_active` after the first), `session_*`. Trust
cannot come from pi's `isProjectTrusted()`, which is true for any folder
without `.pi/` resources, so the adapter reads Claude's record, pi's
`trust.json` and its own answer, and hands the decision to subagents
through `LETS_CODE_CLAUDE_TRUST`. Permission rules are judged after the
hooks, on the final input: deny and ask still apply after a hook's allow,
as in Claude Code, and an allow only marks the call
(`globalThis.__letsCodeClaudeApproved`) so the mandate does not ask again;
the guards that run after it are unaffected. Workflow scripts run in a
`node:vm` context, the body wrapped in an async function; each `agent()` is
the subagents module's `runAgent` with a generic worker prompt, behind one
queue of `LETS_CODE_SUBAGENT_CONCURRENCY` slots. The `workflow` tool is
registered only where scripts exist, and its section joins the prompt only
when a prompt matches a script (strict: 0 of 124 real prompts matched five
sample workflows).

## Script layout

The script is one file, built in order: header and logging; probing
(`probe`, `probe_thinking`, `probe_vision`, `suggested_thinking_level`);
the pi config writer (`pi_write_configs`, python3); the one extension's
layout, migration and index (`lc_ext_module`, `lc_migrate_extensions`,
`pi_write_lets_code_extension`); harness gate, pi
install and tool prefetch (`ensure_pi`, `ensure_pi_tools`); onboarding
(`run_setup`); the memory guard (`mem_guard_plan`, `mem_guard_exec`, the
extension source); the git guard (launch logic and extension source); the
agent guard extension source; the
optional features (`pi_write_mandate_extension`,
`pi_write_subagent_extension`, `write_default_agents`,
`pi_write_claudecode_extension`, `claude_code_scan`,
`pi_write_sandbox_extension`, `mcp_import`, `pi_write_rea`, `mandate_init`);
main.

Portability: bash 3.2 (macOS) has no `pipefail` without a guard, cannot
parse a `case` pattern inside `$(...)`, and `"${array[@]}"` on an empty
array trips `set -u`, so the final `exec` is an if/else.

## Roadmap

`--harness deepseek` (`@deepseek-ai/dsh`, YAML config) and
`--harness codex` (`@openai/codex`, TOML config with `model_providers`) would
each own a config slice the way the pi adapter does. Both fail loudly today.
