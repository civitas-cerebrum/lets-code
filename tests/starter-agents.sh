#!/usr/bin/env bash
# Unit test for write_default_agents: the four starters in an empty agent
# dir, the reviewer on the reviewer role; an earlier version's reviewer.md
# (role: readonly, exactly as written) is moved to it and its worker.md gets
# the new description, edited ones are not; general joins an install with
# the earlier starters, never over a general.md of the user's, and not again
# once the user deleted it; an agent dir of the user's own agents gets none.
set -eu
export LC_ALL=C
eval "$(sed -n '/^starter_reviewer() {/,/^}$/p; /^starter_worker() {/,/^}$/p; /^starter_general() {/,/^}$/p; /^starter_mark() {/,/^}$/p; /^STARTER_WORKER_V1=/p; /^write_default_agents() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
log() { :; }
work="$(mktemp -d "${TMPDIR:-/tmp}/starter-test.XXXXXX")"; trap 'rm -rf "${work}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
role() { sed -n 's/^role: //p' "$1"; }
desc() { sed -n 's/^description: //p' "$1"; }

PI_AGENT_DIR="${work}/a"; write_default_agents; d="${PI_AGENT_DIR}/agents"
t "four starters"                  "$(ls "${d}" | tr '\n' ' ')" "general.md reviewer.md scout.md worker.md "
t "reviewer: the reviewer role"    "$(role "${d}/reviewer.md")" reviewer
t "scout: still readonly"          "$(role "${d}/scout.md")" readonly
t "general: full tools, no role"   "$(grep -c '^tools:\|^role:' "${d}/general.md")" 0
t "general: its own job"           "$(desc "${d}/general.md")" "Researches open questions; runs multi-step tasks"
t "worker: makes changes"          "$(desc "${d}/worker.md")" "Makes a delegated change and tests it"
t "general: in the marker"         "$(grep -cx general "${d}/.lets-code-starters")" 1
write_default_agents
t "second launch: nothing more"    "$(ls -A "${d}" | tr '\n' ' ')" ".lets-code-starters general.md reviewer.md scout.md worker.md "
old="$(sed 's/^role: reviewer$/role: readonly/' "${d}/reviewer.md")"
oldw="$(sed "s|^description: .*|description: ${STARTER_WORKER_V1}|" "${d}/worker.md")"

# an earlier version's three starters, untouched: reviewer and worker are
# updated, general is added
PI_AGENT_DIR="${work}/b"; d="${PI_AGENT_DIR}/agents"; mkdir -p "${d}"
printf '%s\n' "${old}" > "${d}/reviewer.md"; printf '%s\n' "${oldw}" > "${d}/worker.md"; echo mine > "${d}/scout.md"
write_default_agents
t "old reviewer: moved to reviewer" "$(role "${d}/reviewer.md")" reviewer
t "old reviewer: otherwise the same" "$(sed 's/^role: reviewer$/role: readonly/' "${d}/reviewer.md")" "${old}"
t "old worker: new description"    "$(desc "${d}/worker.md")" "Makes a delegated change and tests it"
t "old worker: otherwise the same" "$(sed "s|^description: .*|description: ${STARTER_WORKER_V1}|" "${d}/worker.md")" "${oldw}"
t "old install: general added"     "$(ls "${d}" | tr '\n' ' '):$(cat "${d}/scout.md")" "general.md reviewer.md scout.md worker.md :mine"
# the user deletes it: it stays deleted
rm "${d}/general.md"; write_default_agents
t "deleted general: not re-added"  "$(ls "${d}" | tr '\n' ' ')" "reviewer.md scout.md worker.md "
# taking "general" out of the marker brings it back
sed -i.bak '/^general$/d' "${d}/.lets-code-starters"; rm -f "${d}/.lets-code-starters.bak"; write_default_agents
t "marker line removed: back"      "$(ls "${d}" | tr '\n' ' ')" "general.md reviewer.md scout.md worker.md "

# edited ones are the user's
PI_AGENT_DIR="${work}/c"; d="${PI_AGENT_DIR}/agents"; mkdir -p "${d}"
printf '%s\nAlso check the docs.\n' "${old}" > "${d}/reviewer.md"
printf '%s\nAlso lint.\n' "${oldw}" > "${d}/worker.md"
printf -- '---\nname: general\ndescription: my own\n---\nmine\n' > "${d}/general.md"; gen="$(cat "${d}/general.md")"
write_default_agents
t "edited reviewer: left alone"    "$(role "${d}/reviewer.md"):$(tail -n 1 "${d}/reviewer.md")" "readonly:Also check the docs."
t "edited worker: left alone"      "$(desc "${d}/worker.md"):$(tail -n 1 "${d}/worker.md")" "${STARTER_WORKER_V1}:Also lint."
t "user's general.md: left alone"  "$(cat "${d}/general.md")" "${gen}"
t "user's general.md: no marker"   "$(ls -A "${d}" | tr '\n' ' ')" "general.md reviewer.md worker.md "

# only the user's own agents: no starter joins them
PI_AGENT_DIR="${work}/e"; d="${PI_AGENT_DIR}/agents"; mkdir -p "${d}"
echo mine > "${d}/helper.md"
write_default_agents
t "own agents only: nothing added" "$(ls -A "${d}" | tr '\n' ' ')" "helper.md "
exit ${fail}
