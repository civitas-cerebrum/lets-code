#!/usr/bin/env bash
# `lets-code sessions` and `lets-code message`: the shell side of the
# sessions module, on a registry written here by hand (a sleeping process
# stands in for a live session; a background loop answers for it the way
# the module does: an ack, the message removed). No pi, no network.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; lc="${here}/../lets-code"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-sessions.XXXXXX")"
sleep 60 & live=$!; disown "${live}"   # no "Terminated" line when the trap kills it
answer=""
trap 'kill "${live}" ${answer:+"${answer}"} 2>/dev/null; rm -rf "${d}"' EXIT
mkdir -p "${d}/config" "${d}/agent" "${d}/home" "${d}/repo"
export XDG_CONFIG_HOME="${d}/config" PI_CODING_AGENT_DIR="${d}/agent" HOME="${d}/home"
unset LETS_CODE_SESSIONS_DIR
git -C "${d}/repo" init -q
repo="$(cd "${d}/repo" && pwd -P)"
s="${d}/agent/lets-code-sessions"
fail=0
check() {  # check <label> <got> <want>
    if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi
}

check "sessions: none yet" "$(bash "${lc}" sessions 2>&1)" "No live lets-code session on this machine."

mkdir -p "${s}"
dead="$(sh -c 'echo $$')"
printf '{"pid":%s,"name":"ghost","startedAt":1}\n' "${dead}" > "${s}/${dead}.json"
printf '{"pid":%s,"piSessionId":"abcdef-123","tag":"","name":"worker","cwd":"%s","repoRoot":"%s","repoKey":"%s","mode":"auto","depth":0,"parentPid":null,"agent":"","startedAt":2,"busy":true}\n' \
    "${live}" "${repo}" "${repo}" "${repo}/.git" > "${s}/${live}.json"
out="$(bash "${lc}" sessions 2>&1)"
check "sessions: the live one listed" "$(printf '%s\n' "${out}" | sed -n 2p)" "pid ${live}  worker  ${repo}  auto  busy"
check "sessions: the dead one pruned" "$([ -e "${s}/${dead}.json" ] && echo kept || echo pruned)" pruned

out="$(bash "${lc}" message nobody -- hi 2>&1)"; rc=$?
check "message: undeliverable exits 1" "${rc}" 1
check "message: undeliverable says so" "${out}" "undeliverable: nobody: no live session matches (lets-code sessions lists them)"

out="$(bash "${lc}" message worker --wait 0.3 -- not seen yet 2>&1)"; rc=$?
check "message: queued exits 2" "${rc}" 2
check "message: queued says so" "${out}" "queued: worker (pid ${live}) has not taken it within 0.3s; it is shown there when that session next polls"
f="$(ls "${s}/${live}/inbox/"*.json 2>/dev/null | head -n 1)"
check "message: in the inbox" "$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["text"], "|", m["from"]["name"])' "${f}")" "not seen yet | a shell, via lets-code message"
rm -f "${s}/${live}/inbox/"*

# the receiver: acks each message and removes it
( while :; do
    for m in "${s}/${live}/inbox/"*.json; do
        [ -e "${m}" ] || continue
        printf '{"seenAt":1}\n' > "${m%.json}.ack"; rm -f "${m}"
    done
    sleep 0.05
  done ) & answer=$!; disown "${answer}"
out="$(cd "${repo}" && bash "${lc}" message repo -- hello repo 2>&1)"; rc=$?
check "message: repo delivered exits 0" "${rc}" 0
check "message: repo delivered" "${out}" "delivered: worker (pid ${live}) has it"
out="$(bash "${lc}" message abcdef -- by id prefix 2>&1)"; rc=$?
check "message: by session id prefix" "${rc}:${out}" "0:delivered: worker (pid ${live}) has it"
out="$(cd "${d}/home" && bash "${lc}" message repo -- elsewhere 2>&1)"; rc=$?
check "message: repo outside the repo is undeliverable" "${rc}" 1
out="$(bash "${lc}" message 2>&1)"; rc=$?
check "message: no args is usage" "${rc}:$(printf '%s' "${out}" | cut -c1-6)" "1:usage:"

exit "${fail}"
