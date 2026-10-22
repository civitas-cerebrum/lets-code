#!/usr/bin/env bash
# Unit test for pi_write_software_factory: extracts the writer from ./lets-code, runs it against a
# scratch agent dir, and checks the expert it writes (the factory runner, the brief).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "${here}/../lets-code" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\npi_write_software_factory() {")
j = s.find("\n}  # end of pi_write_software_factory\n", i)
sys.stdout.write(s[i:j + len("\n}  # end of pi_write_software_factory\n")])
PY
)"
PI_AGENT_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/software-factory-test.XXXXXX")" && pwd)"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
af="${PI_AGENT_DIR}/agents/software-factory.md"
pi_write_software_factory
t "agent file written"      "$(grep -c '^# Written by lets-code' "${af}")" 1
t "an expert"               "$(sed -n 's/^expert: //p' "${af}")" true
t "paths filled in"         "$(grep -c '@@D@@' "${af}" || true)" 0
t "the factory runner"      "$(sed -n 's/^runner: //p' "${af}")" factory
t "in the always-on line"   "$(grep -c '^route:' "${af}")" 0
t "everywhere, no setup"    "$(grep -cE '^(platform|setup|setup_note|requires|agent_dir|append_prompt|tools|role):' "${af}" || true)" 0
t "use_for fits the line"   "$([ "$(sed -n 's/^use_for: //p' "${af}" | wc -c)" -le 101 ] && echo yes)" yes
t "job under 300"           "$([ "$(sed -n 's/^job: //p' "${af}" | wc -c)" -le 301 ] && echo yes)" yes
t "brief template"          "$(sed -n 's/^  - \([a-z_]*\).*/\1/p' "${af}" | tr '\n' ' ')" "ticket criteria repo how_to_run start constraints resume decision text "
t "no required field (a ticket, or resume)" "$(grep -c '^  - [a-z_]* (required):' "${af}")" 0
t "body: runs in the main session" "$(grep -c '^it in the main session (runner: factory), because each of its stages is an$' "${af}")" 1
t "body: nothing pushed"    "$(grep -c 'Nothing is pushed.' "${af}")" 1
before="$(cat "${af}")"; pi_write_software_factory
t "rewrite is stable"       "$(cat "${af}")" "${before}"
printf -- '---\nname: software-factory\ndescription: mine\n---\nmine\n' > "${af}"; pi_write_software_factory
t "user's own file kept"    "$(grep -c 'description: mine' "${af}")" 1
rm -f "${af}"; pi_write_software_factory
t "no temp files left"      "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "software-factory.md "
# the builder's lint, as CI runs it for every built-in (tests/run.sh); its run
# path (the experts module calling factory.ts's runExpert) is in expert.test.mjs
# and factory.test.mjs
exit "${fail}"
