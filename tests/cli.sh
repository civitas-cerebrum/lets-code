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

check "update bogus exits 1" "$(bash "${lc}" update bogus >/dev/null 2>&1; echo $?)" 1
check "roadmap harness exits 1" "$(bash "${lc}" --harness codex </dev/null >/dev/null 2>&1; echo $?)" 1
check "mandate alone exits 1" "$(bash "${lc}" mandate >/dev/null 2>&1; echo $?)" 1
exit "${fail}"
