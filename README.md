# lets-code

Run the [pi](https://pi.dev) coding agent against your own LLM server:
vLLM, SGLang, Ollama, LM Studio, OpenRouter, or anything OpenAI-compatible
that serves `/v1/models`.

One bash script. Needs `bash` 3.2+, `curl` and `python3`; `node`/`npm` only
when it installs pi for you. Linux and macOS.

```
$ lets-code
[lets-code] thinking support: true (startup level: high)
[lets-code] image input: true
[lets-code] connecting: http://localhost:8000  model: Qwen/Qwen3-32B  context: 131072  output cap: 32768  ...
```

## Install

```bash
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/civitas-cerebrum/lets-code/main/lets-code -o ~/.local/bin/lets-code
chmod +x ~/.local/bin/lets-code

lets-code setup        # endpoints, token, optional CA; installs pi if missing
lets-code              # interactive session
lets-code -p "hello"   # one-shot; all unknown args pass through to pi
```

Setup saves `~/.config/lets-code/config`, puts `lets-code` on your PATH,
probes the server and registers the model with pi.

## What a launch does

1. Probes your endpoints in order; the first reachable one wins.
2. Reads the resident model and its context window from `/v1/models`.
3. Sends two tiny test requests: one with thinking forced on, one with a
   64×64 red image. A model that reports reasoning tokens is registered as
   a thinking model; one that answers "red" is registered with image input.
4. Writes pi's config (`~/.pi/agent/models.json`, `settings.json`) under the
   provider id `lets-code`. Your other providers and settings are untouched.
   The output cap is reserved in pi's compaction settings, so a response
   can never overflow the server's window.
5. Starts pi with the memory guard and git guard on.

The token is never written to disk: pi reads it from `LETS_CODE_TOKEN`.
pi's install telemetry is set to off unless you set it yourself. pi's
file-search helpers (`fd`, `ripgrep`) are fetched before the first start,
so the first session starts without download notices.

## Flags

| Flag | Meaning |
|---|---|
| `--url <base>` | Endpoint for this launch (scheme and `/v1` optional) |
| `--model <id>` | Model for this launch (default: discovered) |
| `--context <tok>` | Context window (default: discovered, else 128000) |
| `--output-cap <tok>` | Max output tokens (default 32768) |
| `--api <dialect>` | `openai-completions` (default), `openai-responses`, `anthropic-messages`, `google-generative-ai` |
| `--thinking-level <lvl>` | `off`, `minimal`, `low`, `medium`, `high` (default `medium`) |
| `--vision` / `--no-vision` | Pin image input on or off instead of probing |
| `--insecure` | Skip TLS verification |
| `--no-mem-guard` / `--no-git-guard` | Launch without a guard |
| `--verbose` | Show each endpoint probe |

## Config

`~/.config/lets-code/config` (shell syntax, mode 600). Every key has an
environment override, `LETS_CODE_<KEY>`, which wins over the file.

| Key | Meaning |
|---|---|
| `ENDPOINTS` | Space-separated base URLs, most preferred first. IPs, `localhost`, bare hostnames and `*.local` get `http://`, other domains `https://`. |
| `TOKEN` | API key. Any value works for a server without auth. |
| `CA_PATH` | Root CA file for an https endpoint with a private CA (exported as `NODE_EXTRA_CA_CERTS`). |
| `MODEL`, `CONTEXT`, `OUTPUT_CAP`, `API` | Pins; empty means discovered or default. |
| `VISION`, `REASONING` | `true`/`false` pins; empty means probed at launch. |
| `THINKING` | Startup thinking level. Setup suggests one from the context window. |
| `MEM_GUARD`, `GIT_GUARD` | `false` turns a guard off. |

Listing several endpoints lets one config work on the server box, on the
LAN and over a VPN: `http://localhost:8000 https://llm.home.example`.

## Server setup

vLLM needs tool calling and, for thinking models, a reasoning parser:

```bash
vllm serve Qwen/Qwen3-32B --max-model-len 131072 \
  --enable-auto-tool-choice --tool-call-parser hermes --reasoning-parser qwen3
```

Behind nginx, set `proxy_buffering off` so tokens stream. For a private CA
(for example mkcert), give setup the public root certificate; the winning
https endpoint must be trusted or launched with `--insecure`.

With a reasoning parser, vLLM also enforces the per-level thinking budget
that pi sends (`thinking_token_budget`), so a model cannot think its way
through the whole output cap.

## Memory guard (Linux)

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

## Git guard

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no endpoint reachable` | Server down, wrong URL, or DNS. `lets-code --verbose` shows each probe. |
| `certificate this machine doesn't trust` | Set `CA_PATH`, or `--insecure` to test. |
| Output arrives all at once | A proxy is buffering. nginx: `proxy_buffering off`. |
| Tool-call errors in server logs | Start the server with `--enable-auto-tool-choice --tool-call-parser <p>`. |
| Thinking text in the output | Missing `--reasoning-parser`. |
| Session dies on long tasks | Wrong context size. Check the `context:` value on the launch line; pin `CONTEXT=` if the server hides `max_model_len`. |
| Model does not see images, or does not think | Check the `image input:` / `thinking support:` launch lines. Pin `VISION=true` / `REASONING=true` if a probe was inconclusive. |
| pi says provider `lets-code` is unknown | Re-run `lets-code`; it re-registers on every launch. |

## Tests

```bash
tests/vision-probe.sh         tests/normalize-endpoint.sh   tests/pi-tools.sh
tests/git-guard.test.mjs      tests/git-checkpoint.test.mjs tests/git-guard-launch.sh
tests/mem-guard-live.sh       # end to end, needs tmux
```

## License

MIT
