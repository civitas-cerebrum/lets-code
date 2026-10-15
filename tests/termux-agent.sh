#!/usr/bin/env bash
# Unit test for write_termux_agent: the termux-device file lets-code writes
# (and keeps current): an expert (only on Termux, one required brief
# field), and a user's own file of that name left alone.
set -eu
eval "$(sed -n '/^write_termux_agent() {/,/^}$/p; /^on_termux() {/p' "$(dirname "$0")/../lets-code")"
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
PI_AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termux-agent.XXXXXX")"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
af="${PI_AGENT_DIR}/agents/termux-device.md"
write_termux_agent
t "agent file written"          "$(grep -c '^# Written by lets-code' "${af}")" 1
t "name"                        "$(sed -n 's/^name: //p' "${af}")" termux-device
t "no launch gate"              "$(grep -c '^requires_env:' "${af}" || true)" 0
t "tools"                       "$(sed -n 's/^tools: //p' "${af}")" "bash, read"
t "no device-specific uid"      "$(grep -c '10372' "${af}" || true)" 0
t "frontmatter closed"          "$(grep -c '^---$' "${af}")" 2
t "an expert"                "$(sed -n 's/^expert: //p' "${af}")" true
t "only on Termux"              "$(sed -n 's/^platform: //p' "${af}")" termux
t "brief: the goal, required"   "$(sed -n 's/^  - //p' "${af}")" "goal (required): the user's goal, verbatim"
before="$(cat "${af}")"; write_termux_agent
t "rewrite is stable"           "$(cat "${af}")" "${before}"
printf -- '---\nname: termux-device\ndescription: mine\n---\nmine\n' > "${af}"
write_termux_agent
t "user's own file kept"        "$(grep -c 'description: mine' "${af}")" 1
t "no temp files left"          "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "termux-device.md "
( PREFIX=/data/data/com.termux/files/usr; on_termux ) && r=yes || r=no
t "Termux detected by PREFIX"   "${r}" yes
exit "${fail}"
