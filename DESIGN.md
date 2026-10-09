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
so the default setup behaves exactly as before. Each is a pi extension
written like the guards, inert without its `LETS_CODE_*_ON` variable.

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

**Sandbox.** The example extension's shape: `createBashTool(cwd,
{operations})` with commands wrapped by `SandboxManager.wrapWithSandbox`,
`user_bash` too. The runtime is a directory extension with its own
`package.json`; lets-code pins the version and runs `npm install` when the
installed one differs. Config merge: defaults, `~/.pi/agent/extensions/
sandbox.json`, `.pi/sandbox.json`, then the active role (`network: off`
empties the allowlist, `sandbox` overrides, `bypass` disables). Runtime and
pi are imported lazily so the extension loads, warns and leaves bash alone
when they are missing.

**MCP.** Nothing to build: pi's `builtin:mcp` reads `~/.pi/agent/mcp.json`
and `.pi/mcp.json`. Setup imports `mcpServers` entries from the standard
files of other clients without overwriting names pi already has.

## Script layout

The script is one file, built in order: header and logging; probing
(`probe`, `probe_thinking`, `probe_vision`, `suggested_thinking_level`);
the pi config writer (`pi_write_configs`, python3); harness gate, pi
install and tool prefetch (`ensure_pi`, `ensure_pi_tools`); onboarding
(`run_setup`); the memory guard (`mem_guard_plan`, `mem_guard_exec`, the
extension source); the git guard (launch logic and extension source); the
agent guard extension source; the
optional features (`pi_write_mandate_extension`,
`pi_write_subagent_extension`, `write_default_agents`,
`pi_write_sandbox_extension`, `mcp_import`, `mandate_init`); main.

Portability: bash 3.2 (macOS) has no `pipefail` without a guard, cannot
parse a `case` pattern inside `$(...)`, and `"${array[@]}"` on an empty
array trips `set -u`, so the final `exec` is an if/else.

## Roadmap

`--harness deepseek` (`@deepseek-ai/dsh`, YAML config) and
`--harness codex` (`@openai/codex`, TOML config with `model_providers`) would
each own a config slice the way the pi adapter does. Both fail loudly today.
