#!/usr/bin/env bash
# The first-launch theme question: asked only while settings.json has no
# theme, saves the answer (auto = pi's "system" by default), keeps every
# other setting, and never asks without a terminal.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-theme-pick.XXXXXX")"
trap 'rm -rf "${d}"' EXIT
python3 - "${here}/../lets-code" > "${d}/pick.sh" <<'PYX'
import sys
s = open(sys.argv[1]).read()
i = s.find("\npick_theme_once() {")
j = s.find("\nPY\n", i)
sys.stdout.write(s[i:s.find("\n}\n", j) + 3])
PYX
log() { echo "$*"; }
. "${d}/pick.sh"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
theme() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("theme", "-"))' "$1/settings.json"; }

PI_AGENT_DIR="${d}/a"; mkdir -p "${PI_AGENT_DIR}"; echo '{"compaction": {"enabled": true}}' > "${PI_AGENT_DIR}/settings.json"
echo "" | LETS_CODE_THEME_PROMPT=force pick_theme_once > /dev/null
check "enter: auto (system)" "$(theme "${PI_AGENT_DIR}")" system
check "other settings kept" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compaction"]["enabled"])' "${PI_AGENT_DIR}/settings.json")" True
echo "2" | LETS_CODE_THEME_PROMPT=force pick_theme_once > "${d}/out"
check "asked once: a set theme is kept" "$(theme "${PI_AGENT_DIR}"):$(wc -c < "${d}/out" | tr -d ' ')" system:0

for pick in "2:lets-code" "3:dark" "4:light" "lets-code:lets-code" "x:system"; do
    PI_AGENT_DIR="${d}/${pick%%:*}"; mkdir -p "${PI_AGENT_DIR}"
    echo "${pick%%:*}" | LETS_CODE_THEME_PROMPT=force pick_theme_once > /dev/null
    check "answer ${pick%%:*}" "$(theme "${PI_AGENT_DIR}")" "${pick#*:}"
done

PI_AGENT_DIR="${d}/quiet"; mkdir -p "${PI_AGENT_DIR}"; echo '{}' > "${PI_AGENT_DIR}/settings.json"
echo "2" | pick_theme_once > "${d}/out"
check "no terminal: not asked, nothing written" "$(theme "${PI_AGENT_DIR}"):$(wc -c < "${d}/out" | tr -d ' ')" "-:0"
exit "${fail}"
