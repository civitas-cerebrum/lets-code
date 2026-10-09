#!/usr/bin/env bash
# Runs every test that needs no model server and no tmux: the shell tests
# (probes, endpoint parsing, helper prefetch, git guard launch side) and the
# node tests for the pi extensions, against the extension sources extracted
# from ./lets-code. Needs bash, python3, git, node >= 22.6.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/.." && pwd)"
skip="mem-guard-live.sh run.sh"           # need a live server / tmux
fail=0; ran=0

run() {  # run <label> <cmd...>
    ran=$((ran + 1))
    echo "=== $1"
    shift
    if "$@"; then echo "--- ok"; else echo "--- FAIL"; fail=1; fi
}

for t in "${here}"/*.sh; do
    case " ${skip} " in *" $(basename "${t}") "*) continue ;; esac
    run "$(basename "${t}")" bash "${t}"
done

# the extensions lets-code writes into ~/.pi/agent/extensions, produced here
# into a scratch agent dir from the functions in the script
agent="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-ci.XXXXXX")"
trap 'rm -rf "${agent}"' EXIT
mkdir -p "${agent}/extensions"
# (the extension sources contain lines that start with "}", so the functions
# are cut out by their heredoc terminator rather than by a sed range)
python3 - "${root}/lets-code" > "${agent}/writers.sh" <<'PYX'
import sys
s = open(sys.argv[1]).read()
for name in ("pi_write_gitguard_extension", "pi_write_memguard_extension", "pi_write_agentguard_extension", "pi_write_mandate_extension", "pi_write_subagent_extension", "pi_write_sandbox_extension", "pi_write_sessiontag_extension"):
    i = s.find("\n%s() {" % name)
    if i < 0:
        continue
    j = s.find("\nTS\n", i)
    k = s.find("\n}\n", j)
    sys.stdout.write(s[i:k + 3])
PYX
(
    set -e
    PI_AGENT_DIR="${agent}"
    LOG_PREFIX="[lets-code]"; log() { :; }; log_verbose() { :; }; VERBOSE=false
    npm() { return 1; }     # the sandbox writer would install its runtime; not here
    SANDBOX_RUNTIME_VERSION="test"; SB_NOTE=""
    . "${agent}/writers.sh"
    for f in pi_write_gitguard_extension pi_write_memguard_extension pi_write_agentguard_extension pi_write_mandate_extension pi_write_subagent_extension pi_write_sandbox_extension pi_write_sessiontag_extension; do
        if declare -F "${f}" >/dev/null; then "${f}"; fi
    done
) || { echo "could not extract the extensions from lets-code"; exit 1; }

for t in "${here}"/*.test.mjs; do
    [ -e "${t}" ] || continue
    case "$(basename "${t}")" in
        git-guard*|git-checkpoint*) ext="${agent}/extensions/lets-code-gitguard.ts" ;;
        agent-guard*)               ext="${agent}/extensions/lets-code-agentguard.ts" ;;
        mem-guard*)                 ext="${agent}/extensions/lets-code-memguard.ts" ;;
        mandate*)                   ext="${agent}/extensions/lets-code-mandate.ts" ;;
        subagent*)                  ext="${agent}/extensions/lets-code-subagent.ts" ;;
        sandbox*)                   ext="${agent}/extensions/lets-code-sandbox/index.ts" ;;
        session-tag*)               ext="${agent}/extensions/lets-code-sessiontag.ts" ;;
        *)                          ext="" ;;
    esac
    if [ -n "${ext}" ] && [ ! -f "${ext}" ]; then echo "=== $(basename "${t}"): skipped (no ${ext##*/} in this build)"; continue; fi
    run "$(basename "${t}")" node "${t}" ${ext:+"${ext}"}
done

echo
echo "${ran} test files, $([ "${fail}" = 0 ] && echo all passed || echo FAILURES)"
exit "${fail}"
