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

# the extension lets-code writes into ~/.pi/agent/extensions/lets-code (an
# index and one module per feature), produced here into a scratch agent dir
# from the functions in the script
agent="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-ci.XXXXXX")"
trap 'rm -rf "${agent}"' EXIT
mkdir -p "${agent}/extensions"
# (the extension sources contain lines that start with "}", so the functions
# are cut out by their heredoc terminator rather than by a sed range)
python3 - "${root}/lets-code" > "${agent}/writers.sh" <<'PYX'
import sys
s = open(sys.argv[1]).read()
# the helpers the writers share and the index of the one lets-code extension
# (the block between the "extension dirs" and "themes" section rules)
i = s.find("\n# ------------------------------------------------------------ extension dirs\n")
if i >= 0:
    sys.stdout.write(s[i:s.find("\n# ------------------------------------------------------------------ themes\n", i)])
for name in ("pi_write_gitguard_extension", "pi_write_memguard_extension", "pi_write_agentguard_extension", "pi_write_mandate_extension", "pi_write_subagent_extension", "pi_write_subagent_view_extension", "pi_write_experts_extension", "pi_write_sandbox_extension", "pi_write_sessiontag_extension", "pi_write_metrics_extension", "pi_write_grounding_extension", "pi_write_backend_extension", "pi_write_claudecode_extension", "pi_write_thinking_extension"):
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
    for f in pi_write_lets_code_extension pi_write_gitguard_extension pi_write_memguard_extension pi_write_agentguard_extension pi_write_mandate_extension pi_write_subagent_extension pi_write_experts_extension pi_write_sandbox_extension pi_write_sessiontag_extension pi_write_metrics_extension pi_write_grounding_extension pi_write_backend_extension pi_write_claudecode_extension pi_write_thinking_extension; do
        if declare -F "${f}" >/dev/null; then "${f}"; fi
    done
) || { echo "could not extract the extensions from lets-code"; exit 1; }

# the built-in experts, written by lets-code's own writers into a scratch
# agent dir (files only: nothing is installed) and linted as built-ins with
# the expert builder's expert-lint, the same check a new expert gets
python3 - "${root}/lets-code" > "${agent}/experts.sh" <<'PYX'
import sys
s = open(sys.argv[1]).read()
def cut(start, last_fn, end="\n}\n"):
    i = s.find(start)
    j = s.find(end, s.find(last_fn, i))
    if i < 0 or j < 0:
        sys.exit("cannot find %s in lets-code" % last_fn.strip())
    return s[i:j + len(end)]
sys.stdout.write(cut("\nREA_VERSION=", "\nrea_write_agent() {"))
sys.stdout.write(cut("\nTESTER_PINS=", "\ntester_write_agent() {"))
sys.stdout.write(cut("\nJUDGE_DIR=", "\njudge_write_agent() {"))
i = s.find("\n# Termux device expert:"); j = s.find("\non_termux() {", i)   # its writer, knowledge and on_termux
sys.stdout.write(s[i:s.find("\n", j + 1) + 1])
sys.stdout.write(cut("\npi_write_expert_builder() {", "\npi_write_expert_builder() {", "\n}  # end of pi_write_expert_builder\n"))
PYX
(
    set -e
    PI_AGENT_DIR="${agent}/builtin"; mkdir -p "${PI_AGENT_DIR}"
    LOG_PREFIX="[lets-code]"; log() { :; }
    . "${agent}/experts.sh"
    pi_write_rea files; pi_write_tester files; pi_write_judge; write_termux_agent; pi_write_expert_builder
) || { echo "could not write the built-in experts from lets-code"; exit 1; }
run "built-in experts: expert-lint --builtin" node "${agent}/builtin/expert-builder/bin/expert-lint" --builtin "${agent}/builtin/agents"

for t in "${here}"/*.test.mjs; do
    [ -e "${t}" ] || continue
    case "$(basename "${t}")" in
        lets-code*)                 ext="${agent}/extensions/lets-code/index.ts" ;;
        git-guard*|git-checkpoint*) ext="${agent}/extensions/lets-code/git-guard.ts" ;;
        agent-guard*)               ext="${agent}/extensions/lets-code/agent-guard.ts" ;;
        mem-guard*)                 ext="${agent}/extensions/lets-code/memory-guard.ts" ;;
        mandate*)                   ext="${agent}/extensions/lets-code/mandate.ts" ;;
        subagent*)                  ext="${agent}/extensions/lets-code/subagents.ts" ;;
        expert*)                ext="${agent}/extensions/lets-code/experts.ts" ;;
        claude-code*)               ext="${agent}/extensions/lets-code/claude-code.ts" ;;
        sandbox*)                   ext="${agent}/extensions/lets-code/sandbox/index.ts" ;;
        session-tag*)               ext="${agent}/extensions/lets-code/session-tag.ts" ;;
        metrics*)                   ext="${agent}/extensions/lets-code/footer.ts" ;;
        grounding*)                 ext="${agent}/extensions/lets-code/grounding.ts" ;;
        backend*)                   ext="${agent}/extensions/lets-code/backend.ts" ;;
        thinking*)                  ext="${agent}/extensions/lets-code/thinking.ts" ;;
        *)                          ext="" ;;
    esac
    if [ -n "${ext}" ] && [ ! -f "${ext}" ]; then echo "=== $(basename "${t}"): skipped (no ${ext#${agent}/extensions/} in this build)"; continue; fi
    run "$(basename "${t}")" node "${t}" ${ext:+"${ext}"}
done

echo
echo "${ran} test files, $([ "${fail}" = 0 ] && echo all passed || echo FAILURES)"
exit "${fail}"
