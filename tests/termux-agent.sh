#!/usr/bin/env bash
# Unit test for write_termux_agent: the termux-device expert lets-code
# writes (and keeps current) with its helpers and references; a user's own
# file of that name left alone. Then the helpers against fakes: probe (which
# tiers a phone has) with fake getprop/id/am/cmd/adb/rish on an isolated
# PATH, ui (screen, tap, type) through a fake rish, and uitext.py (the
# uiautomator XML parser) on fixtures in tests/fixtures/termux-ui.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "${here}/../lets-code" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\n# Termux device expert:")
j = s.find("\non_termux() {", i)
k = s.find("\n", j + 1)
sys.stdout.write(s[i:k + 1])
PY
)"
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/termux-agent.XXXXXX")" && pwd)"; trap 'rm -rf "${work}"' EXIT
PI_AGENT_DIR="${work}/agent"
af="${PI_AGENT_DIR}/agents/termux-device.md"; T="${PI_AGENT_DIR}/termux"
fx="${here}/fixtures/termux-ui"

# ---------------------------------------------------------------- the writer
write_termux_agent
t "agent file written"          "$(grep -c '^# Written by lets-code' "${af}")" 1
t "name"                        "$(sed -n 's/^name: //p' "${af}")" termux-device
t "tools"                       "$(sed -n 's/^tools: //p' "${af}")" "bash, read"
t "no device-specific uid"      "$(grep -c '10372' "${af}" || true)" 0
t "frontmatter closed"          "$(grep -c '^---$' "${af}")" 2
t "an expert"                   "$(sed -n 's/^expert: //p' "${af}")" true
t "only on Termux"              "$(sed -n 's/^platform: //p' "${af}")" termux
t "brief: goal, required"       "$(sed -n 's/^  - goal (required): //p' "${af}")" "the user's goal, verbatim"
t "brief: confirmed, optional"  "$(grep -c '^  - confirmed: ' "${af}")" 1
t "brief: two fields"           "$(grep -c '^  - ' "${af}")" 2
u="$(sed -n 's/^use_for: //p' "${af}")"
t "use_for stays short"         "$([ ${#u} -le 70 ] && echo yes || echo "${#u} chars")" yes
t "body names the probe"        "$(grep -c "${T}/bin/probe" "${af}")" 1
t "no placeholder left"         "$(grep -rl '@@T@@' "${PI_AGENT_DIR}" | wc -l | tr -d ' ')" 0
for f in bin/probe bin/ui; do t "${f} executable" "$([ -x "${T}/${f}" ] && echo yes)" yes; done
for f in bin/uitext.py ref/tiers.md ref/screen.md ref/messaging.md; do t "${f} written" "$([ -s "${T}/${f}" ] && echo yes)" yes; done
t "helpers parse"               "$(bash -n "${T}/bin/probe" && bash -n "${T}/bin/ui" && python3 -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" "${T}/bin/uitext.py" && echo yes)" yes
for r in tiers screen messaging; do
    t "ref ${r} named in the body or a ref" "$(cat "${af}" "${T}"/ref/*.md | grep -c "ref/${r}.md" | awk '{print ($1 > 0) ? "yes" : "no"}')" yes
done
t "job set (expert-lint)"        "$(grep -c '^job: ' "${af}")" 1
t "app identity: no package-name grep" "$(grep -c 'list packages | grep' "${af}" || true)" 0
t "app identity: by role, mailto"      "$(grep -c 'action.SENDTO -d mailto:`' "${af}")" 1
t "app identity: launcher list"        "$(grep -c 'query-activities --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep /' "${af}")" 1
t "app identity: Gmail example"        "$(grep -c 'Gmail is `com.google.android.gm`' "${af}")" 1
t "failed launch: re-derive first"     "$(grep -c 'When a launch' "${af}")" 1
t "consent: final step needs confirmed" "$(grep -c "brief's \`confirmed\` field" "${af}")" 1
t "safety: no wireless debugging"       "$(grep -c 'enable developer options or wireless debugging' "${af}")" 1
before="$(cd "${PI_AGENT_DIR}" && find . -type f -exec cat {} +)"; write_termux_agent
t "rewrite is stable"           "$(cd "${PI_AGENT_DIR}" && find . -type f -exec cat {} +)" "${before}"
t "no temp files left"          "$(find "${PI_AGENT_DIR}" -name '*.tmp' -o -name '*.md.*' | wc -l | tr -d ' ')" 0
printf -- '---\nname: termux-device\ndescription: mine\n---\nmine\n' > "${af}"; rm -rf "${T}"
write_termux_agent
t "user's own file kept"        "$(grep -c 'description: mine' "${af}")" 1
t "no helpers for a user's file" "$([ -e "${T}" ] && echo written || echo none)" none
rm -f "${af}"; write_termux_agent
( PREFIX=/data/data/com.termux/files/usr; on_termux ) && r=yes || r=no
t "Termux detected by PREFIX"   "${r}" yes

# ------------------------------------------------- uitext.py on the fixtures
ut() { python3 "${T}/bin/uitext.py" "$@"; }
out="$(ut dump "${fx}/chat.xml")"
t "dump: header"                "$(echo "${out}" | sed -n 1p)" "screen: com.whatsapp 1080x2400, 4 of 5 nodes"
t "dump: edit field"            "$(echo "${out}" | grep 'EditText')" '#3 EditText "Hello there" id=entry @510,2260 [click,edit,focus]'
t "dump: send button"           "$(echo "${out}" | grep 'id=send')" '#4 ImageButton desc="Send" id=send @990,2260 [click]'
t "dump: junk before XML ok"    "$(head -c 20 "${fx}/chat.xml")" "UI hierchary dumped "
out="$(ut dump "${fx}/chats.xml")"
t "dump: zero-size node hidden" "$(echo "${out}" | grep -c 'Hidden' || true)" 0
t "dump: row label from children" "$(echo "${out}" | grep -c '^#5 RelativeLayout ~"Taha Test / please send' )" 1
t "dump: long text cut"         "$(echo "${out}" | grep '^#7' | grep -c '…')" 1
t "dump --full: not cut"        "$(ut dump "${fx}/chats.xml" --full | grep '^#7' | grep -c 'yesterday evening')" 1
t "dump --grep"                 "$(ut dump "${fx}/chats.xml" --grep tahir | sed 1d | wc -l | tr -d ' ')" 2
t "dump --max"                  "$(ut dump "${fx}/chats.xml" --max 2 | tail -n 1)" "... 6 more (narrow it: ui dump <word>)"
t "dump --all adds layout nodes" "$(ut dump "${fx}/chats.xml" --all | sed -n 1p)" "screen: com.whatsapp 1080x2400, 10 of 11 nodes"
t "find: clickable parent"      "$(ut find "${fx}/chats.xml" --any 'taha test' | sed -n 1p)" "540 357"
t "find: substring"             "$(ut find "${fx}/chats.xml" --any 'taha' | sed -n 1p)" "540 357"
rc=0; out="$(ut find "${fx}/chats.xml" --any tah)" || rc=$?
t "find: ambiguous exits 2"     "${rc}" 2
t "find: ambiguous lists both"  "$(echo "${out}" | grep -c '^  [12]: ')" 2
t "find: --nth"                 "$(ut find "${fx}/chats.xml" --any tah --nth 2 | sed -n 1p)" "540 543"
t "find: --id"                  "$(ut find "${fx}/chat.xml" --id send | sed -n 1p)" "990 2260"
t "find: --desc"                "$(ut find "${fx}/chats.xml" --desc search | sed -n 1p)" "920 180"
rc=0; ut find "${fx}/chats.xml" --text nobody >/dev/null || rc=$?
t "find: no match exits 1"      "${rc}" 1
t "at: smallest node"           "$(ut at "${fx}/chat.xml" 990 2260 | sed -n 2p)" 'node: #4 ImageButton desc="Send" id=send @990,2260 [click]'
printf 'ERROR: could not get idle state.\n' > "${work}/bad.xml"
rc=0; ut dump "${work}/bad.xml" >/dev/null || rc=$?
t "bad dump exits 3"            "${rc}" 3
cat > "${work}/pw.xml" <<'X'
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="hunter22" resource-id="app:id/pw" class="android.widget.EditText" package="app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="true" selected="false" bounds="[0,0][100,50]" /></hierarchy>
X
t "password masked"             "$(ut dump "${work}/pw.xml" | grep -c hunter22 || true)" 0

# ------------------------------------------- an isolated PATH for the fakes
iso="${work}/iso"; mkdir -p "${iso}"
for c in bash sh sed grep awk tr tail head cat mktemp rm python3 dirname sleep wc printf env; do   # no timeout, as on macOS
    p="$(command -v "${c}" 2>/dev/null)" || continue
    case "${p}" in /*) ln -sf "${p}" "${iso}/${c}" ;; esac
done
fake() { printf '#!%s\n%s\n' "$(command -v sh)" "$2" > "${iso}/$1"; chmod +x "${iso}/$1"; }
fake getprop 'case "$1" in ro.build.version.release) echo 16 ;; ro.build.version.sdk) echo 36 ;; esac'
fake id 'echo 10372'
fake am 'echo "Error type 3"; echo "Error: Activity class {$4} does not exist."; exit 2'
syscmd="${work}/syscmd"
pkgs() { printf '#!%s\nfor p in %s; do echo "package:$p"; done\n' "$(command -v sh)" "$*" > "${syscmd}"; chmod +x "${syscmd}"; }
probe() { env -i PATH="${iso}" HOME="${work}/home" PREFIX="${work}/prefix" TMPDIR="${work}" TERMUX_APK_RELEASE=GITHUB TERMUX_PROBE_SYSCMD="${syscmd}" bash "${T}/bin/probe"; }
mkdir -p "${work}/home" "${work}/prefix/bin"

pkgs com.termux com.whatsapp com.google.android.gm
fake termux-toast 'exit 0'
out="$(probe)"
t "probe: android line"         "$(echo "${out}" | sed -n 1p)" "android: 16 (sdk 36); uid 10372, not rooted; termux from GITHUB"
t "probe: apps"                 "$(echo "${out}" | sed -n 's/^apps: //p')" "whatsapp, gmail"
t "probe: tier 0"               "$(echo "${out}" | grep -c '^tier 0 intents: yes')" 1
t "probe: cli without the app"  "$(echo "${out}" | grep -c '^tier 1 termux-api: no (the termux-\* commands are installed but the Termux:API app is not')" 1
t "probe: no shell channel"     "$(echo "${out}" | sed -n 's/^tier 2 shell: //p')" "no (rish: not found; adb: not installed (pkg install android-tools))"
t "probe: shizuku"              "$(echo "${out}" | sed -n 's/^shizuku: //p')" "not installed"
t "probe: tiers"                "$(echo "${out}" | sed -n 's/^tiers: //p')" 0
t "probe: next names tiers.md"  "$(echo "${out}" | grep -c "^next: .*${T}/ref/tiers.md")" 1

pkgs com.termux com.termux.api moe.shizuku.privileged.api
fake rish 'case "$2" in "id -u") echo 2000 ;; esac'
out="$(probe)"
t "probe: tier 1 with the app"  "$(echo "${out}" | grep -c '^tier 1 termux-api: yes')" 1
t "probe: rish channel"         "$(echo "${out}" | sed -n 's/^tier 2 shell: //p')" "yes, via rish ${iso}/rish (ui dump, ui tap, ui type)"
t "probe: all tiers"            "$(echo "${out}" | sed -n 's/^tiers: //p')" "0 1 2"
t "probe: no next at tier 2"    "$(echo "${out}" | grep -c '^next:' || true)" 0
t "probe: shizuku installed"    "$(echo "${out}" | sed -n 's/^shizuku: //p')" installed
t "probe: no known app is not absence" "$(echo "${out}" | sed -n 's/^apps: //p')" "none of these messaging apps (others by role: see Which app is it)"

fake rish 'echo "Server is not running"; exit 1'
rm -f "${iso}/termux-toast"
fake adb 'case "$1" in devices) printf "List of devices attached\r\nemulator-5554\tdevice\r\nlocalhost:37123\tdevice\r\n\r\n" ;; -s) [ "$2" = localhost:37123 ] && [ "$4" = "id -u" ] && printf "2000\r\n" ;; esac'
out="$(probe)"
t "probe: rish down, adb used"  "$(echo "${out}" | sed -n 's/^tier 2 shell: //p')" "yes, via adb localhost:37123 (ui dump, ui tap, ui type)"
t "probe: app without the cli"  "$(echo "${out}" | grep -c 'pkg install termux-api')" 1
fake adb 'case "$1" in devices) printf "List of devices attached\nlocalhost:37123\tunauthorized\n\n" ;; esac'
out="$(probe)"
t "probe: unauthorized adb"     "$(echo "${out}" | grep -c '^tier 2 shell: no (rish (.*) did not answer as shell: Server is not running.*adb: no connected device (localhost:37123=unauthorized)')" 1
rm -f "${iso}/rish" "${iso}/adb"
fake am 'echo "Starting: Intent { cmp=com.termux/.X }"'
pkgs
out="$(probe)"
t "probe: am not reaching the system" "$(echo "${out}" | grep -c '^tier 0 intents: no')" 1
t "probe: no packages"          "$(echo "${out}" | sed -n 's/^apps: //p')" "unreadable (cmd package list packages gave nothing)"
t "probe: tiers none"           "$(echo "${out}" | sed -n 's/^tiers: //p')" none

# ------------------------------------------------- ui through a fake rish
log="${work}/rish.log"; : > "${log}"
cat > "${work}/fakerish" <<SH
#!$(command -v sh)
printf '%s\n' "\$2" >> "${log}"
case "\$2" in
    *"uiautomator dump"*) cat "\${UI_FIXTURE}" ;;
    "wm size") echo "Physical size: 1080x2400" ;;
    "id -u") echo 2000 ;;
esac
SH
chmod +x "${work}/fakerish"
ui() { env -i PATH="${iso}" HOME="${work}/home" TMPDIR="${work}" UI_FIXTURE="${UI_FIXTURE}" TERMUX_UI_CHANNEL="rish ${work}/fakerish" bash "${T}/bin/ui" "$@"; }
taps() { grep -c '^input tap' "${log}" || true; }
UI_FIXTURE="${fx}/chats.xml"
t "ui channel: pinned"          "$(ui channel)" "rish ${work}/fakerish"
t "ui dump"                     "$(ui dump | sed -n 1p)" "screen: com.whatsapp 1080x2400, 8 of 11 nodes"
t "ui dump <word>"              "$(ui dump tahir | sed 1d | wc -l | tr -d ' ')" 2
t "ui dump cleans up the device" "$(grep -c 'rm -f /data/local/tmp/lc-ui.xml' "${log}")" 2
ui tap "taha test" >/dev/null
t "ui tap by text"              "$(grep '^input tap' "${log}" | tail -n 1)" "input tap 540 357"
: > "${log}"; rc=0; ui tap tah >/dev/null || rc=$?
t "ui tap ambiguous: exit 2"    "${rc}" 2
t "ui tap ambiguous: no tap"    "$(taps)" 0
UI_FIXTURE="${fx}/chat.xml"
rc=0; out="$(ui tap --desc send)" || rc=$?
t "ui tap Send unconfirmed: exit 6" "${rc}" 6
t "ui tap Send unconfirmed: no tap" "$(taps)" 0
t "ui tap Send: says why"       "$(echo "${out}" | grep -c 'awaiting confirmation')" 1
rc=0; ui tap 920 180 >/dev/null || rc=$?
t "ui tap a call point: exit 6" "${rc}" 6
ui tap --desc send --confirmed >/dev/null
t "ui tap Send confirmed"       "$(grep '^input tap' "${log}" | tail -n 1)" "input tap 990 2260"
: > "${log}"; ui tap 510 2260 >/dev/null
t "ui tap a point"              "$(grep '^input tap' "${log}")" "input tap 510 2260"
ui type "hi there, it's 5% done" >/dev/null
c="$(grep '^input text ' "${log}" | tail -n 1)"; eval "set -- ${c#input text }"
t "ui type: one quoted arg, spaces as %s" "$1" "hi%sthere,%sit's%s5%%sdone"
rc=0; ui type "görüşürüz" 2>/dev/null || rc=$?
t "ui type non-ASCII refused"   "${rc}" 4
ui key enter >/dev/null; ui key 279 >/dev/null
t "ui key"                      "$(grep '^input keyevent' "${log}" | tr '\n' '|')" "input keyevent 66|input keyevent 279|"
rc=0; ui key 'x; reboot' 2>/dev/null || rc=$?
t "ui key rejects junk"         "${rc}" 2
ui swipe up >/dev/null
t "ui swipe up"                 "$(grep '^input swipe' "${log}")" "input swipe 540 2000 540 400 300"
UI_FIXTURE="${work}/bad.xml"; rc=0; ui dump >/dev/null 2>&1 || rc=$?
t "ui dump failing: exit 4"     "${rc}" 4
rc=0; out="$(env -i PATH="${iso}" HOME="${work}/home" PREFIX="${work}/prefix" TMPDIR="${work}" bash "${T}/bin/ui" dump 2>&1)" || rc=$?
t "ui without a channel: exit 3" "${rc}" 3
t "ui without a channel: says so" "$(echo "${out}" | grep -c '^no shell channel')" 1
exit "${fail}"
