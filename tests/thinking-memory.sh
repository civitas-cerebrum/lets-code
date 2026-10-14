#!/usr/bin/env bash
# lc_saved_thinking: the level the thinking module saved for a model, if valid.
set -u
eval "$(sed -n '/^lc_saved_thinking() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
PI_AGENT_DIR="$(mktemp -d)"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
check "no state file" "$(lc_saved_thinking lets-code/qwen)" ""
printf '{"thinkingLevels": {"lets-code/qwen": "xhigh", "lets-code/bad": "huge"}}' > "${PI_AGENT_DIR}/lets-code-state.json"
check "saved level" "$(lc_saved_thinking lets-code/qwen)" xhigh
check "invalid level ignored" "$(lc_saved_thinking lets-code/bad)" ""
check "other model" "$(lc_saved_thinking lets-code/other)" ""
printf 'not json' > "${PI_AGENT_DIR}/lets-code-state.json"
check "unreadable file" "$(lc_saved_thinking lets-code/qwen)" ""
exit "${fail}"
