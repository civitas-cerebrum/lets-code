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
2. **The token never lands in pi's files.** `apiKey` is the literal
   `$LETS_CODE_TOKEN`, which pi resolves from the environment at runtime;
   the token itself lives only in lets-code's mode-600 config.
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

For the test reminder and the verification check, an edit counts as a
source change unless the file is documentation or text (`NONCODE_RE`:
md, markdown, rst, txt, org, adoc, tex, csv). Config files (json, yaml,
toml, xml, ini, env, lock files) still count: a `package.json`, a CI
workflow or a `tsconfig.json` can break a build.

A hard thinking budget was once a fixed `samplingParams` value (half the
output cap) for every level; Qwen3's template ignores the soft hint, so
low, medium and high were the same configuration. pi's per-level budget is
sent instead, via `compat.supportsThinkingTokenBudget`.

## Optional features

The mandate, the sandbox and the MCP import are off unless `lets-code setup
full` / `granular` or the config turns them on; subagents, the experts and
the Claude Code adapter (where a project's `.claude` needs it) are on by
default. Each is a module of the lets-code pi extension written like the
guards, inert without its `LETS_CODE_*_ON` variable.

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

**Who approves a run.** The agreed design had the user approve the
criteria, the plan and the result. In use the orchestrator then sent the
user to `/factory resume` (it could not resume a run itself), and the
plan's dialog popped up in the middle of the user's conversation. Now a
run the orchestrator starts through the expert pauses at every checkpoint
and returns it as the tool result: the criteria, the full plan, the
findings of a stuck round, or the result, with the call that goes on
(`resume`, `decision`, `text` for an edit). The orchestrator decides and
asks the user only for a significant design decision; the criteria it
wrote into the ticket are confirmed for it. A run the user starts with
`/factory` keeps the dialogs. A stop records its checkpoint (`stoppedAt`,
or the note of an older ledger), and a resume asks that checkpoint again:
before, `/factory resume` of a stopped run returned at once. The
orchestrator role excludes the `worker` subagent (`"!worker"` in its
dispatch list; a project manifest cannot drop the exclusion): in a live
check it handed a small task to `worker`, which wrote the code into the
user's folder with no review; code now goes through the factory.

**The bricked run.** The next phone run (a computer opponent for a terminal
chess game) used all five fix rounds on one design finding: `.pyc` files
tracked in the change. The engine itself had staged them (`git add -A`
before each review), the developer cannot unstage (no git writes), and a
`.gitignore` does not unstage. The change is now staged afresh from the base
each time (`git read-tree <base>`, then `git add -A` without bytecode,
caches and `node_modules`). Running out of rounds no longer stops the run:
it stays at the stuck checkpoint with final or stop (a stop there could not
be resumed, and the orchestrator's resumes did nothing), and an older ledger
stopped that way is resumed there. A `more` decision's text reaches that
round's developer (the orchestrator had sent exact fix instructions that
were dropped).

**Orchestrator mode.** The software factory's main session plans and
dispatches; experts change the code. That is the `orchestrator` role: plan's
read-only scope (no edit or write, bash read-only, MCP denied) with
dispatch to every agent and a prompt section that says to agree the ticket
with the user, hand each part to the expert for it and fix a blocked run by
sharpening the ticket, never by patching its worktree. Running the tests is
denied too: that is the tester's and the engine's. The factory module
switches the session into it when a run starts or resumes, through a hook
the mandate leaves on `globalThis` (the two modules are loaded separately);
the mode's prompt reaches the model on its next turn, so the run's result
says it as well. It is the main session's role only: a child that would
inherit it (`LETS_CODE_MODE` travels in the environment) gets the default.
The mandate is off by default, so where the experts are on and the mandate
is not, the launcher still writes the module with
`LETS_CODE_ORCHESTRATOR_ON=1`: it enforces nothing and registers only
`/orchestrator` until a run or that command engages the orchestrator, and
goes dormant again when the user leaves it. `--no-mandate` turns that off
as well. Read-only bash had holes that matter once nothing else may write:
`sed -i`, `find -exec`/`-delete`, `fd -x`, `awk` with `system()` or a pipe,
`sort -o`, `git ... --output`, `uniq in out`, `xxd -r`, `tree -o` now count as
writes under every deny-by-default role (plan too); `cd`, `pushd` and
`popd` count as read-only (what follows them is judged on its own).

The first live use (Haiku on the phone, "a simple chess game, start fresh")
never reached a stage: `cd` was denied, the factory refused a folder that
was not a repo, the model asked the user to `git init` (the prompt's "a
change you designed line by line is the same thing" read as forbidding
delegated setup), and the subagent's first commit failed because git on the
phone has no identity. So a run now starts a new project itself: a folder
that does not exist or is empty is made a repo, and a repo without a commit
gets an empty first one from the empty tree (index and files untouched); a
folder with files that is not a repo is still refused. The factory's commits
add `-c user.name/user.email` ("lets-code factory") only where `git var`
finds no identity, and change no config. The prompt now says never to ask
the user to run a command, and that setup outside the run's repo goes to a
subagent first.

A replay of that session on borealis (same messages, git without an
identity) then ran end to end in 15 minutes: a new repo, 7 criteria, plan,
build, both reviews with one design fix round, the judge's ACCEPT, and a
commit by "lets-code factory"; 29 tests pass and the game mates. Getting
there found more: Haiku names brief fields its own way (acceptance_criteria,
test_command), so they are read too; it writes remarks into paths and
commands ("/x/chess (empty; becomes a repo)", "make test (the unit
tests)"), so a trailing remark is dropped from the repo path and from a
command that does not parse (`bash -n`), and one that still does not parse
stops the start instead of failing "as before" at regression; the developer
was not told its worktree is the repo the ticket names, and stopped; Claude
Code's own environment lines (the proxy's folder and machine) misled the
model about where it works; and the mandate read heredoc bodies and quoted
text with `>` as redirections (a judge's script comment "-> still" was a
write to `still`) and missed `git -C dir commit` as a git write.

**Subagents.** One `subagent` tool (single / parallel / chain), modelled on
pi's example but with a short schema (the community packages measured 6k
to 8k tokens per turn). Agent files: Markdown + YAML frontmatter in
`~/.pi/agent/agents`, `.pi/agents`, `.agents/agents`. A child is `pi --mode
rpc --session <run>.pi.jsonl --provider lets-code --model <id> [--thinking]
[--tools] --append-system-prompt <file>` sent `"Task: ..."` as its first RPC `prompt` with
`LETS_CODE_SUBAGENT_DEPTH` and `LETS_CODE_ROLE` in its environment, parsed
from `message_end` events; concurrency 2 by default (one GPU); depth 1 (a
child registers no tool, so it pays nothing for it); 50 KB output cap.

**Subagent sessions (`/subagents`).** Each child writes a real pi session
file (`--session`, created empty and 0600 first; pi writes its header into
an empty file) under `lets-code-runs/<session>/`, outside pi's session
store, so `/resume` and `-c` never list it. The footer navigator and
`/subagents <n|name>` switch the TUI into it with the command ctx's
`switchSession`, as `/resume` does, so pi itself draws it. The navigator
is the footer list (a block the footer module draws, or a widget below
the editor without it): `◂ main` and the runs. A terminal input hook
(`onTerminalInput`) gives it the keys on ↓ when pi's editor has its cursor
on its last visual line (`isOnLastVisualLine`, or `isEditorEmpty`) and
neither its history (`historyIndex`) nor its autocomplete
(`isShowingAutocomplete`) has ↓, as Claude Code moves into its tasks
footer; and on alt+s. While the list has them it takes ↑ ↓ enter x esc; ↑
above the first row, esc or any other key give them back (that key goes to
the editor). It acts only while pi's editor is the focused component, so a
selector or a dialog keeps its keys. The arrow sequences are pi-tui's key
matching, so both `ESC [ B` and the application-cursor `ESC O B` that
Termux sends count (tested with the bytes on the phone). Focused, the
selected row is drawn as pi's `SelectList` (the /model list) draws its
own: the whole line in the theme's `accent`, no background and no marker
of its own (the row keeps `◂`, `▸` and its status mark), so it follows
every theme; the keys line is in the accent too; unfocused, the names are dim and nothing is marked selectable. The list has the same height with and without the
keys (its last line is the keys line either way). The hook has no
`switchSession`, so a switch sends the command (`/subagents back`,
`/subagents id:<run>`) with `pi.sendUserMessage(..., {
expandPromptTemplates: true })`, which pi runs as a command; an `input`
hook drops the text should it ever reach the model.

Children are interactive: each is a pi in `--mode rpc` (the `Child`
driver in `subagents.ts`), started with the agent's tools, thinking level,
skills, role (`LETS_CODE_ROLE`), agent dir and instructions (kept in
`<run>.prompt.md`) and `--session` on its file. The call sends the task as
the first `prompt` and returns the last reply when `agent_settled` comes,
so the parent's tool result is what `-p` gave; the requests of the parent
and of the child were compared byte for byte with main through a fake
OpenAI server. The process then rests: in its session the user's prompt is
an RPC `prompt` with `streamingBehavior: "steer"` while it works (what
Enter does while the main session streams; pi's follow-up key cannot be
told apart, because the TUI's own session is idle) or a new turn while it
rests; Esc (a terminal input hook, active only while the child works)
sends `abort`; `!` is the RPC `bash` command, `/model` and the thinking
level `set_model` / `set_thinking_level` (from pi's `model_select` and
`thinking_level_select` events), `/compact` the RPC `compact` (the TUI's
own compaction is cancelled in `session_before_compact`). A child that
rested `LETS_CODE_SUBAGENT_IDLE_S` (300 s) gets its stdin closed (pi's
orderly exit; SIGTERM, then SIGKILL after it); so does every child when
the main session ends (`session_shutdown` other than our own switches and
`/reload`), when its run is pruned, and when pi exits. At rest a child is
`unref`'d, so `lets-code -p` does not wait for it; without a UI it is
stopped after its turn. The next prompt starts it again from `rec.spawn`
(saved in the transcript), on the same session file: same agent config,
also after a restart. Dialogs of the child's extensions arrive as
`extension_ui_request` and are shown with the TUI's `select` / `confirm` /
`input` / `editor`, prefixed with the agent's name (cancelled without a
UI); this replaces the headless answers a `-p` child had.

How live: pi reads a session file once, at the switch, and a child appends
a message only when it is complete. Following the file alone would
therefore show whole messages only, and RPC does not change that: pi
1.0.3's interactive mode draws only its own `AgentSession`'s events, and
`RpcClient` is a programmatic client, not a viewer. So the driver, which
reads the child's event stream anyway, keeps a transcript per run (the
task, assistant messages rebuilt from `message_update` deltas and replaced
at `message_end`, user messages, tool runs from `tool_execution_*`,
retries and compaction as notes; status, tokens, the parent call), and in
a child's session a widget above the editor draws what the file does not
hold yet: the message on its way, running tools and steers not yet taken,
with pi's exported `UserMessageComponent`, `AssistantMessageComponent` and
`ToolExecutionComponent` (with the built-in tools' renderers; a plain
renderer takes over if they fail). Each event the child completes is then
added to the chat in-process: `pi.sendMessage` of a custom message
(`lets-code-subagent-message`, `triggerTurn: false`, so it is appended to
the open session and pi adds it to the chat at once, as it adds a message
in the main session), drawn by a `registerMessageRenderer` renderer with
the same components (their own spacer line dropped: pi's message box puts
one), in order, up to the first event still on its way; the widget leaves
out what was added (and its first spacer: pi puts one above the widgets),
so moving a message from the widget to the chat moves nothing on screen.
The first version reopened the session (`switchSession`) after each
completed message instead; each reopen redrew the whole chat, which made
the view jump on the phone and showed pi's own footer between the reloads.
Now the session is opened only when the user switches; frames taken every
0.5 s while a child streamed showed no jump and no screen clear at 70 and
120 columns. The copy the TUI opens stops before an assistant message
whose tool calls have no results yet (pi would draw them pending and never
hear the end); the rest comes in as above. Matching what the file holds:
user and assistant messages by count, tool calls by `toolCallId`.

Commands in a child's session run in the TUI as in the main session. pi's
own commands that read the open session (`/copy`, `/export`, `/share`,
`/session`) would see the copy without the messages added since it
opened, so a key hook (`onTerminalInput`, Enter) holds them, opens a fresh
copy and submits them again (`tui.handleTerminalInput`); that is the one
reload, and it happens when the user acts. `/name` goes to the child
(`set_session_name`), `/resume` is submitted in the main session (from the
copy, pi would list the runs dir), `/new` is cancelled in
`session_before_switch` and a new main session started instead,
`/fork`/`/clone` are cancelled in `session_before_fork` with a note. A
mandate `/mode` acts on the main session: children register no mode
commands, their role is fixed. `/subagents` alone always opens the navigator:
its argument completions appear only once a letter is typed (pi 0.87 takes
Enter for a highlighted completion, which turned `/subagents ` into a
subcommand).

pi's keys: pi applies its toggles to the chat's components (Ctrl+O calls
`setExpanded` on every expandable message, which pi's custom message
boxes pass to the renderer; Ctrl+T calls `setHideThinkingBlock` only on its
`AssistantMessageComponent`s), so the child's added messages and the live
part read the state themselves: tool output from `ui.getToolsExpanded()`
and pi's per-message expanded flag, hidden thinking from pi's setting
(`pi.getSettings()` on pi 1.0, `settings.json` on 0.87, and the toggle
key itself so the change shows at once). Keys whose effect is the child's
go to the child: Esc (`abort`), the follow-up key (the next prompt is sent
as `followUp`), the dequeue key (`clear_queue`, back into the editor),
copy (the view catches up first). The bindings are read from
`<agent dir>/keybindings.json` over pi's defaults.

One writer: the child process owns its session file, and pi appends to
whatever session it has open (a model or thinking change, a `!` record),
so the TUI opens a copy, `<run>.view.jsonl`, made when the session is
opened; what pi appends to the copy stays there. The agent guard still
skips its thinking-level reset and the Claude Code adapter its
SessionStart/SessionEnd hooks for such a switch. When a turn the user
started in a child ends, its reply goes to the main session as a custom
message (one line of where it comes from, then the reply) with
`triggerTurn: false`, held while another session is open: the model there
is informed without a turn of its own.

Detaching: `switchSession` tears the current session down first, which
aborts the turn in flight, and with it a `subagent`, `expert` or
`workflow` call and its children. The switch sets `reg.switching`; a call
wrapped in `detachable()` treats an abort that comes while it is set as a
detach: its work keeps its own signal, the tool returns a short note at
once (that note is the only text this feature ever puts in context, and
only when the user switches mid-call), and when the runs end their report
is sent to the session the call came from with `pi.sendMessage(...,
{ triggerTurn: true, deliverAs: "followUp" })`, held while another
session is open. A plain abort (Esc) still stops the children.

Switching while the main session works: the teardown above aborts the
turn in flight (the model's reply, a running tool, queued messages, and
pi prints `This operation was aborted`), and pi 0.87 and 1.0 have no
switch that keeps the old session running. So no `switchSession` is made
while the main session works (`agent_start` .. `agent_settled`,
`ctx.isIdle()`, `ctx.hasPendingMessages()`): the child is shown in place.
pi's interactive layout is the same in both versions (`tui.children`:
the document of header, resources and chat, then the pending messages,
the status, the widgets above, the editor, the widgets below, the
footer); the chat container is swapped for a component that draws the
run's completed events with pi's message components (the `Transcript` of
the live widget), the pending and status containers for empty ones. The
main session object is untouched: its turn runs on, writes its session
file and fills its own chat, which comes back on `back`. In place the key
hook keeps the main session's keys off it: Esc stops the child or is
eaten, shift+tab and ctrl+p go to the child's RPC (`cycle_thinking_level`,
`cycle_model`), `!` runs as the child's `bash` command (the `user_bash`
hook refuses it, so nothing lands in the main session), `/thinking
<level>` and `/compact` are passed on, and the commands that read or
change the open session (`IN_PLACE_DEFER`, ctrl+l, ctrl+x) are held with
a note until the main session is idle, then run in the child's real
session. Completed child messages are not added to the main session as
custom messages in place (the view draws them). When the main session is
idle the switch is the real one as before (no turn to abort). If pi's
layout is not as expected the switch is deferred with a note (the last
resort).

The registry lives on `globalThis`, so the copies of `subagents.ts` that
the experts and Claude Code modules import share it, and a switch or
`/reload` (which load the module again) keep it. The footer list
(`/subagents toggle`, saved as `subagentsFooter` in lets-code-state.json)
is a block the footer module draws above its numbers (also on
`globalThis`), or a widget below the editor without that footer. Zero
context: no tool text, prompt section or message changes; the provider
requests of a print-mode run were compared byte for byte against main.

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

**Testing: a lead and its team.** The tester carried two things at once:
a QA discipline (risk, coverage, oracles, evidence, failure diagnosis) and
the browser and mobile tooling it was applied with. Terminal programs and
libraries got neither, the phone had no tester at all, and the factory's
test stage was skipped there. They are separate now. `tester` is the test
lead: the discipline, generalized beyond the browser (test basis and
static review, risk, levels, types, the standard design techniques,
HICCUPPS oracles, bite checks and negative controls, exploratory charters,
failure diagnosis, reporting), with workflows for verifying a change,
writing tests, testing an app, hunting bugs, diagnosing a failing test and
repairing a suite, and its own reach: the project's test framework, CLIs,
and terminal UIs through tmux. `ui-tester` keeps the browser and mobile
tooling and the web journey method (the tester before, renamed; its
runtime and the user's yes move over once). `api-tester` is new: APIs in
depth with curl and jq, no setup.

A lead that starts specialists needs a level a child does not have (a
child cannot start children). The agent file's `team:` key grants it to
that child alone: the subagents module spawns it with
`LETS_CODE_SUBAGENT_MAX_DEPTH` one higher and `LETS_CODE_EXPERT_TEAM`, its
generic `subagent` tool is left out, its experts module lists and runs only
the team (route: false members included), and the specialists, at the new
limit, start nothing. Only a user-level agent file can do this, never a
project's. The mandate's `tester` role is the developer's plus the expert
tool and a dispatch list of the team. The specialists are `route: false`:
the model routes testing to the lead, which keeps one entry in the
always-on line; the line's budget went from 900 to 1000 characters, since
Termux's nine routed experts were just over it. expert-lint knows `team`,
allows the expert tool with it, and no longer warns about overlap with an
expert the model never routes to.

**Tester (achilles' method, not achilles).** (Now `ui-tester`.) achilles is a QA
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

**Developer and reviewers (the factory's stages).** The software factory
runs a ticket through stages that each get a fresh context and a brief
built from artifacts (criteria, plan, diff, earlier findings), never the
transcript. Phase 1 adds the three stages lets-code did not have, built
with the expert-builder's method (drafted in a scratch agent dir, linted,
route-checked, packed with `expert-new pack`). Their final messages are an
interface for a program, so each is fixed: the developer's first line is
`STATUS: PLAN|DONE|BLOCKED`, then fixed headings (changes; tests with exit
codes; `C<n>: covered by <test>`; `<id>: fixed: <how>`); the reviewers'
first line is `VERDICT: APPROVE|REVISE`, REVISE exactly when a blocker or
major is open, then one line per finding (`R<n>` or `D<n> | severity |
file:line | ...`) and `R<n>: FIXED|OPEN` for a re-check. Ids stay stable
across fix rounds, so the engine can see a finding repeat and stop. The
two reviews split by question, not by depth: does the code do what the
criteria say for every input (expert-reviewer: it reproduces suspects with
a script under the temp dir), and does it fit how the codebase already
does things and stay cheap to change (design-reviewer: a finding needs a
convention or a concrete cost; bugs it sees go to a note). Whether the
criteria are met stays with acceptance-judge, which runs negative controls;
the reviewers do not. Both use `reviewer`. The developer needed a role the
built-ins lacked: `auto` lets it write anywhere, `ask` would prompt a child
that has no UI. The new `developer` role has the file tools, writes only
in its working folder and the temp dir (outside is denied, not asked),
and denies git writes (the caller commits after the user's checkpoint),
installs, recursive deletes, sudo and remote shells. The phase-2 engine
runs it with the run's worktree as its working folder (`runAgent`'s cwd).

Routing was measured with route-check on a toy repo (a ticket with four
criteria, an approved plan, a feature branch with seeded bugs), 6 positives,
6 near-misses and 2 or 3 neighbours per expert, thinking low, each file run
twice since one run varied by up to three prompts. The reviewers route at
3 to 5 of 6 with no false trigger in any run and no task taken from another
expert. The developer did not route: 2 of 48 over five wordings, the model
implements tickets itself (writes after a few reads), and with its entry in
the line acceptance-judge's recall fell from 22/24 to 15/24 (its misses
became the model's own checks, not the developer's). So an expert can now
say `route: false`: it stays out of the always-on line and its
dispatch_rule out of the prompt, `list` and `run` are unchanged, and
expert-lint skips its line cost. The developer is the first; the factory
dispatches it by name. With the two reviewers the line grows by 38 tokens
(122 to 160 on Linux, 118 to 156 on Termux, vLLM's tokenizer), 707 and 685
characters, under the 900 where entries shrink to keywords; no dispatch
rule. The bodies (about 750 to 820 tokens each) and the two checklists
(730 and 870) reach only the child.

A live run of each on the toy repo (thinking low, `--mandate`): the expert
reviewer confirmed both seeded bugs (31 days instead of 30, rounding to
nearest instead of down) as blockers with a reproduction each, plus the
missing tests, and said REVISE; the design reviewer flagged the inlined
discount table against the plan's module layout and the missing test
file, and passed both bugs on under Notes; the developer followed the plan
(a new module, one test per criterion, 5 of 5 passing), left the change
uncommitted and reported each criterion's test. The first line came first
in two of three runs once the prompt said nothing may precede it; the
third put one sentence before `VERDICT:`, and finding lines come wrapped
in backticks, so the engine looks for the first `^STATUS:` / `^VERDICT:`
line and strips backticks rather than trusting the first line.

**Software factory (the engine and its expert).** One ticket goes through
stages that each get a fresh context and a brief built from artifacts, so
no stage sees another's transcript and the main session sees one line per
stage. The engine (`factory.ts`) is a state machine over a ledger on disk
(`~/.pi/agent/lets-code-factory/<id>/ledger.json`, written atomically after
every step): intake, plan, build, expert-review, design-review, test,
judge, regression, done, plus `waiting` for one of five checkpoints
(criteria, plan, result, a stuck fix loop, a blocked stage). Briefs are a
pure function of the ledger (`briefFor`), which is what keeps the
conversation out; a test shows every word of every brief across a run
comes from the ledger or the engine's own template text. Replies are
parsed by line, not position: the first `STATUS:` / `VERDICT:` line
anywhere with backticks and bold stripped, finding lines by their id
prefix, the judge's `C<n>: FAIL|UNVERIFIABLE`, and a reply without its
STATUS line by its `## Plan` / `## Changes` heading (the live runs had
both a status line placed last and none at all). Fix rounds send only
blocker and major findings, rerun the stage that failed, and stop at five
or at a finding id the developer was already sent, since a fix that did
not stick will not stick the sixth time either: the user decides. The
regression is the engine running the suite itself and comparing with the
baseline from intake, so a suite that was already red is reported, not
blamed on the change. Each run has its own worktree and branch from the
user's HEAD; the branch is `pi/factory-<id>` because the git guard in the
children refuses edits off `pi/*` branches, and the guard's checkpoints
(`refs/pi-checkpoints`) leave HEAD alone, so the diff is always taken
against the base commit and the approved result becomes one commit from
the base (`write-tree`, `commit-tree`), whatever the children did to the
branch. Without a UI every checkpoint pauses the run; `resumeRun` asks it
again, and a run killed mid-stage reruns that stage.

An expert is a child process, and a child cannot start children, so the
factory cannot be an ordinary expert. The agent file says `runner:
factory`: it keeps the routing entry, the job, the brief and the enable
dialog of every expert, and the experts module, instead of spawning a
child, calls the factory module's `runExpert` in the main session inside
the same `detachable` wrapper, so switching sessions mid-run behaves as for
any expert call. Its body documents the pipeline and is never a prompt; an
unknown runner rejects the file. The stage experts are enabled with one
dialog the first time. The `/factory` command (start, resume, list,
status) costs no context: commands are not in the model's prompt.

Measured while the Qwen server was down, against the Claude proxy
(claude-haiku, thinking low), main and this branch on the same backend:
route-check gave software-factory recall 5/6 and 5/6 with no false trigger
in 18 near-miss and neighbour runs (the miss, "have the developer, both
reviewers and the judge do it", went to developer by name); the existing
experts routed the same within a prompt or two of main, and none of their
prompts went to the factory. Its entry costs 29 tokens of the prompt
(4701 to 4730 on one trivial request, the proxy's usage, Claude's
tokenizer). A live run on a toy signup ticket went through one fix round
(a major expert-review finding: C3 untested through invalid then valid
input), the tester's Playwright tests in Chromium,
the judge and the suite, while the user switched into the running stages
in place and back.

**Core memory.** A memory the harness keeps so a session can find what
earlier ones did without carrying it: one store per project (the nearest
`.git` up from cwd; a worktree's `.git` is a file naming the main
repository, read without a subprocess, so a factory run's worktree and
the user's checkout share one memory and the worktree's paths are read
as the main checkout's; else cwd) and one
global, under `~/.pi/agent/core-memory/`, next to pi's sessions, because
entries point at session files and run records that live there. An entry
is one dated line with a kind, a gist of at most 200 characters and
pointers (`file:line`, `run:<id>`, `factory:<id>`, a session file). The
store is JSONL (`memory.jsonl`, atomic, 600) with an in-memory index from
each pointer to its entries; `memory.md` next to it is rendered from the
store for the user and read back by `#id` when it is newer, so the file is
editable by hand and the parse is never ambiguous (a JSONL line carries
the id, a Markdown line only displays it). Nothing of the store is in the
system prompt: a first design put a budgeted live file there, and was
replaced by one line (the memory exists, how many entries, the last date,
the tool searches it) plus the three newest headlines within 150 tokens,
computed once a session so the prompt stays cacheable; a child session
gets the line only. Measured on Claude
through the proxy (one-shot sessions, the usage counts of the first
request): 5048 input tokens without the feature, 5538 with the line and
the tool, 5664 with three headlines, so 490 for what is always there and
126 for the headlines; the 3.6-characters-a-token estimate says ~60 for
the line and ~275 for the tool, undercounting the schema, which Claude
tokenizes at nearer 3 characters a token. The tool is most of the cost
and the same order as the expert tool's. Retrieval is
the `memory` tool: `search` matches every term against the gist, the
pointers, the kind, a date prefix or the id (no scoring to tune; the store
is hundreds of lines, not thousands); `open` follows a pointer (a file
around its line, `report()` of a factory ledger, a run record's reply, a
session's first message and last reply). The user's view is `/memories`,
a list in pi's selector, the dialog every other feature uses: it draws one
option a line and knows no paging or truncation, so the module cuts each
row (date, kind, gist, a pointer summary) to the terminal width and pages
by fifteen with "N more" rows that move the window; a row opens the entry
with its pointers and the actions (open a pointer, edit the gist, forget),
and esc backs out one level, so the whole thing is two loops over
`ctx.ui.select` and no key handling of its own. The one automatic path is a
lookup in the index after `read`, `edit`, `write`, `grep`, `find`, `ls`
(their `path`) and an `expert` call that resumes a factory run: a hit adds
one trailing line to the tool result naming the count, not the entries.
`bash` is not lexed for paths. Writers: the model's `remember` (with
`by: user` when the user asked, their words as the gist), and the harness
without a model call: `factory.ts` after `advance` ends done or stopped,
`subagents.ts` when a run finishes (a factory stage's run is left to the
factory's entry), and the module itself after the first turn and at
`session_shutdown` for the session pointer; both other modules reach it
through a guarded dynamic import, as factory imports subagents, so a build
without the module loses nothing. Dedupe is by identity pointer (a run,
factory or session file) or by normalised gist, updating in place. Work
and pointer entries untouched for 120 days move to `archive.jsonl` at load
(decisions, facts and preferences stay; searched with `archive: true`). A
child session (`LETS_CODE_SUBAGENT_DEPTH > 0`) reads and may `remember`
but writes no pointers. Not done: the agent guard's wrap-up moment does not
write (the session pointer after the first turn and at shutdown covers
it, and a nudge turn is not a better moment than the end), and entries are
not scored by priority (dates and kinds are enough to archive by).

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

### Researcher

The researcher expert answers open questions from the web, so it needs
what pi does not have: a search and a fetch. Its `bin/web` is one Python
file on the standard library (urllib, html.parser, threads), which runs on
Termux as on Linux; its plain search parses a public HTML search page
(the lite page as a fallback), and the endpoints are environment variables
so the unit test serves fakes on 127.0.0.1.
The method is the information-gathering loop of a staged pipeline,
generalised: plan sub-questions, fan out (all queries in one call, fetches
four at a time), dedupe (a ledger keyed by canonical URL; syndicated
copies count as one source), score sources with a fixed rubric, verify
each claim against two independent sources or one primary source about
itself, tag every claim with source ids, keep vetoes and unknowns honest,
and cache the state (plan, claims, ledger, page text, searches) in a
folder a later run resumes from. Fetched content is the trust boundary:
the helper fences it as untrusted, drops hidden elements and comments,
counts what it dropped and flags instruction-like lines, and the
instructions forbid acting on page text or following its links off the
organisation's own site. robots.txt is read strictly (longest match, a
tie goes to Disallow, `*` and our token both apply, an unreadable policy
allows one plain fetch but no browser-header retry). The role is
`researcher`: the `reviewer` role (network on, writes only under the temp
dir, which is where the state folder lives) plus a `browser-direct`
command group it denies: `playwright`, `playwright-cli`, `@playwright/cli`
and anything naming the runtime, the CLI daemon, Playwright's browser
cache or the profile, so the child reaches the browser only through the
helper's allowlist (with `MANDATE=true`; the helper's own checks apply
either way). Context: its entry adds 23 (160 -> 183 on Linux, by the server's tokenizer) tokens to the
always-on expert line; the child's prompt section is 1043 tokens; the
three refs (939, 737 and 883 tokens) are read on demand. Routing (route-check,
thinking low): recall 11/12 over two runs of 6 positives, and none of 24 near-misses (local-code questions for the model, general or scout, a licence explained from knowledge, a one-line edit, a phone task, unrelated prompts) went to it, precision 100%. The neighbours' prompts it never took; their misses went to the model itself, as on main (a 6-prompt regression file run three times each: tester 6/9 with it, 7/9 without; acceptance-judge 7/9 both).

The browser came after two measurements. The plain HTML search page
rate-limits after a few bursts (a live run lost search after four
queries), and a self-hosted Firecrawl did not fit the dev box (a Pi 5 with
8 GB): about 3 GB idle for its API's ten Node workers, swap full, and
memory limits not enforceable on a kernel booted with memory cgroups off.
The Playwright CLI drives one Chromium for the whole machine instead.
The fetch order is site API or raw files, then a plain fetch, then the
browser, which the helper picks itself (empty, refused, bot wall, login
wall, a JavaScript shell under 200 characters with a script tag, or a
domain in `logged-in-domains`). Safety is enforced in the helper, not
only the prompt: one `pw()` runner allows six CLI commands, `eval` only
of the helper's two extractor functions, and `goto`/`open` only of
http(s) URLs; private hosts are refused for plain and browser fetches
alike (the dev box also runs other browser-control
services on localhost). The CLI writes snapshots and console logs into
its output dir; the helper points that at a private work dir and empties
it after every call, since they hold page text. Logins are by hand
through the CLI's own dashboard (a live screencast with an interactive
mode, bound to 127.0.0.1, reached over an ssh tunnel): `web login` only
runs in a terminal, waits for Enter, then waits 35 s so Chromium writes
its cookies to disk (it does every 30 s; a close right after a login lost
it in testing), and closes the dashboard again. The CLI keeps a session
registry per install, so the dashboard and the helper must use the same
CLI. The setup never fails the expert: on Termux, without npm or when a
download fails it records why and the helper falls back to plain HTTP.

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
`pi_write_core_memory_extension`,
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
