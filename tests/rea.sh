#!/usr/bin/env bash
# Unit test for pi_write_rea: extracts the function from ./lets-code and runs
# it against a scratch agent dir with a fake npm (installs a stub rea-agents)
# and a fake pi (records how the runner starts the child).
set -eu
src="$(dirname "$0")/../lets-code"
PI_AGENT_DIR=/nonexistent     # REA_DIR is derived from it; set for real below
eval "$(python3 - "${src}" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\nREA_VERSION=")
j = s.find("\n}\n", s.find("\nrea_write_agent() {"))
sys.stdout.write(s[i:j + 3])
PY
)"
LOG_PREFIX="[lets-code]"; log() { echo "${LOG_PREFIX} ${1}"; }

work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/rea-test.XXXXXX")" && pwd)"   # macOS TMPDIR ends in /; the runner sees the cd'd path
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin" "${work}/agent/skills/mine" "${work}/agent/sessions" "${work}/agent/extensions"
cat > "${work}/bin/npm" <<'SH'
#!/bin/sh
v="$(python3 -c 'import json; print(json.load(open("package.json"))["dependencies"]["rea-agents"])')"
mkdir -p node_modules/rea-agents/scripts node_modules/rea-agents/skills/reverse-engineer-anything
printf '{"version":"%s"}' "${v}" > node_modules/rea-agents/package.json
touch node_modules/rea-agents/scripts/rea.mjs
echo x >> "${NPM_LOG}"
SH
cat > "${work}/bin/pi" <<'SH'
#!/bin/sh
{ echo "dir=${PI_CODING_AGENT_DIR}"; echo "depth=${LETS_CODE_SUBAGENT_DEPTH}"; for a in "$@"; do echo "arg=${a}"; done; } > "${PI_LOG}"
echo "## Answer"; echo "it works"
SH
chmod +x "${work}/bin/npm" "${work}/bin/pi"
export PATH="${work}/bin:${PATH}" NPM_LOG="${work}/npm.log" PI_LOG="${work}/pi.log"
echo '{}' > "${work}/agent/models.json"; echo '{}' > "${work}/agent/settings.json"
echo '{"mcpServers":{"other":{"command":"x"}}}' > "${work}/agent/mcp.json"
PI_AGENT_DIR="${work}/agent"; REA_DIR="${PI_AGENT_DIR}/rea"
a="${REA_DIR}/agent"

fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }

pi_write_rea on >/dev/null 2>&1
t "ready"                          "${REA_NOTE}" ""
t "installed once"                 "$(wc -l < "${NPM_LOG}" | tr -d ' ')" 1
t "models linked"                  "$(readlink "${a}/models.json")" "${PI_AGENT_DIR}/models.json"
t "extensions linked"              "$([ -L "${a}/extensions" ] && echo yes)" yes
t "main mcp.json not linked"       "$([ -L "${a}/mcp.json" ] && echo linked || echo own)" own
t "skills not linked"              "$([ -e "${a}/skills" ] && echo yes || echo no)" no
t "sessions not linked"            "$([ -e "${a}/sessions" ] && echo yes || echo no)" no
t "no self link"                   "$([ -e "${a}/rea" ] && echo yes || echo no)" no
t "child has only rea"             "$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["mcpServers"]))' "${a}/mcp.json")" rea
t "compact schemas"                "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mcpServers"]["rea"]["env"]["REA_MCP_INPUT_SCHEMA_PROFILE"])' "${a}/mcp.json")" compact
t "main mcp.json untouched"        "$(cat "${PI_AGENT_DIR}/mcp.json")" '{"mcpServers":{"other":{"command":"x"}}}'
t "skill model-invocable"          "$(grep -c disable-model-invocation "${REA_DIR}/skill/reverse-engineering/SKILL.md")" 0

# the reverse-engineer agent type (shown only where the launch picks it)
af="${PI_AGENT_DIR}/agents/reverse-engineer.md"
t "agent file written"             "$(grep -c '^# Written by lets-code' "${af}")" 1
t "agent: in place"                "${REA_AGENT}" 1
t "agent: REA's agent dir"         "$(grep '^agent_dir:' "${af}")" "agent_dir: rea/agent"
t "agent: REA's prompt"            "$([ -f "${PI_AGENT_DIR}/$(sed -n 's/^append_prompt: //p' "${af}")" ] && echo yes)" yes
t "agent: REA's skill exists"      "$([ -d "${PI_AGENT_DIR}/$(sed -n 's/^skills: //p' "${af}")" ] && echo yes)" yes
t "agent: requires the runtime"    "$([ -e "${PI_AGENT_DIR}/$(sed -n 's/^requires: //p' "${af}")" ] && echo yes)" yes
t "agent: timeout 3600"            "$(grep '^timeout:' "${af}")" "timeout: 3600"
t "agent: a specialist"            "$(is_specialist_file "${af}" && echo yes)" yes
t "agent: its setup script"        "$([ -x "${PI_AGENT_DIR}/$(sed -n 's/^setup: //p' "${af}")" ] && echo yes)" yes
t "agent: brief template"          "$(sed -n 's/^  - \([a-z]*\).*/\1/p' "${af}" | tr '\n' ' ')" "target question purpose "
t "agent: required fields"         "$(grep -c '^  - [a-z]* (required):' "${af}")" 2
surface() { ( unset LETS_CODE_REA_AGENT; LETS_CODE_SUBAGENTS_ON="$2"; LETS_CODE_SPECIALISTS_ON="${3:-}"; rea_surface "$1"; echo "${REA_SURFACE}:${LETS_CODE_REA_AGENT:-}" ); }
t "specialists on: specialist"     "$(surface on 1 1)" "specialist:"
t "subagents on: agent, no skill"  "$(surface on 1)" "agent:1"
t "subagents off: skill (rea/run)" "$(surface on '')" "skill:"
t "manual: skill only, no agent"   "$(surface manual 1)" "skill:"
t "manual: no specialist either"   "$(surface manual 1 1)" "skill:"
rm -rf "${PI_AGENT_DIR}/agents"; mkdir -p "${PI_AGENT_DIR}/agents"
printf -- '---\nname: reverse-engineer\ndescription: mine\n---\nmine\nspecialist: true\n' > "${af}"
pi_write_rea on >/dev/null 2>&1
t "user's own file kept"           "$(grep -c 'description: mine' "${af}")" 1
t "user's file: not ours"          "${REA_AGENT:-none}" none
t "user's file: skill instead"     "$(surface on 1)" "skill:"
t "user's file: not a specialist"  "$(surface on 1 1)" "skill:"
printf -- '---\nname: reverse-engineer\ndescription: mine\nspecialist: true\n---\nmine\n' > "${af}"
t "user's specialist: specialist"  "$(surface on 1 1)" "specialist:"
rm -f "${af}"
pi_write_rea on >/dev/null 2>&1
t "agent rewritten after removal"  "$(grep -c '^# Written by lets-code' "${af}")" 1
t "no temp files left"             "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "reverse-engineer.md "

# user env on the entry survives; a file pi replaced is linked again; no reinstall
python3 - "${a}/mcp.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["mcpServers"]["rea"]["env"]["GHIDRA_INSTALL_DIR"] = "/opt/ghidra"
json.dump(d, open(sys.argv[1], "w"))
PY
rm "${a}/settings.json"; echo '{"x":1}' > "${a}/settings.json"
rm "${PI_AGENT_DIR}/models.json"
pi_write_rea manual >/dev/null
t "user env kept"                  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mcpServers"]["rea"]["env"].get("GHIDRA_INSTALL_DIR"))' "${a}/mcp.json")" /opt/ghidra
t "replaced file relinked"         "$(readlink "${a}/settings.json")" "${PI_AGENT_DIR}/settings.json"
t "dangling link removed"          "$([ -L "${a}/models.json" ] && echo yes || echo no)" no
t "no reinstall"                   "$(wc -l < "${NPM_LOG}" | tr -d ' ')" 1
t "manual hides the skill"         "$(grep -c 'disable-model-invocation: true' "${REA_DIR}/skill/reverse-engineering/SKILL.md")" 1

# the runner
out="$(env -u LETS_CODE_REA_PROVIDER "${REA_DIR}/run" "x" 2>&1 || true)"
t "runner needs lets-code env"     "$(echo "${out}" | grep -c 'launch pi through lets-code')" 1
out="$(LETS_CODE_REA_PROVIDER=lets-code LETS_CODE_REA_MODEL=m LETS_CODE_SUBAGENT_DEPTH=0 "${REA_DIR}/run" "explain search in /apps/notes")"
t "runner prints the report"       "$(echo "${out}" | tail -n 1)" "it works"
t "child uses its own agent dir"   "$(grep '^dir=' "${PI_LOG}")" "dir=${a}"
t "child is one level deeper"      "$(grep '^depth=' "${PI_LOG}")" "depth=1"
t "child gets the REA skill"       "$(grep -c '^arg=.*rea-agents/skills/reverse-engineer-anything$' "${PI_LOG}")" 1
t "child gets the task"            "$(grep -c '^arg=Task: explain search in /apps/notes$' "${PI_LOG}")" 1
t "child has no session"           "$(grep -c '^arg=--no-session$' "${PI_LOG}")" 1

# files (specialists on, not enabled): everything but the install
rm -rf "${REA_DIR}" "${af}"; : > "${NPM_LOG}"
pi_write_rea files >/dev/null
t "files: no install"              "$(wc -l < "${NPM_LOG}" | tr -d ' ')" 0
t "files: agent file, no agent dir" "$([ -e "${af}" ] && echo yes):$([ -e "${a}" ] && echo yes || echo no):${REA_AGENT}" "yes:no:1"
t "files: setup script"            "$([ -x "${REA_DIR}/setup" ] && echo yes)" yes
t "files: setup --no-install says not installed" "$(bash "${REA_DIR}/setup" --no-install >/dev/null 2>&1; echo $?)" 3
bash "${REA_DIR}/setup" 2>/dev/null
t "setup by itself installs"       "$([ -f "${REA_DIR}/runtime/node_modules/rea-agents/package.json" ] && [ -L "${a}/settings.json" ] && echo yes)" yes
rm -f "${a}/settings.json"
pi_write_rea files >/dev/null
t "files: an installed one is refreshed" "$([ -L "${a}/settings.json" ] && echo yes):$(wc -l < "${NPM_LOG}" | tr -d ' ')" "yes:1"

# install fails: a note; the agent file is there but hidden (requires)
rm -rf "${REA_DIR}" "${af}"
mkdir -p "${work}/badbin"; printf '#!/bin/sh\nexit 1\n' > "${work}/badbin/npm"; chmod +x "${work}/badbin/npm"
PATH="${work}/badbin:${PATH}" pi_write_rea on >/dev/null 2>&1
t "install fails -> note"          "$(echo "${REA_NOTE}" | grep -c 'install failed')" 1
t "not installed -> no runtime"    "$([ -e "${PI_AGENT_DIR}/$(sed -n 's/^requires: //p' "${af}")" ] && echo yes || echo no)" no

# no npm: a note, nothing half-written
rm -rf "${REA_DIR}"
PATH="$(printf '%s' "${PATH}" | sed "s|${work}/bin:||")"
if ! command -v npm >/dev/null 2>&1; then
    pi_write_rea on >/dev/null 2>&1
    t "no npm -> note"             "$(echo "${REA_NOTE}" | grep -c 'npm not found')" 1
fi
exit ${fail}
