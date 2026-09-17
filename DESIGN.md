# lets-code — design record

Persisted design record for the `lets-code` launcher. Condensed from the
implementation plan; keep this file updated when decisions change.

## Context

`lets-claude` does one job well: onboard a user, probe a self-hosted LLM
endpoint, pin the context window so the harness never overflows the server,
and `exec` the harness. It is vendor-locked to Claude Code. `lets-code` does
the same job while staying **harness-agnostic**: one CLI, pluggable harness
adapters. **pi is the default and the only v1-implemented harness**;
`deepseek`, `claude`, `codex` are `--harness` roadmap items that fail loudly.

## Invariants

1. **Fixed provider id `lets-code`** — the launcher owns exactly two slices
   of pi's global state, both keyed by `lets-code`, so it never clobbers the
   user's own providers or defaults. Re-upserted on every launch (idempotent;
   JSON makes marker-block parsing unnecessary).
2. **The token never lands in pi's files** — `apiKey` is the literal
   `"$LETS_CODE_TOKEN"` (pi's `$ENV` interpolation); the launcher exports it
   at launch. The secret stays in `~/.config/lets-code/config` (mode 600),
   exactly like lets-claude.
3. **Overflow impossible by construction** — instead of lets-claude's manual
   context partition, pi reserves the output budget natively:
   `contextWindow` = full discovered length,
   `compaction.modelOverrides["lets-code/<model>"].reserveTokens` = output
   cap. pi auto-compacts when `contextTokens > contextWindow - reserveTokens`,
   so compaction always fires before `input + max_tokens` can exceed the
   server window (vLLM 400s on exactly that, e.g. 2026-08-17 incident:
   129,793 input + 32,000 requested).
4. **Deterministic launch, no default hijacking** — `exec pi --provider
   lets-code --model <id>`; the launcher does not write pi's global
   `defaultProvider`/`defaultModel`.
5. **Permissive probe, strict launch** — the probe runs against every
   fallback endpoint (first reachable wins), so a strict TLS check there
   would wrongly kill LAN/VPN entries. Trust is enforced for the *winning*
   https endpoint before launch: refuse (with a CA/`--insecure` hint) only if
   a plain strict `curl` fails.
6. **Atomic, fail-loud writes** — pi's files are rewritten tmp+rename; every
   other key is preserved; a corrupt file fails with a clear message.

## Flag → pi mapping

| Input | Resolved from | Written to pi |
|---|---|---|
| endpoint | `--url` > config/env `ENDPOINTS` (first reachable) | `providers["lets-code"].baseUrl` |
| model | `--model` > config/env `MODEL` > `/v1/models` discovery > error | `models[0].id`, compaction key |
| context | `--context` > config/env `CONTEXT` > `max_model_len` > 128000 | `models[0].contextWindow` |
| output cap | `--output-cap` > config/env `OUTPUT_CAP` > 32768 | `models[0].maxTokens` + `reserveTokens` |
| api dialect | `--api` > config/env `API` > `openai-completions` | `providers["lets-code"].api` |
| token | `--…` n/a; config/env `TOKEN` > `dummy-key` | exported as `LETS_CODE_TOKEN` (never written) |
| CA | `--insecure` / config/env `CA` + file exists | `NODE_EXTRA_CA_CERTS` (https only) |

`compat: {supportsDeveloperRole: false, supportsReasoningEffort: false}` is
written unconditionally: required by local vLLM/SGLang, harmless on
gateways. `PI_SKIP_VERSION_CHECK=1` is exported so air-gapped LANs don't
hang on pi's update check.

## Module map (single file, append-only build)

1. header + globals + logging (the header block doubles as `--help`)
2. probing (`tls_args_for`, `probe` — curl rc → human diagnostics)
3. pi config writer (`pi_write_configs`: python3 JSON upsert, atomic)
4. harness gate + pi presence/auto-install (`harness_gate`, `ensure_pi`)
5. onboarding (`run_setup`, `offer_fresh_shell`)
6. main: arg parse → gate → config load + env overrides → probe → strict-TLS
   trust check → discovery → budget resolution → `pi_write_configs` →
   env exports → `exec pi`

Bash-3.2/portability notes: no `set -o pipefail` unguarded (bash 4+ only —
guarded idiom); empty `"${PASSTHROUGH[@]}"` under `set -u` handled by the
if/else `exec` (same pattern as lets-claude); `&&`-chains in case bodies
replaced by `if` statements where `set -e` could bite.

## Roadmap harnesses (research for future adapters)

- **dsh** — `@deepseek-ai/dsh`, bin `dsh`. Config is YAML
  (`~/.dsh/settings.yaml`, fail-loud 0600) — an adapter needs marker-block
  merge or a YAML lib; `apiKeyEnv` is satisfied via process env (env wins
  over the credentials file). Surfaces `dsh web` / `dsh headless`.
- **claude** — `@anthropic-ai/claude-code`, bin `claude`. NOTE: lets-claude's
  README install line `@anthropic-ai/claude-cli` is stale — that package
  does not exist on npm. Adapter can reuse lets-claude's env-based wiring
  (ANTHROPIC_* + context partition) with no config-file writes.
- **codex** — `@openai/codex`, bin `codex`. Config is TOML
  (`~/.codex/config.toml`) with `model_providers` entries carrying a
  `base_url`; same provider-id discipline applies.

## Out of scope for v1

dsh/claude/codex adapters, thinking-level flags, pi extensions, multi-model
sessions.
