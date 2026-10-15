#!/usr/bin/env bash
# Unit test for write_termux_agent: the termux-device agent file lets-code
# writes (and keeps current), listed only with LETS_CODE_TERMUX_AGENT, and
# a user's own file of that name left alone.
set -eu
eval "$(sed -n '/^write_termux_agent() {/,/^}$/p; /^on_termux() {/p' "$(dirname "$0")/../lets-code")"
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
PI_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termux-agent.XXXXXX")"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
af="${PI_AGENT_DIR}/agents/termux-device.md"
write_termux_agent
t "agent file written"          "$(grep -c '^# Written by lets-code' "${af}")" 1
t "name"                        "$(sed -n 's/^name: //p' "${af}")" termux-device
t "listed only when switched on" "$(sed -n 's/^requires_env: //p' "${af}")" LETS_CODE_TERMUX_AGENT
t "tools"                       "$(sed -n 's/^tools: //p' "${af}")" "bash, read"
t "no device-specific uid"      "$(grep -c '10372' "${af}" || true)" 0
t "frontmatter closed"          "$(grep -c '^---$' "${af}")" 2
before="$(cat "${af}")"; write_termux_agent
t "rewrite is stable"           "$(cat "${af}")" "${before}"
printf -- '---\nname: termux-device\ndescription: mine\n---\nmine\n' > "${af}"
write_termux_agent
t "user's own file kept"        "$(grep -c 'description: mine' "${af}")" 1
t "no temp files left"          "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "termux-device.md "
( PREFIX=/data/data/com.termux/files/usr; on_termux ) && r=yes || r=no
t "Termux detected by PREFIX"   "${r}" yes
exit "${fail}"
