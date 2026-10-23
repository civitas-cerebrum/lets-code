#!/usr/bin/env bash
# The command-line surface a first user meets before any server answers:
# --help (exit 0, the launch steps in order), --version, and the messages
# that name the next command to run (setup, setup preset, --claude). No
# network and no pi: every path here exits before a probe.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; lc="${here}/../lets-code"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-cli.XXXXXX")"; trap 'rm -rf "${d}"' EXIT
mkdir -p "${d}/config" "${d}/agent" "${d}/home"
export XDG_CONFIG_HOME="${d}/config" PI_CODING_AGENT_DIR="${d}/agent" HOME="${d}/home"
fail=0
check() {  # check <label> <got> <want>
    if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi
}

help="$(bash "${lc}" --help 2>&1)"; rc=$?
check "--help exits 0" "${rc}" 0
check "--help starts with the name" "$(printf '%s\n' "${help}" | head -n 1 | cut -c1-9)" "lets-code"
check "--help ends at the needs line" "$(printf '%s\n' "${help}" | tail -n 1)" "(auto-installed on request)."
check "launch steps in order" "$(printf '%s\n' "${help}" | grep -oE '^ +[0-9]+\. ' | tr -d ' .' | tr '\n' ' ')" "1 2 3 4 5 6 7 8 9 10 11 "
check "-h is --help" "$(bash "${lc}" -h 2>&1 | head -n 1)" "$(printf '%s\n' "${help}" | head -n 1)"
check "--version" "$(bash "${lc}" --version)" "lets-code dev"
check "-V" "$(bash "${lc}" -V)" "lets-code dev"

out="$(bash "${lc}" </dev/null 2>&1)"; rc=$?
check "no config exits 1" "${rc}" 1
check "no config names setup" "$(printf '%s\n' "${out}" | grep -c 'lets-code setup')" 1
check "no config names --claude" "$(printf '%s\n' "${out}" | grep -c -- 'lets-code --claude')" 1

out="$(bash "${lc}" setup bogus </dev/null 2>&1)"; rc=$?
check "setup bogus exits 1" "${rc}" 1
check "setup bogus lists the profiles" "$(printf '%s\n' "${out}" | grep -c 'setup preset')" 1

out="$(bash "${lc}" --preset nothere </dev/null 2>&1)"; rc=$?
check "unknown preset exits 1" "${rc}" 1
check "unknown preset names the onboarding" "$(printf '%s\n' "${out}" | grep -c 'lets-code setup preset nothere')" 1
check "presets: none yet" "$(bash "${lc}" presets 2>&1)" "No presets yet. Add one with:  lets-code setup preset <name>"

# a bad value is reported as the bad value, before any endpoint is probed:
# the endpoint here is dead, and "no endpoint reachable" must not win
dead="LETS_CODE_ENDPOINTS=http://127.0.0.1:1"
bad() {  # bad <label> <expected words> [env=val ...] -- [flags...]
    local label="$1" want="$2"; shift 2; local envs=()
    while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
    out="$(env "${dead}" ${envs[@]+"${envs[@]}"} bash "${lc}" "$@" </dev/null 2>&1)"; rc=$?
    check "${label}: exit 1" "${rc}" 1
    check "${label}: names the value" "$(printf '%s\n' "${out}" | grep -c "${want}")" 1
    check "${label}: no probe" "$(printf '%s\n' "${out}" | grep -c 'no endpoint reachable')" 0
}
bad "--thinking-level bogus" "got: bogus" -- --thinking-level bogus
bad "--thinking-level adaptive:tall" "adaptive:tall" -- --thinking-level adaptive:tall
bad "LETS_CODE_THINKING=auto:nope" "auto:nope" LETS_CODE_THINKING=auto:nope --
bad "LETS_CODE_VISION=maybe" "got: maybe" LETS_CODE_VISION=maybe --
bad "LETS_CODE_REASONING=maybe" "got: maybe" LETS_CODE_REASONING=maybe --
bad "--api grpc" "api dialect: grpc" -- --api grpc
bad "LETS_CODE_API=grpc" "api dialect: grpc" LETS_CODE_API=grpc --

# a typo of a lets-code flag is an error that names the flag; anything
# else passes to pi (and reaches "no configuration" here, since none is)
typo() {  # typo <flag> <meant>
    out="$(bash "${lc}" "$1" </dev/null 2>&1)"; rc=$?
    check "$1: exit 1" "${rc}" 1
    check "$1: did you mean $2" "$(printf '%s\n' "${out}" | grep -c "did you mean $2?")" 1
}
typo --no-sandbx --no-sandbox
typo --no-expert --no-experts
typo --thinking-levle --thinking-level
typo --claud --claude
typo --orchestrator=1 --orchestrator
passes() {  # passes <flag...>: pi's own flag, or one far from any of ours
    out="$(bash "${lc}" "$@" </dev/null 2>&1)"
    check "$*: passes to pi" "$(printf '%s\n' "${out}" | grep -c 'did you mean')|$(printf '%s\n' "${out}" | grep -c 'lets-code setup')" "0|1"
}
passes --no-session
passes --models claude
passes --mode json
passes --thinking high
passes --whatever
passes -- --claud
mkdir -p "${d}/config/lets-code/presets"; echo 'MODEL="m"' > "${d}/config/lets-code/presets/office"
typo --offic --office
rm -r "${d}/config/lets-code/presets"

check "update bogus exits 1" "$(bash "${lc}" update bogus >/dev/null 2>&1; echo $?)" 1
check "--help does not list --harness (a flag that can only fail)" "$(printf '%s\n' "${help}" | grep -c -- '--harness')" 0
check "roadmap harness exits 1" "$(bash "${lc}" --harness codex </dev/null >/dev/null 2>&1; echo $?)" 1
check "roadmap harness says so" "$(bash "${lc}" --harness codex </dev/null 2>&1 | grep -c 'roadmap item')" 1
check "mandate alone exits 1" "$(bash "${lc}" mandate >/dev/null 2>&1; echo $?)" 1
exit "${fail}"
