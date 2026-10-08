# lets-code

Run the **pi agentic coding CLI against your own self-hosted LLM** — vLLM,
SGLang, Ollama, LM Studio, OpenRouter, or any OpenAI-compatible server that
exposes `/v1/models`.

One file, no dependencies beyond `bash`, `curl`, `python3` (plus `node`/`npm`
only when it installs pi for you). It probes your endpoints, **auto-discovers
the resident model and its real context window**, registers it with pi —
reserving the output budget in pi's compaction settings so a response can
never overflow the server's window — and launches `pi`. Works on Linux and
stock macOS (bash 3.2).

```
$ lets-code
[lets-code] connecting: http://localhost:8000  harness: pi  model: Qwen/Qwen3-32B  context: 131072  output cap: 32768  api: openai-completions
╭── pi ─────────────────────────────────╮
```

## Quickstart

```bash
# 1. get the script
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/civitas-cerebrum/lets-code/main/lets-code \
     -o ~/.local/bin/lets-code
chmod +x ~/.local/bin/lets-code

# 2. onboarding — asks for your endpoint(s), token, optional CA; saves config;
#    offers to install pi if missing; verifies the server; registers the model
#    with pi; installs itself on PATH
lets-code setup

# 3. go
lets-code              # interactive session
lets-code -p "hello"   # one-shot print mode (all args pass through to pi)
```

Prerequisite: the pi CLI —
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
(Node.js ≥ 22.19.0). If it's missing, `lets-code` offers to install it:
confirm, then install.

## Flags

| Flag | Meaning |
|---|---|
| `--harness <name>` | Harness to launch. v1 implements **pi** (the default); `deepseek`, `claude`, `codex` are roadmap items and fail loudly. |
| `--url <base>` | One-off endpoint override (`/v1` suffix and scheme optional — both are normalized) |
| `--model <id>` | One-off model override |
| `--context <tok>` | Context window (default: discovered from the server) |
| `--output-cap <tok>` | Max output tokens (default 32768) |
| `--api <dialect>` | `openai-completions` (default) \| `openai-responses` \| `anthropic-messages` \| `google-generative-ai` |
| `--vision` \| `--no-vision` | Pin image input on or off for one launch. By default image support is **auto-detected at launch** with a tiny test image (a 64×64 red PNG and "what color is this?"); when the model answers "red" it is registered with `input: ["text","image"]` so pi actually sends images (e.g. screenshots) to it. `VISION=true`/`false` in the config pins it permanently; setup asks you when the probe is inconclusive. |
| `--thinking-level <lvl>` | Startup thinking level: `off`\|`minimal`\|`low`\|`medium`\|`high` (xhigh\|max). Default `medium`. Thinking support itself is **auto-detected at launch** with a minimal test request (pin `REASONING=true`/`false` in the config to override); setup offers a level suggested from your context window. |
| `--insecure` | Skip TLS verification (self-signed certs) |
| `--no-mem-guard` | Launch without the [memory guard](#memory-guard) |
| `--no-git-guard` | Launch without the git guard (see below) |
| `--verbose` \| `--debug` | Show endpoint probing |
| `-h` \| `--help` | Help |

Env overrides: `LETS_CODE_ENDPOINTS` (space-separated), `LETS_CODE_TOKEN`,
`LETS_CODE_CA`, `LETS_CODE_MODEL`, `LETS_CODE_CONTEXT`, `LETS_CODE_OUTPUT_CAP`,
`LETS_CODE_API`, `LETS_CODE_VISION`, `LETS_CODE_THINKING`, `LETS_CODE_REASONING`
(`true`/`false` pins), `LETS_CODE_MEM_GUARD` (`true`/`false`).

## What onboarding sets up

`lets-code setup` walks you through everything and writes
`~/.config/lets-code/config` (mode 600):

| Question | Meaning |
|---|---|
| **Endpoints** | One or more base URLs, most-preferred first. At launch the first reachable one wins — so you can list `http://localhost:8000 https://llm.home.example` and the same script works on the server box, on your LAN, and over your VPN. The scheme is optional: IPs, `localhost`, bare hostnames and `*.local` get `http://`, other domains get `https://` (`192.168.0.10/vllm` → `http://192.168.0.10/vllm`, `llm.home.example` → `https://llm.home.example`). |
| **Token** | Sent as the API key (via `LETS_CODE_TOKEN`, which pi resolves from the environment). vLLM without `--api-key` accepts anything — the default placeholder is fine. |
| **Root CA** | Only for `https` endpoints with a private CA (mkcert, step-ca, …). Node ignores the OS trust store, so the script exports `NODE_EXTRA_CA_CERTS` for you. |

Setup then **registers `lets-code` as a command**:

1. asks where to install — `~/.local/bin` (per-user, default) or
   `/usr/local/bin` (system-wide, via sudo),
2. copies the script there and marks it executable,
3. if `~/.local/bin` isn't on your `PATH`, offers to append
   `export PATH="$HOME/.local/bin:$PATH"` to the right shell profile
   (`~/.zshrc`, `~/.bashrc`, or `~/.bash_profile` on macOS bash),
4. verifies with `command -v lets-code`,
5. and finishes with a live probe that shows the model your server is
   currently serving — probes whether it thinks (a minimal test request
   with thinking forced on), offers a **thinking level** whose suggested
   default follows your context window (largest published pi budget —
   1k/2k/8k/16k — that fits ¼ of the window and ½ of the output cap),
   probes whether it **sees images** (a tiny red test image; if the answer
   is inconclusive setup asks you and pins `VISION=` in the config), and
   registers the model — thinking and image input included — with pi.

After setup (and a shell restart if the PATH line was just added), typing
`lets-code` anywhere just works.

## How the context budget works

pi doesn't recognize self-hosted model names and assumes a **128k** context
window for any model you don't declare. If your server's `max_model_len` is
smaller, long sessions overflow the server. `lets-code` reads
`max_model_len` from `/v1/models` at every launch and writes two things into
pi's config (its own slices, keyed by the fixed provider id `lets-code` —
your other providers and settings are preserved):

- `~/.pi/agent/models.json` → `providers["lets-code"]` with the discovered
  `contextWindow` and the model's `maxTokens` (the output cap, default 32768),
- `~/.pi/agent/settings.json` → `compaction.enabled: true` (auto-compaction
  explicit, not left to pi's implicit default) and
  `compaction.modelOverrides["lets-code/<model>"].reserveTokens` = output cap.
  The same write sets `enableInstallTelemetry: false` when the key is absent:
  pi defaults it to true and pings pi.dev on its first start, lets-code
  defaults it to off. A value you set yourself (either way) is kept.

Before the first launch lets-code also fetches pi's file-search helpers
(`fd` and `ripgrep`) into `~/.pi/agent/bin` through pi's own downloader,
unless they are already on your `PATH` (`fdfind` counts). pi would otherwise
do this itself the first time the TUI starts, printing "fd not found.
Downloading..." / "ripgrep not found. Downloading..." into the session. Set
`PI_OFFLINE=1` to skip the fetch; a failed download is not fatal.

pi auto-compacts once the conversation exceeds `contextWindow - reserveTokens`,
so the output budget is **reserved by construction**: compaction always fires
before the input side can crowd out the response budget, and the overflow-400
that vLLM throws when `input + max_tokens > window` is impossible —
automatically correct even after you swap models. Want longer conversations
over longer responses? Launch with `--output-cap 16384` — the context share
grows to match.

## Memory guard

A coding agent runs whatever commands it writes. One test with an unbounded
search or a leaking build can take all of the machine's RAM. When the same
machine serves the model, you get minutes of swap thrash and then a global
OOM kill that can hit the model server or your desktop. This happened for
real: a pi-run `unittest` reached 26 GB twice on the box serving the model.

On Linux, `lets-code` guards the session by watching the machine's
**remaining RAM**. It only ever acts on **processes this session started**,
never on anything else on the machine:

| Free RAM | What happens |
|---|---|
| < 20 % | pi is warned after each tool call, with the session's largest processes listed |
| < 10 % | pi's new bash commands are blocked, except cleanup (`kill`, `ps`, `free`, …) |
| < 5 % for 3 s | the session's largest process is stopped gracefully: other big session processes are paused, then SIGINT → SIGTERM → SIGKILL (10 s apart), then they're resumed |
| < 2.5 % | the session's largest process is SIGKILLed immediately |

There are no memory caps: nothing is limited until the machine as a whole
runs low. After a stop, pi is told what was stopped and why. A bare
`KeyboardInterrupt` or `Killed` otherwise reads like a bug in the code.

The guard lives in a pi extension that `lets-code` writes
(`~/.pi/agent/extensions/lets-code-memguard.ts`). It is inert in pi sessions
not launched by `lets-code`.
- **What counts as "this session":** descendants of that pi, plus anything
  in the session's systemd user scope (`lets-code-<pid>.scope`, no root
  needed). The scope catches orphaned background jobs.
- **`OOMPolicy=continue`:** the scope sets it, so a kernel OOM kill takes one
  process, not the whole session.
- **Deferral:** when a machine-wide
  [memguard](https://github.com/civitas-cerebrum/memguard) daemon is running
  (`/run/memguard`), the extension defers to it.
- **Off switch:** `--no-mem-guard` or `MEM_GUARD=false`.

`tests/mem-guard-live.sh` runs it end to end: interactive pi in tmux, the
prompt typed in with `send-keys`, leftover memory hogs moved into the
session, levels relative to the RAM free at test start, and an independent
safety cap plus watchdog.

## Git guard

Small self-hosted models make mistakes a frontier model wouldn't: a wrong
`git reset --hard`, an edit that guts a file, a stray `rm`. With `lets-code`,
all work happens on a **`pi/*` branch**, and the commands that would destroy
work irreversibly are refused outright.

- **At launch** (plain shell, zero tokens): if the cwd is a git work tree and
  HEAD is not on a `pi/*` branch, `lets-code` runs
  `git switch -c pi/<YYYYMMDD-HHMM>` (suffixed `-2`, `-3`… if taken).
  Uncommitted changes travel with the switch, so nothing is lost. The launch
  line shows the branch: `git guard: pi/20261005-2204`. A merge, rebase or
  cherry-pick in progress is never switched away from: the guard stays on
  and pi can only inspect, continue or abort until it is done.
- **Rule 1, in the session:** a pi hook
  (`~/.pi/agent/extensions/lets-code-gitguard.ts`) reads `.git/HEAD` before
  each `edit`, `write` and `bash` call. On a `pi/*` branch every call passes;
  a rebase, merge, cherry-pick or bisect **started from** a `pi/*` branch
  counts as that branch, so conflicts can be resolved and `--continue`d. Off
  one (the model ran `git switch main`, detached HEAD, a worktree on another
  branch), edits and writes are blocked, and each simple command of a `bash`
  call must be a plain git inspection (`status|log|diff|show|branch
  -a|stash list|reflog|show-ref|config --get|fetch|…`), a `--continue` /
  `--abort` of the operation in progress, or a switch to a `pi/*` branch.
- **Rule 2, on every branch:** irreversible commands are refused: `git push`
  with `-f`/`--force`/`--delete`/`--mirror`/`--prune`/`+ref`/`:ref` or a
  refspec onto a non-`pi/*` branch; `git branch -D/-f/-M` (`-d`, the safe
  delete, is fine); `reset --hard|--merge`; `checkout` of a path, `.`,
  `--`, `-f`, `-B`, `--patch`; `switch -f|--discard-changes|-C`; `restore`
  of working-tree changes (`--staged` alone is fine); `clean -f/-d/-x`
  (dry runs are fine); `stash drop|clear`; `rm -f` (git's); `tag -d`;
  `fetch` into a local non-`pi/*` branch; `update-ref`; `symbolic-ref`
  writes; `reflog expire`; `gc --prune`; `filter-branch`; `worktree remove
  -f`; `submodule deinit -f`; and `rm`/`mv`/`shred`/`unlink`/`find
  -delete`/`rsync --delete` of `.git`, of the repo top or an ancestor, of
  `~` or `/`, or a glob that matches `.git` or everything where it would
  matter (`*`, `.*`, `.[!.]*`, `.??*` at the repo top; `../*`, `~/*`,
  `/*`). Stale `.git/*.lock` files may be removed. Writes into `.git` by
  any tool are refused. Git's unique-prefix abbreviations (`--har`,
  `--forc`) and aliases (as `git config --get-regexp alias.` resolves them,
  plus `-c alias.x=…`; `!`-shell aliases are lexed) are resolved before the
  check. `checkout --ours|--theirs` is allowed while a merge or rebase is
  in progress, refused otherwise. New branches must be named `pi/*` however
  they are created (`switch -c/--create/-t`, `checkout -b/--orphan/--track`,
  `branch <name>`, `branch -m`, `stash branch`, `worktree add [-b]`).
- **How commands are read:** the hook lexes a `bash` call like a shell:
  quotes (`g''it` is `git`, `$'…'`/`$"…"` too), `{a,b}` expansion, `; &&
  || | & ;;`, newlines, `$(…)`, backticks, `<(…)`, `( )` subshells (a `cd`
  inside does not leak out) and `{ }` groups, `if/then/for/do/while/case/!`
  keywords, heredoc bodies (data for most commands, so a commit message or
  a doc mentioning `reset --hard` is not a command; `$(…)` inside an
  unquoted heredoc does run and is checked), `#` comments, `sh -c "…"`,
  `bash -lc`, `eval`, and `env`/`sudo`/`command`/`timeout`/`xargs`/`nice`/
  `VAR=x` prefixes. A heredoc or here-string fed to `sh`/`bash` **is** a
  script and is lexed like one; a script piped in from another command
  (`curl … | sh`, `echo … | bash`) cannot be seen and is refused with a
  reason. `cd`, `pushd`/`popd`, `git -C`, `--git-dir`/`--work-tree` and
  `GIT_DIR`/`GIT_WORK_TREE` move the directory a command is judged in, and
  a `git switch`/`checkout`/`rebase <up> <branch>`/`worktree add` moves the
  **branch** the rest of the call is judged on (`git switch main && echo x
  > f` is refused, with a reason that names the switch).
  Redirections (`> file`) and the targets of `cp mv tee sed -i touch
  mkdir chmod tar -x unzip patch …` are judged by the repo they land in.
  Paths are `~`-expanded, `@`/`file://`-stripped like pi does, and
  symlink-resolved; `$PWD`, `$HOME`, `$TMPDIR`, `$(pwd)`, `$(mktemp [-d])`,
  `$(git rev-parse --show-toplevel)` and variables assigned earlier in the
  same call (`D=../x; … $D`, `${D%.txt}`, `for d in x`) are expanded. A path
  the hook cannot resolve (an unknown `$VAR`, another `$(…)`, an `xargs`
  `{}`, `… | xargs rm -r`) is refused when it would be written or
  recursively removed, with a reason asking for a literal path; reading it
  is fine. `find … -delete`/`-exec rm` is judged by its tests: a `-name`
  that cannot match `.git` placed before the action and not negated, or a
  `-name .git -prune -o` branch, makes it safe; `… | xargs rm -f` fed by
  such a `find` likewise. In a directory that is on a non-`pi/*` branch,
  read-only commands (`cat ls grep diff find …`) still run. A call with more
  than 500 simple commands is refused rather than judged partially.
- **Context cost: none while the rules hold.** The guard adds nothing to the
  system prompt and nothing to tool results. The only text the model ever
  sees is a one-line reason on a blocked call (under 200 characters), e.g.
  `git guard: HEAD is on branch 'main'; work only on a pi/* branch. Run
  \`git switch -c pi/<topic>\` (changes come along), then retry.` A
  refused destructive command names reversible alternatives (`git stash
  push -- <file>`, `git show HEAD:<file> > <file>`, `git revert`).
- **Checkpoints, against the loss the rules can't stop.** Rule 1 and 2
  stop history from being destroyed, but uncommitted work on the `pi/*`
  branch would still be lost to the model's own next bad edit. So the
  working tree is snapshotted **before** each `edit`, `write` or `bash` in
  a `pi/*` repo (synchronously, so the state about to change, including
  work you left uncommitted before the session, is kept first) and again
  shortly after each successful one (debounced 3 s, flushed at session
  end). Tracked and untracked files, `.gitignore` respected, untracked
  files over 20 MB left out, committed through a **private index file**
  (`.git/lets-code-checkpoint.index`) and stored under
  `refs/pi-checkpoints/<branch>/<YYYYMMDD-HHMMSS.mmm>` with HEAD as parent.
  Your index, HEAD and branches are untouched; `git status`, `git log`,
  `git stash list` look exactly as before (`git log --all` and `gitk --all`
  do show the checkpoint commits); nothing is pushed by `git push` or
  `--all`; the model sees nothing. Identical trees are not stored twice;
  the last 200 per branch are kept (checkpoints of branches you have
  deleted stay until you remove their refs); unreadable files are skipped
  and failures are logged to `.git/lets-code-checkpoint.log`, never to pi.
  If untracked files total over 500 MB (an un-ignored `node_modules`), only
  tracked files are snapshotted and the log says so. A repo whose warm
  snapshot takes over 2 s is only snapshotted in the background (logged).
  A pre-call snapshot waits for a background one of the same repo, so no
  state falls between them.
  Recover with plain git:
  ```bash
  git for-each-ref refs/pi-checkpoints/                   # list
  git diff refs/pi-checkpoints/pi/x/20261005-231502.117   # what changed since
  git show refs/pi-checkpoints/pi/x/20261005-231502.117:src/a.c > src/a.c
  git restore --source=refs/pi-checkpoints/pi/x/20261005-231502.117 -- src/a.c
  ```
  Off: `LETS_CODE_GIT_CHECKPOINTS=0`; `LETS_CODE_GIT_CHECKPOINT_KEEP` sets
  the count, `LETS_CODE_GIT_CHECKPOINT_MAX_FILE_MB` and
  `…_MAX_UNTRACKED_MB` the size caps. Cost: a
  `git add -A` into the private index before each tool call (tens of ms
  on a typical repo, ~200 ms on 30k files) and one more per burst of
  edits in the background; zero tokens.
- **Not covered:** indirection the lexer cannot see (`$V` holding a
  command, scripts on disk, `python -c "shutil.rmtree('.git')"`). What it
  cannot see it cannot judge; the checkpoints are the backstop. Read-only
  tools are never blocked; files outside any repo are never blocked.
- **Off switch:** `--no-git-guard` or `GIT_GUARD=false`. Outside a git repo,
  or without `git` installed, it is simply off and the launch line says so.

Merging the `pi/*` branch back is yours to do: review `git diff main...HEAD`,
then merge or cherry-pick. Tests: `tests/git-guard.test.mjs` drives the hook
against throwaway repos (~320 cases: every bypass and false positive found
in two independent reviews, operations in progress, worktrees, lexer edge
cases, 200 KB inputs); `tests/git-guard-launch.sh` covers the launch side
(dirty tree, name collision, merge in progress, detached HEAD, linked
worktree, bare repo, off switch); `tests/git-checkpoint.test.mjs` covers the
snapshots (content, untouched index/HEAD, debounce, pruning, flush).

## Cookbook

### Recipe 1 — serve a model with vLLM that pi is happy with

pi needs the OpenAI chat-completions API, tool calling, and ideally a
reasoning parser so thinking renders properly:

```bash
vllm serve Qwen/Qwen3-32B \
  --port 8000 \
  --max-model-len 131072 \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --reasoning-parser qwen3
```

Pick the `--tool-call-parser` / `--reasoning-parser` matching your model
family (`vllm serve --help` lists them). Without a reasoning parser, thinking
models leak `think` tags into the visible output. Local vLLM/SGLang servers
usually also need the `compat` block lets-code writes for you
(`supportsDeveloperRole: false`, `supportsReasoningEffort: false`).

### Recipe 2 — one config that works at home, on the LAN, and over VPN

Give `setup` an ordered endpoint list:

```
http://localhost:8000 https://llm.home.example http://server.local/vllm
```

- on the server itself → `localhost` wins (fastest, no proxy)
- on your LAN/VPN → the domain wins (put it behind nginx with
  `proxy_buffering off` so tokens stream)
- mDNS fallback for LANs without internal DNS

### Recipe 3 — private TLS with mkcert

```bash
mkcert -install && mkcert "*.home.example"      # on the server
# nginx: ssl_certificate(.key) → the generated pair
```

Copy the **public** root (`$(mkcert -CAROOT)/rootCA.pem`) to each client and
point setup's CA question at it. Never copy `rootCA-key.pem` off the server.
The probe itself is permissive (it runs against *every* fallback endpoint,
so a strict check would wrongly kill LAN/VPN entries); trust is enforced for
the **winning** endpoint before launch — without a CA or `--insecure`, a
self-signed endpoint is refused with a clear message.

### Recipe 4 — gateways and other dialects

OpenRouter, OpenAI-compatible proxies, and Anthropic-style gateways:

```bash
lets-code --url https://openrouter.ai/api/v1 --api openai-completions
lets-code --api anthropic-messages   # Anthropic-compatible gateways
```

`LETS_CODE_ENDPOINTS="https://openrouter.ai/api/v1" lets-code` works too.

### Recipe 5 — thinking models

If your model thinks (Qwen3 family etc.), lets-code **auto-detects it at
launch** — one minimal `chat/completions` request with `enable_thinking:
true`, and `reasoning_tokens > 0` in the usage report (or a reasoning
stream / think markers) means the model is registered with
`reasoning: true`. The startup level comes from `THINKING=` in the config
(set during onboarding; suggested value follows your context window), and
pi sends `chat_template_kwargs: {enable_thinking, thinking_budget}` per
request — but that template budget is a **soft** hint a model can overthink
past. To make the bound hard, lets-code also registers
`samplingParams.thinking_token_budget` (half the output cap) on the model;
vLLM with a reasoning parser enforces it engine-side, force-terminating the
thinking section at the budget so the response always continues. Servers
that don't know the field ignore it (extra fields are allowed), and with
thinking off it is inert. `REASONING=false` disables the probe,
`REASONING=true` force-registers a model the probe missed. Without a `--reasoning-parser`
on the server, thinking text can leak into visible output — see Recipe 1.

### Recipe 6 — thinking levels in-session

`/thinking` in the pi TUI switches levels per session (Ctrl+S saves the
startup level); `lets-code --thinking-level low` overrides the configured
level for one launch. Levels `xhigh`/`max` map to pi's high budget.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no endpoint reachable` | Server down, wrong URL, or (for domains) DNS not resolving from this network. `lets-code --verbose` shows each probe. |
| `certificate this machine doesn't trust` | Private CA: set `CA_PATH` in `~/.config/lets-code/config`, or `--insecure` to test. |
| `harness 'X' is a roadmap item` | v1 implements pi only. Run `lets-code` without `--harness`, or with `--harness pi`. |
| Responses appear all at once, not streaming | A proxy is buffering. nginx: `proxy_buffering off; proxy_http_version 1.1;` and generous `proxy_read_timeout`. |
| Tool-calling errors in the server logs | Server started without `--enable-auto-tool-choice --tool-call-parser <p>`. |
| Garbage thinking text in output | Missing `--reasoning-parser` on the server. |
| Session dies mid-way on long tasks | Context overflow — confirm the launch line shows the right `context:` value; if your server hides `max_model_len`, pin it with `--context <tok>` (or `CONTEXT=` in the config file). |
| pi says provider `lets-code` unknown | pi's files were hand-edited while lets-code was running; just re-run `lets-code` — it re-registers on every launch. |
| `fd not found. Downloading...` / `ripgrep not found. Downloading...` in the first session | pi fetching its file-search helpers itself. lets-code does this before launch (`fetching pi's file-search helpers ...`); if that step was skipped (`PI_OFFLINE`, no network, unknown pi layout) pi retries on its own. Installing `fd`/`ripgrep` with your package manager also ends it. |
| Install telemetry | Off by default: lets-code writes `enableInstallTelemetry: false` into pi's `settings.json` unless the key already exists. To opt in, set it to `true` there (or `PI_TELEMETRY=1`). |
| Model can't see images / pi treats it as text-only | pi only sends images to models declared with image input. Image support is auto-detected at launch (check the `image input:` line); the probe needs an OpenAI-dialect endpoint. If it is inconclusive (or you pinned it off), set `VISION=true` in `~/.config/lets-code/config` (or launch with `--vision`) and re-run `lets-code` — the model is re-registered on every launch, and pi re-reads `models.json` when you open `/model`. |
| Model doesn't think / no thinking blocks although it should | Thinking support is auto-detected at launch; check the `thinking support:` line. If the probe is inconclusive or the model needs a nudge, pin `REASONING=true` in `~/.config/lets-code/config` and re-run `lets-code`. Then set a non-`off` level (`THINKING=` or `--thinking-level`) and open `/thinking` to confirm. |

## Roadmap

`--harness deepseek|claude|codex` are planned adapters (each would own its
own provider block / config slice the same way the pi adapter does — see
`DESIGN.md`). v1 ships pi.

## License

MIT
