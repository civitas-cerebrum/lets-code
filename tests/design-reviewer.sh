#!/usr/bin/env bash
# Unit test for pi_write_design_reviewer: extracts the writer from ./lets-code,
# runs it against a scratch agent dir, and checks the expert it writes:
# read-and-run tools under the reviewer role, the brief, its reference, the
# verdict and findings format a caller parses, no overlap with the expert
# reviewer's job, ownership and a stable rewrite.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "${here}/../lets-code" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\npi_write_design_reviewer() {")
j = s.find("\n}  # end of pi_write_design_reviewer\n", i)
sys.stdout.write(s[i:j + len("\n}  # end of pi_write_design_reviewer\n")])
PY
)"
PI_AGENT_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/design-reviewer-test.XXXXXX")" && pwd)"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
af="${PI_AGENT_DIR}/agents/design-reviewer.md"; D="${PI_AGENT_DIR}/design-reviewer"
pi_write_design_reviewer
t "agent file written"            "$(grep -c '^# Written by lets-code (design-reviewer)' "${af}")" 1
t "an expert"                     "$(sed -n 's/^expert: //p' "${af}")" true
t "read and run, no edit"         "$(sed -n 's/^tools: //p' "${af}")" "read, bash, grep, find, ls"
t "the reviewer role"             "$(sed -n 's/^role: //p' "${af}")" reviewer
t "everywhere, nothing to set up" "$(grep -cE '^(platform|setup|setup_note|requires|agent_dir|append_prompt):' "${af}" || true)" 0
t "timeout 1800"                  "$(sed -n 's/^timeout: //p' "${af}")" 1800
t "use_for fits the line"         "$([ "$(sed -n 's/^use_for: //p' "${af}" | wc -c)" -le 101 ] && echo yes)" yes
t "brief template"                "$(sed -n 's/^  - \([a-z_]*\).*/\1/p' "${af}" | tr '\n' ' ')" "diff context conventions previous_findings constraints "
t "one required field"            "$(grep -c '^  - [a-z_]* (required):' "${af}")" 1
t "ref written"                   "$([ -s "${D}/ref/design.md" ] && echo yes)" yes
t "ref named with its path"       "$(grep -c "\`${D}/ref/design.md\`" "${af}")" 1
t "paths filled in"               "$(cat "${af}" "${D}"/ref/*.md | grep -c '@@D@@' || true)" 0
t "bugs are not its job"          "$(grep -c '^bugs, edge cases and failing tests (the expert reviewer' "${af}")" 1
t "bugs go to Notes"              "$(grep -c 'A bug you notice goes under' "${af}")" 1
t "verdict line"                  "$(grep -c '^The first line is `VERDICT: APPROVE` or `VERDICT: REVISE`.$' "${af}")" 1
t "verdict rule"                  "$(grep -c '^- Verdict REVISE when any blocker or major is open, else APPROVE.$' "${af}")" 1
t "four severities"               "$(sed -n '/^## Severity/,/^## Rules/p' "${af}" | grep -c -E '^- (blocker|major|minor|nit): ')" 4
t "previous ids stay stable"      "$(grep -c 'a previous finding still open keeps its id' "${af}")" 1
t "previous line"                 "$(grep -c '^`D<n>: FIXED` or `D<n>: OPEN`' "${af}")" 1
t "findings line format"          "$(grep -c '^`D<n> | <blocker|major|minor|nit> | <file>:<line> | <title>`$' "${af}")" 1
t "linters in check mode only"    "$(grep -c 'never `--fix` or `--write`' "${af}")" 1
t "headings"                      "$(grep '^## ' "${af}" | tr '\n' '|')" "## Tools here|## Order of work|## Severity|## Rules|## Final message|## Summary|## Findings|## Previous|## Notes|"
t "never edits the work"          "$(grep -c '^- Never edit, commit, stash, check out or install in the work' "${af}")" 1
t "no harness tools"              "$(cat "${af}" "${D}"/ref/*.md | grep -c -E '\b(Skill|Task|TodoWrite|WebFetch) ?[({]' || true)" 0
t "under 700 words"               "$([ "$(wc -w < "${af}")" -le 700 ] && echo yes)" yes
before="$(cat "${af}")"; pi_write_design_reviewer
t "rewrite is stable"             "$(cat "${af}")" "${before}"
printf -- '---\nname: design-reviewer\ndescription: mine\n---\nmine\n' > "${af}"; pi_write_design_reviewer
t "user's own file kept"          "$(grep -c 'description: mine' "${af}")" 1
rm -f "${af}"; pi_write_design_reviewer
t "no temp files left"            "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "design-reviewer.md "
exit "${fail}"
