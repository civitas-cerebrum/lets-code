#!/usr/bin/env bash
# Unit test for pi_write_developer: extracts the writer from ./lets-code, runs
# it against a scratch agent dir, and checks the expert it writes: least
# privilege (pi's file tools, the developer role), the brief, the report
# format a caller parses (the STATUS line, fixed headings), ownership and a
# stable rewrite.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "${here}/../lets-code" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\npi_write_developer() {")
j = s.find("\n}  # end of pi_write_developer\n", i)
sys.stdout.write(s[i:j + len("\n}  # end of pi_write_developer\n")])
PY
)"
PI_AGENT_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/developer-test.XXXXXX")" && pwd)"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
af="${PI_AGENT_DIR}/agents/developer.md"
pi_write_developer
t "agent file written"            "$(grep -c '^# Written by lets-code (developer)' "${af}")" 1
t "an expert"                     "$(sed -n 's/^expert: //p' "${af}")" true
t "pi's file tools, no more"      "$(sed -n 's/^tools: //p' "${af}")" "read, bash, edit, write, grep, find, ls"
t "the developer role"            "$(sed -n 's/^role: //p' "${af}")" developer
t "everywhere, nothing to set up" "$(grep -cE '^(platform|setup|setup_note|requires|agent_dir|append_prompt):' "${af}" || true)" 0
t "not in the always-on line"    "$(sed -n 's/^route: //p' "${af}")" false
t "timeout 3600"                  "$(sed -n 's/^timeout: //p' "${af}")" 3600
t "use_for fits the line"         "$([ "$(sed -n 's/^use_for: //p' "${af}" | wc -c)" -le 101 ] && echo yes)" yes
t "brief template"                "$(sed -n 's/^  - \([a-z_]*\).*/\1/p' "${af}" | tr '\n' ' ')" "task criteria mode plan findings how_to_run constraints "
t "one required field"            "$(grep -c '^  - [a-z_]* (required):' "${af}")" 1
t "no paths left to fill"         "$(grep -c '@@D@@' "${af}" || true)" 0
t "never commits"                 "$(grep -c 'Leave the change uncommitted' "${af}")" 1
t "plan mode changes nothing"     "$(grep -c '^3. Mode plan: write the plan (format below) and stop. Change no file.$' "${af}")" 1
t "status line"                   "$(grep -c '^The first line is `STATUS: PLAN`, `STATUS: DONE` or `STATUS: BLOCKED`.$' "${af}")" 1
t "report headings"               "$(sed -n '/^## Final message/,$p' "${af}" | grep '^## ' | tr '\n' '|')" "## Final message|## Plan|## Tests|## Risks|## Changes|## Tests|## Criteria|## Findings|## Notes|"
t "criterion and finding lines"   "$(grep -c -E '^`C<n>: covered by <test>`|^`<id>: fixed: <how>`' "${af}")" 2
t "no harness tools"              "$(grep -c -E '\b(Skill|Task|TodoWrite|WebFetch) ?[({]' "${af}" || true)" 0
t "under 700 words"               "$([ "$(wc -w < "${af}")" -le 700 ] && echo yes)" yes
before="$(cat "${af}")"; pi_write_developer
t "rewrite is stable"             "$(cat "${af}")" "${before}"
printf -- '---\nname: developer\ndescription: mine\n---\nmine\n' > "${af}"; pi_write_developer
t "user's own file kept"          "$(grep -c 'description: mine' "${af}")" 1
rm -f "${af}"; pi_write_developer
t "no temp files left"            "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "developer.md "
exit "${fail}"
