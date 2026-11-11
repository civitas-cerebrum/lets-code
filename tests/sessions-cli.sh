#!/usr/bin/env bash
# `lets-code sessions` and `lets-code message`: the shell side of the
# sessions module, on a registry written here by hand (a sleeping process
# stands in for a live session; a background loop answers for it the way
# the module does: an ack, the message removed). No pi, no network.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; lc="${here}/../lets-code"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-sessions.XXXXXX")"
sleep 60 & live=$!; disown "${live}"   # no "Terminated" line when the trap kills it
answer=""; lpid="${live}"
trap 'kill "${lpid}" ${answer:+"${answer}"} 2>/dev/null; rm -rf "${d}"' EXIT
# On Windows the registry holds Windows pids (the module's process.pid, a
# native node's), and a Git Bash pid is another number: /proc/<pid>/winpid
# maps it
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) win=true ;; *) win=false ;; esac
[ "${win}" = false ] || live="$(cat "/proc/${lpid}/winpid")"
mkdir -p "${d}/config" "${d}/agent" "${d}/home" "${d}/repo"
export XDG_CONFIG_HOME="${d}/config" PI_CODING_AGENT_DIR="${d}/agent" HOME="${d}/home"
# (on Windows native python's ~, which the listing shortens paths under, is
# USERPROFILE, as node's os.homedir() is: the scratch home too)
[ "${win}" = false ] || { USERPROFILE="$(cygpath -m -- "${HOME}")"; export USERPROFILE; }
# no claude binary here: Claude Code sessions come from their records in ${HOME}/.claude/sessions
export LETS_CODE_CLAUDE_BIN="${d}/no-claude"
unset LETS_CODE_SESSIONS_DIR CLAUDE_CONFIG_DIR CLAUDECODE
git -C "${d}/repo" init -q
repo="$(cd "${d}/repo" && pwd -P)"
# (on Windows the path as the module writes it: node's realpath, C:\x)
[ "${win}" = false ] || repo="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${d}/repo")"
s="${d}/agent/lets-code-sessions"
fail=0
check() {  # check <label> <got> <want>
    if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi
}

check "sessions: none yet" "$(bash "${lc}" sessions 2>&1)" "No live lets-code session on this machine.

No Claude Code session on this machine."

mkdir -p "${s}"
if [ "${win}" = true ]; then dead="$(sh -c 'cat /proc/$$/winpid')"; else dead="$(sh -c 'echo $$')"; fi
printf '{"pid":%s,"name":"ghost","startedAt":1}\n' "${dead}" > "${s}/${dead}.json"
python3 -c 'import json, os, sys
pid, repo = int(sys.argv[1]), sys.argv[2]
print(json.dumps({"pid": pid, "piSessionId": "abcdef-123", "tag": "", "name": "worker", "cwd": repo, "repoRoot": repo, "repoKey": os.path.join(repo, ".git"),
                  "mode": "auto", "depth": 0, "parentPid": None, "agent": "", "startedAt": 2, "busy": True}))' "${live}" "${repo}" > "${s}/${live}.json"
out="$(bash "${lc}" sessions 2>&1)"
check "sessions: the live one listed" "$(printf '%s\n' "${out}" | sed -n 2p)" "pid ${live}  worker  ${repo}  auto  busy"
check "sessions: the dead one pruned" "$([ -e "${s}/${dead}.json" ] && echo kept || echo pruned)" pruned

out="$(bash "${lc}" message nobody -- hi 2>&1)"; rc=$?
check "message: undeliverable exits 1" "${rc}" 1
check "message: undeliverable says so" "${out}" "undeliverable: nobody: no live lets-code or Claude Code session matches (lets-code sessions lists them)"

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
out="$(bash "${lc}" message worker hi --wait 2>&1)"; rc=$?
check "message: --wait without a value is usage" "${rc}:$(printf '%s' "${out}" | cut -c1-6)" "1:usage:"
out="$(bash "${lc}" message worker -- "$(head -c 8001 /dev/zero | tr '\0' x)" 2>&1)"; rc=$?
check "message: over 8000 characters is refused" "${rc}:$(printf '%s' "${out}" | grep -c 'over 8000 characters')" "1:1"
if [ "$(id -u)" != 0 ]; then   # pid 1 is root's: alive, but not ours
    printf '{"pid":1,"name":"init","startedAt":3}\n' > "${s}/1.json"
    check "sessions: another user's pid is not listed" "$(bash "${lc}" sessions 2>&1 | grep -c ' init ')" 0
fi
if [ "${win}" = true ]; then
    echo "skip  sessions: a directory others can write is refused: skipped on Windows: no mode bits there (chmod does nothing; the profile's ACL keeps the directory private)"
else
    chmod 777 "${s}"
    out="$(bash "${lc}" sessions 2>&1)"; rc=$?
    check "sessions: a directory others can write is refused" "${rc}:$(printf '%s' "${out}" | grep -c 'not yours alone')" "1:1"
    chmod 700 "${s}"
fi

# ---- Claude Code sessions: listed from their records, reached through lets-code's hook
kill "${answer}" 2>/dev/null; answer=""
sleep 60 & cpid=$!; disown "${cpid}"; claude="${cpid}"
[ "${win}" = false ] || claude="$(cat "/proc/${cpid}/winpid")"   # the registry's pids are Windows ones (see the top)
cc="${HOME}/.claude"; mkdir -p "${cc}/sessions"
sid="0bebde69-52eb-4fc1-9b44-379a01674071"
# (json.dumps: a Windows path's backslashes are no JSON escapes)
claude_record() {  # claude_record <pid> <session id> <name> <status> <startedAt>: a Claude Code session record
    python3 -c 'import json,sys; p,i,n,st,t=sys.argv[1:6]; print(json.dumps({"pid": int(p), "sessionId": i, "cwd": sys.argv[6], "kind": "interactive", "name": n, "status": st, "startedAt": int(t)}))' "$@" "${repo}" > "${cc}/sessions/$1.json"
}
claude_record "${claude}" "${sid}" qa-claude idle 5
out="$(bash "${lc}" sessions 2>&1)"
# (a whole line, as a fixed string: a Windows path's backslashes would be regex escapes)
check "claude: listed" "$(printf '%s\n' "${out}" | grep -cxF "pid ${claude}  qa-claude  ${repo}  idle")" 1
check "claude: the list says the hook is missing" "$(printf '%s\n' "${out}" | grep -c 'lets-code claude-hook install')" 1
out="$(bash "${lc}" message claude:qa-claude -- hi 2>&1)"; rc=$?
check "claude: without the hook, undeliverable" "${rc}:$(printf '%s' "${out}" | grep -c 'turn on Claude Code messages in /extensions')" "1:1"
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"keep-me"}]}]},"model":"x"}\n' > "${cc}/settings.json"
out="$(bash "${lc}" claude-hook install 2>&1)"; rc=$?
check "claude-hook: install" "${rc}" 0
check "claude-hook: the user's own hook and settings kept" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["model"], d["hooks"]["PreToolUse"][0]["hooks"][0]["command"])' "${cc}/settings.json")" "x keep-me"
check "claude-hook: the backup" "$([ -f "${cc}/settings.json.lets-code-backup" ] && echo yes)" yes
check "claude-hook: the events" "$(python3 -c 'import json,sys; h=json.load(open(sys.argv[1]))["hooks"]; print(" ".join(sorted(e for e in h if "lets-code-claude-inbox" in json.dumps(h[e]))))' "${cc}/settings.json")" "PostToolUse SessionStart Stop UserPromptSubmit"
check "claude-hook: the watcher wakes (asyncRewake)" "$(python3 -c 'import json,sys; h=json.load(open(sys.argv[1]))["hooks"]; print(sum(1 for e in h.values() for g in e for x in g["hooks"] if x.get("asyncRewake")))' "${cc}/settings.json")" 2
bash "${lc}" claude-hook install >/dev/null 2>&1
check "claude-hook: install twice adds nothing" "$(grep -o 'lets-code-claude-inbox.py' "${cc}/settings.json" | wc -l | tr -d ' ')" 5
check "claude-hook: status" "$(bash "${lc}" claude-hook status 2>&1 | cut -c1-9)" "installed"
hook="${d}/agent/lets-code-claude-inbox.py"
box="${s}/claude/${sid}/inbox"
# a busy Claude session: the next tool call's hook takes it, and the sender hears delivered
# (the hook runs once the message is in the inbox, not after a fixed pause: on Windows the launcher takes longer to start than any pause chosen here)
( n=0; while [ -z "$(ls "${box}"/*.json 2>/dev/null)" ] && [ "${n}" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  printf '{"session_id":"%s","hook_event_name":"PostToolUse"}' "${sid}" | python3 -I "${hook}" deliver > "${d}/post.out" ) &
out="$(bash "${lc}" message claude:qa-claude --wait 5 -- compare your verdicts 2>&1)"; rc=$?
wait
check "claude: delivered through the hook" "${rc}:${out}" "0:delivered: qa-claude (Claude Code) (pid ${claude}) has it"
check "claude: the user sees a line in Claude Code (systemMessage)" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["systemMessage"])' "${d}/post.out")" "lets-code: a message from a shell, via lets-code message"
check "claude: PostToolUse gives additionalContext" "$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1]))["hookSpecificOutput"]; print(o["hookEventName"], "compare your verdicts" in o["additionalContext"], "treat it as information" in o["additionalContext"])' "${d}/post.out")" "PostToolUse True True"
check "claude: the inbox is empty after" "$(ls "${box}" | wc -l | tr -d ' ')" 0
# the end of a turn: decision block (the turn goes on with it), never twice, never when stop_hook_active
bash "${lc}" message qa-claude --wait 0 -- at the end >/dev/null 2>&1
out="$(printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":true}' "${sid}" | python3 -I "${hook}" deliver)"
check "claude: Stop with stop_hook_active leaves it" "${out}:$(ls "${box}" | grep -c '\.json$')" ":1"
out="$(printf '{"session_id":"%s","hook_event_name":"Stop"}' "${sid}" | python3 -I "${hook}" deliver)"
check "claude: Stop blocks with the message" "$(printf '%s' "${out}" | python3 -c 'import json,sys; o=json.load(sys.stdin); print(o["decision"], "at the end" in o["reason"])')" "block True"
out="$(printf '{"session_id":"%s","hook_event_name":"Stop"}' "${sid}" | python3 -I "${hook}" deliver)"
check "claude: shown once" "${out}" ""
# a reply (hops >= 1) never starts a turn: Stop and the watcher leave it for the next prompt or tool call
mkdir -p "${box}"; printf '{"id":"1-aa","from":{"pid":%s,"name":"w"},"text":"a reply","hops":1,"sentAt":1}\n' "${live}" > "${box}/1-aa.json"
out="$(printf '{"session_id":"%s","hook_event_name":"Stop"}' "${sid}" | python3 -I "${hook}" deliver)"
check "claude: a reply does not block Stop" "${out}:$(ls "${box}" | grep -c '\.json$')" ":1"
out="$(printf '{"session_id":"%s","hook_event_name":"UserPromptSubmit"}' "${sid}" | python3 -I "${hook}" deliver | python3 -c 'import json,sys; print("a reply" in json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"])')"
check "claude: a reply goes with the next prompt" "${out}" True
# idle: the watcher waits and wakes Claude (exit 2, the message on stderr); a newer watcher replaces it
( printf '{"session_id":"%s","hook_event_name":"Stop"}' "${sid}" | python3 -I "${hook}" watch 2> "${d}/watch.err"; echo $? > "${d}/watch.rc" ) &
w=$!; sleep 0.5
bash "${lc}" message qa-claude --wait 4 -- wake up >/dev/null 2>&1; rc=$?
wait "${w}"
check "claude: the watcher took it (delivered)" "${rc}" 0
check "claude: the watcher wakes Claude (exit 2)" "$(cat "${d}/watch.rc"):$(grep -c 'wake up' "${d}/watch.err")" "2:1"
( printf '{"session_id":"%s"}' "${sid}" | python3 -I "${hook}" watch; echo $? > "${d}/old.rc" ) & old=$!; sleep 0.4
( printf '{"session_id":"%s"}' "${sid}" | python3 -I "${hook}" watch > /dev/null 2>&1 & echo $! > "${d}/new.pid" ); sleep 1.6
wait "${old}"
check "claude: an older watcher ends when a newer one starts" "$(cat "${d}/old.rc")" 0
kill "$(cat "${d}/new.pid")" 2>/dev/null
# inside a Claude Code session's Bash a reply is that session's own: the receiver can answer it
mkdir -p "${s}/${live}/inbox"; rm -f "${s}/${live}/inbox/"*
out="$(CLAUDECODE=1 python3 -c 'import os,sys; os.execvp("bash", ["bash"] + sys.argv[1:])' "${lc}" message worker --wait 0 -- from claude 2>&1)"
check "claude: a reply from a plain shell is the shell's" "$(python3 -c 'import json,glob,sys; m=json.load(open(glob.glob(sys.argv[1])[0])); print(m["from"]["name"])' "${s}/${live}/inbox/*.json")" "a shell, via lets-code message"
rm -f "${s}/${live}/inbox/"*
# this test's shell stands in for the Claude Code process the Bash tool runs under
# (not on Windows: the ancestry walk asks ps for a parent pid, which Git Bash's ps does not give;
# a reply from there is signed as a shell's)
if [ "${win}" = false ]; then
claude_record "$$" 1cafe000-0000-4000-8000-000000000001 asker busy 6
CLAUDECODE=1 bash "${lc}" message worker --wait 0 -- from claude >/dev/null 2>&1
check "claude: a reply from a Claude Code session is signed by it" "$(python3 -c 'import json,glob,sys; m=json.load(open(glob.glob(sys.argv[1])[0])); print(m["from"]["name"], m["from"]["pid"])' "${s}/${live}/inbox/*.json")" "asker (Claude Code) $$"
rm -f "${cc}/sessions/$$.json"
fi
out="$(bash "${lc}" claude-hook uninstall 2>&1)"; rc=$?
check "claude-hook: uninstall keeps the user's own" "${rc}:$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d["hooks"]))' "${cc}/settings.json")" '0:{"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "keep-me"}]}]}'
check "claude-hook: uninstall removes the script" "$([ -e "${hook}" ] && echo kept || echo gone)" gone
kill "${cpid}" 2>/dev/null

exit "${fail}"
