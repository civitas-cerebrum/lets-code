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

## Script layout

The script is one file, built in order: header and logging; probing
(`probe`, `probe_thinking`, `probe_vision`, `suggested_thinking_level`);
the pi config writer (`pi_write_configs`, python3); harness gate, pi
install and tool prefetch (`ensure_pi`, `ensure_pi_tools`); onboarding
(`run_setup`); the memory guard (`mem_guard_plan`, `mem_guard_exec`, the
extension source); the git guard (launch logic and extension source); main.

Portability: bash 3.2 (macOS) has no `pipefail` without a guard, cannot
parse a `case` pattern inside `$(...)`, and `"${array[@]}"` on an empty
array trips `set -u`, so the final `exec` is an if/else.

## Roadmap

`--harness deepseek` (`@deepseek-ai/dsh`, YAML config) and
`--harness codex` (`@openai/codex`, TOML config with `model_providers`) would
each own a config slice the way the pi adapter does. Both fail loudly today.
