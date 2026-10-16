#!/usr/bin/env bash
# Unit test for lc_migrate_expert_switches: TERMUX=true / REA=true from a
# config of an earlier version become the remembered expert, once, with a
# note; anything else is ignored, and other keys of the state file stay.
set -eu
eval "$(sed -n '/^lc_migrate_expert_switches() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
log() { echo "${1}"; }
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
PI_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/expert-migrate.XXXXXX")"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
CONFIG_FILE=/cfg; st="${PI_AGENT_DIR}/lets-code-state.json"
experts() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get("experts"), sort_keys=True))' "${st}"; }
echo '{"metrics": true}' > "${st}"
TERMUX="true"; REA="manual"; out="$(lc_migrate_expert_switches)"
t "TERMUX=true: remembered enabled"  "$(experts)" '{"termux-device": true}'
t "REA=manual: ignored"              "$(echo "${out}" | grep -c reverse-engineer || true)" 0
t "one-line note"                    "$(echo "${out}" | grep -c '^note: TERMUX=true in /cfg is now remembered as the termux-device expert enabled')" 1
t "other keys kept"                  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["metrics"])' "${st}")" True
t "mode 600"                         "$(ls -l "${st}" | cut -c1-10)" "-rw-------"
t "second launch: no note"           "$(lc_migrate_expert_switches | wc -l | tr -d ' ')" 0
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["experts"]["termux-device"]=False; json.dump(d,open(sys.argv[1],"w"))' "${st}"
lc_migrate_expert_switches >/dev/null
t "a later /expert disable wins"     "$(experts)" '{"termux-device": false}'
TERMUX="false"; REA="TRUE"; lc_migrate_expert_switches >/dev/null
t "REA=true: remembered"             "$(experts)" '{"reverse-engineer": true, "termux-device": false}'
rm -f "${st}"; TERMUX=""; REA="false"; lc_migrate_expert_switches >/dev/null
t "false/empty: no state written"    "$([ -e "${st}" ] && echo yes || echo no)" no
exit "${fail}"
