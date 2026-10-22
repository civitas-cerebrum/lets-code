#!/usr/bin/env bash
# Unit test for pi_write_tester (the test lead), pi_write_api_tester and the
# move from the tester of before (lc_migrate_ui_tester): extracts the
# functions from ./lets-code and runs them against a scratch agent dir.
set -eu
src="$(dirname "$0")/../lets-code"
eval "$(python3 - "${src}" <<'PY'
import sys
s = open(sys.argv[1]).read()
for start, end in (("\npi_write_tester() {", "\n}  # end of pi_write_tester\n"), ("\npi_write_api_tester() {", "\n}  # end of pi_write_api_tester\n"),
                   ("\nlc_expert_remembered() {", "\n}\n"), ("\nlc_migrate_ui_tester() {", "\n}\n")):
    i = s.find(start); j = s.find(end, i)
    if i < 0 or j < 0: sys.exit("cannot find %s" % start.strip())
    sys.stdout.write(s[i:j + len(end)])
PY
)"
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/tester-test.XXXXXX")" && pwd)"
trap 'rm -rf "${work}"' EXIT
PI_AGENT_DIR="${work}/agent"; mkdir -p "${PI_AGENT_DIR}"
d="${PI_AGENT_DIR}/tester"; af="${PI_AGENT_DIR}/agents/tester.md"

fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }

# the tester of before left its browser half here
mkdir -p "${d}/bin" "${d}/ref" "${d}/runtime" "${d}/work/proj"
: > "${d}/setup"; : > "${d}/prompt.md"; : > "${d}/bin/e2e-init"; : > "${d}/ref/api-web.md"; : > "${d}/ref/bugs.md"
echo "pins" > "${d}/runtime/.installed"
printf '{"experts": {"tester": true, "researcher": true}, "other": 1}\n' > "${PI_AGENT_DIR}/lets-code-state.json"
lc_migrate_ui_tester
t "migrate: the runtime moves to ui-tester"     "$(cat "${PI_AGENT_DIR}/ui-tester/runtime/.installed" 2>/dev/null)" pins
t "migrate: and the work folder"                "$([ -d "${PI_AGENT_DIR}/ui-tester/work/proj" ] && echo yes)" yes
t "migrate: a yes for tester is one for ui-tester, the rest kept" "$(python3 -c "import json; s=json.load(open('${PI_AGENT_DIR}/lets-code-state.json')); print(s['experts'].get('ui-tester'), s['experts'].get('tester'), s['experts'].get('researcher'), s['other'])")" "True True True 1"
python3 -c "import json; p='${PI_AGENT_DIR}/lets-code-state.json'; s=json.load(open(p)); s['experts']['ui-tester']=False; json.dump(s, open(p,'w'))"
lc_migrate_ui_tester
t "migrate: a later no for ui-tester stays"     "$(python3 -c "import json; print(json.load(open('${PI_AGENT_DIR}/lets-code-state.json'))['experts']['ui-tester'])")" False

pi_write_tester
t "the browser half's files go"                 "$(ls "${d}" | tr '\n' ' '):$(ls "${d}/ref" | grep -c -E '^(api-web|bugs)\.md$')" "ref :0"
t "the references"                              "$(ls "${d}/ref" | tr '\n' ' ')" "nonfunctional.md reporting.md strategy.md team.md techniques.md terminal.md workflows.md "
t "the agent file: name, role, team"            "$(grep -c -E '^(name: tester|role: tester|team: ui-tester, api-tester)$' "${af}")" 3
t "the expert tool for its team"                "$(grep -c '^tools: .*\bexpert$' "${af}")" 1
t "no platform, no setup: everywhere"           "$(grep -c -E '^(platform|setup|requires):' "${af}")" 0
t "paths filled in"                             "$(cat "${af}" "${d}"/ref/*.md | grep -c '@@D@@')" 0
for r in "${d}"/ref/*.md; do
    t "body names $(basename "${r}")"           "$(grep -q "${r}" "${af}" && echo yes)" yes
done
t "team.md: both specialists, their briefs"     "$(grep -c -E "ui-tester's fields|api-tester's:" "${d}/ref/team.md")" 2
t "terminal.md: tmux, the session killed"       "$(grep -c -E 'tmux (new-session|send-keys|capture-pane|kill-session)' "${d}/ref/terminal.md")" 4
t "reporting.md: the pipeline's format"         "$(grep -c 'VERDICT:' "${d}/ref/reporting.md")" 1
t "refs carry the lets-code line"               "$(grep -L 'Written by lets-code (tester)' "${d}"/ref/*.md | wc -l | tr -d ' ')" 0
pi_write_tester
t "again: nothing changes, no temp left"        "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' '):$(ls "${d}/ref" | grep -c tmp)" "tester.md :0"
printf -- '---\nname: tester\ndescription: mine\n---\nmine\n' > "${af}"
pi_write_tester
t "a user's own tester is left alone"           "$(tail -n 1 "${af}")" mine

pi_write_api_tester
aa="${PI_AGENT_DIR}/agents/api-tester.md"
t "api-tester: name, developer role, not routed" "$(grep -c -E '^(name: api-tester|role: developer|route: false)$' "${aa}")" 3
t "api-tester: no expert tool, no team"         "$(grep -c -E '^team:|\bexpert$' "${aa}")" 0
t "api-tester: auth by env var name"            "$(grep -c 'env var names' "${aa}")" 1

[ "${fail}" = 0 ] && echo "all passed" || exit 1
