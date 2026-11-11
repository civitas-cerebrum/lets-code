#!/usr/bin/env bash
# Test for the shell side of disposable thinking: disposable_thinking_plan()
# from ./lets-code. No model, no pi.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(sed -n '/^disposable_thinking_plan() {/,/^}/p' "${here}/../lets-code")"
eval "$(sed -n '/^lc_remembered() {/,/^}/p' "${here}/../lets-code")"
native_path() { printf '%s\n' "$1"; }

work="$(mktemp -d)"; trap 'rm -rf "${work}"' EXIT
PI_AGENT_DIR="${work}/agent"; mkdir -p "${PI_AGENT_DIR}"
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1 -> $2"; else echo "FAIL  $1 -> '$2' (want '$3')"; fail=1; fi; }
# plan <DISPOSABLE_THINKING> [<LETS_CODE_THINKING_REPLAY>]: the mode and what a pi would inherit
plan() { ( DISPOSABLE_THINKING="$1"; LETS_CODE_THINKING_REPLAY="${2:-}"; LETS_CODE_DISPOSABLE_THINKING_ON=1; disposable_thinking_plan; echo "${DT_MODE}|${LETS_CODE_DISPOSABLE_THINKING_ON:-}" ); }

t "default: on" "$(plan "")" "on|1"
t "false: off, and a switch inherited from outside is dropped" "$(plan false)" "off|"
t "true: on" "$(plan true)" "on|1"
t "On (capitalised): on" "$(plan On)" "on|1"
t "a replay window: on" "$(plan "" 2)" "on|1"
t "replay window all: off" "$(plan "" all)" "off|"
t "replay window all, true set: on" "$(plan true all)" "on|1"
t "false with a replay window: off" "$(plan false 2)" "off|"

printf '{"disposableThinking": true}\n' > "${PI_AGENT_DIR}/lets-code-state.json"
t "remembered on: on" "$(plan "")" "on|1"
t "remembered on, false set: off" "$(plan false)" "off|"
printf '{"disposableThinking": false, "gitGuard": true}\n' > "${PI_AGENT_DIR}/lets-code-state.json"
t "remembered off: off" "$(plan "")" "off|"
t "remembered off, true set: on" "$(plan true)" "on|1"
t "another key's choice is not this one's" "$(lc_remembered gitGuard)|$(lc_remembered disposableThinking)|$(lc_remembered none)" "true|false|"
printf 'not json\n' > "${PI_AGENT_DIR}/lets-code-state.json"
t "unreadable state: on, the default" "$(plan "")" "on|1"

exit "${fail}"
