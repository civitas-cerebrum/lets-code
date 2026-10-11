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
j = s.find("\n}\n", s.find("\npi_write_rea() {"))
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

pi_write_rea on >/dev/null
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

# no npm: a note, nothing half-written
rm -rf "${REA_DIR}"
PATH="$(printf '%s' "${PATH}" | sed "s|${work}/bin:||")"
if ! command -v npm >/dev/null 2>&1; then
    pi_write_rea on >/dev/null
    t "no npm -> note"             "$(echo "${REA_NOTE}" | grep -c 'npm not found')" 1
fi
exit ${fail}
