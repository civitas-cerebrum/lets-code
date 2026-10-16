#!/usr/bin/env bash
# Unit test for write_default_agents: the three starters in an empty agent
# dir, the reviewer on the reviewer role; an earlier version's reviewer.md
# (role: readonly, exactly as written) is moved to it, an edited one is not,
# and other files are left alone.
set -eu
eval "$(sed -n '/^starter_reviewer() {/,/^}$/p; /^write_default_agents() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
log() { :; }
work="$(mktemp -d "${TMPDIR:-/tmp}/starter-test.XXXXXX")"; trap 'rm -rf "${work}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
role() { sed -n 's/^role: //p' "$1"; }

PI_AGENT_DIR="${work}/a"; write_default_agents; d="${PI_AGENT_DIR}/agents"
t "three starters"                 "$(ls "${d}" | tr '\n' ' ')" "reviewer.md scout.md worker.md "
t "reviewer: the reviewer role"    "$(role "${d}/reviewer.md")" reviewer
t "scout: still readonly"          "$(role "${d}/scout.md")" readonly
old="$(sed 's/^role: reviewer$/role: readonly/' "${d}/reviewer.md")"

# an earlier version's starters, untouched: the reviewer is updated
PI_AGENT_DIR="${work}/b"; d="${PI_AGENT_DIR}/agents"; mkdir -p "${d}"
printf '%s\n' "${old}" > "${d}/reviewer.md"; echo mine > "${d}/scout.md"
write_default_agents
t "old reviewer: moved to reviewer" "$(role "${d}/reviewer.md")" reviewer
t "old reviewer: otherwise the same" "$(sed 's/^role: reviewer$/role: readonly/' "${d}/reviewer.md")" "${old}"
t "user's files: nothing added"    "$(ls "${d}" | tr '\n' ' '):$(cat "${d}/scout.md")" "reviewer.md scout.md :mine"

# an edited one is the user's
PI_AGENT_DIR="${work}/c"; d="${PI_AGENT_DIR}/agents"; mkdir -p "${d}"
printf '%s\nAlso check the docs.\n' "${old}" > "${d}/reviewer.md"
write_default_agents
t "edited reviewer: left alone"    "$(role "${d}/reviewer.md"):$(tail -n 1 "${d}/reviewer.md")" "readonly:Also check the docs."
exit ${fail}
