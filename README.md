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
| `--url <base>` | One-off endpoint override (`/v1` suffix optional — it's normalized) |
| `--model <id>` | One-off model override |
| `--context <tok>` | Context window (default: discovered from the server) |
| `--output-cap <tok>` | Max output tokens (default 32768) |
| `--api <dialect>` | `openai-completions` (default) \| `openai-responses` \| `anthropic-messages` \| `google-generative-ai` |
| `--vision` \| `--no-vision` | The model accepts image input (off by default). `--vision` registers the model with `input: ["text","image"]` so pi actually sends images (e.g. screenshots) to it; `--no-vision` forces off even if `VISION=true` is set. |
| `--thinking-level <lvl>` | Startup thinking level: `off`\|`minimal`\|`low`\|`medium`\|`high` (xhigh\|max). Default `medium`. Thinking support itself is **auto-detected at launch** with a minimal test request (pin `REASONING=true`/`false` in the config to override); setup offers a level suggested from your context window. |
| `--insecure` | Skip TLS verification (self-signed certs) |
| `--verbose` \| `--debug` | Show endpoint probing |
| `-h` \| `--help` | Help |

Env overrides: `LETS_CODE_ENDPOINTS` (space-separated), `LETS_CODE_TOKEN`,
`LETS_CODE_CA`, `LETS_CODE_MODEL`, `LETS_CODE_CONTEXT`, `LETS_CODE_OUTPUT_CAP`,
`LETS_CODE_API`, `LETS_CODE_VISION`, `LETS_CODE_THINKING`, `LETS_CODE_REASONING`
(the last two `true`/`false` pins).

## What onboarding sets up

`lets-code setup` walks you through everything and writes
`~/.config/lets-code/config` (mode 600):

| Question | Meaning |
|---|---|
| **Endpoints** | One or more base URLs, most-preferred first. At launch the first reachable one wins — so you can list `http://localhost:8000 https://llm.home.example` and the same script works on the server box, on your LAN, and over your VPN. |
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
   1k/2k/8k/16k — that fits ¼ of the window and ½ of the output cap), and
   registers the model — thinking included — with pi.

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

pi auto-compacts once the conversation exceeds `contextWindow - reserveTokens`,
so the output budget is **reserved by construction**: compaction always fires
before the input side can crowd out the response budget, and the overflow-400
that vLLM throws when `input + max_tokens > window` is impossible —
automatically correct even after you swap models. Want longer conversations
over longer responses? Launch with `--output-cap 16384` — the context share
grows to match.

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
| Model can't see images / pi treats it as text-only | pi only sends images to models declared with image input. Set `VISION=true` in `~/.config/lets-code/config` (or launch with `--vision`) and re-run `lets-code` — the model is re-registered on every launch, and pi re-reads `models.json` when you open `/model`. |
| Model doesn't think / no thinking blocks although it should | Thinking support is auto-detected at launch; check the `thinking support:` line. If the probe is inconclusive or the model needs a nudge, pin `REASONING=true` in `~/.config/lets-code/config` and re-run `lets-code`. Then set a non-`off` level (`THINKING=` or `--thinking-level`) and open `/thinking` to confirm. |

## Roadmap

`--harness deepseek|claude|codex` are planned adapters (each would own its
own provider block / config slice the same way the pi adapter does — see
`DESIGN.md`). v1 ships pi.

## License

MIT
