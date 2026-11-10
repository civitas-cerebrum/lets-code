#!/usr/bin/env bash
# Runs every test that needs no model server and no tmux: the shell tests
# (probes, endpoint parsing, helper prefetch, git guard launch side) and the
# node tests for the pi extensions, against the extension sources extracted
# from ./lets-code. Needs bash, python3, git, node >= 22.6.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/.." && pwd)"
skip="mem-guard-live.sh run.sh"           # need a live server / tmux
# tests/run.sh [<file>...]: only the test files named (basenames, e.g.
# git-guard.test.mjs cli.sh; "builtin" for the built-in experts' lint)
only=" $* "
picked() { [ "${only}" = "  " ] || case "${only}" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
fail=0; ran=0

# Windows (Git Bash, as lets-code runs there; node, python and git are
# native programs): TMPDIR in the C:/Users/x form, so the paths the tests
# build on it read the same in bash, node and python (a /tmp/x written into
# python code is no path for a native python); and a python3 on PATH that is
# the real interpreter (setup-python installs python.exe; python3 may be the
# Microsoft Store stub, or missing), with UTF-8 I/O and "\n" line ends on
# stdout and in the files it writes, as lets-code sets up its own: a port a
# test reads from a python server's output must not end in "\r".
win=false; pyw=""
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) win=true ;; esac
if [ "${win}" = true ]; then
    TMPDIR="$(cygpath -m -- "${TEMP:-${TMP:-/tmp}}")"; export TMPDIR
    export PYTHONUTF8=1 PYTHONIOENCODING=utf-8
    py=""
    for c in python3 python "py -3"; do
        # shellcheck disable=SC2086
        py="$(${c} -c 'import sys; print(sys.executable if sys.version_info >= (3, 8) else "")' 2>/dev/null | tr -d '\r')" || py=""
        [ -n "${py}" ] && break
    done
    [ -n "${py}" ] || { echo "no Python 3 found (python3, python or py -3)"; exit 1; }
    pyw="$(mktemp -d "${TMPDIR}/lets-code-py.XXXXXX")"
    mkdir -p "${pyw}/bin" "${pyw}/site"
    cat > "${pyw}/site/sitecustomize.py" <<'PY'
# Written by tests/run.sh: "\n" line ends on stdout and in the text files python writes, as on Linux and macOS.
import builtins, io, sys
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(newline="\n")
    except Exception:
        pass
_lc_open = io.open
def _lc_lf_open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, *a, **k):
    if newline is None and "b" not in mode and any(c in mode for c in "wax+"):
        newline = "\n"
    return _lc_open(file, mode, buffering, encoding, errors, newline, *a, **k)
builtins.open = io.open = _lc_lf_open
PY
    printf '#!/bin/sh\nPYTHONPATH="%s${PYTHONPATH:+;${PYTHONPATH}}" exec "%s" "$@"\n' \
        "$(cygpath -w -- "${pyw}/site")" "$(cygpath -u -- "${py}")" > "${pyw}/bin/python3"
    chmod +x "${pyw}/bin/python3"
    PATH="$(cygpath -u -- "${pyw}/bin"):${PATH}"; export PATH
    echo "(Windows: python3 is ${py}; TMPDIR=${TMPDIR})"
fi

# A test file that runs past TEST_TIMEOUT seconds (default 600) is stopped:
# its process tree is printed first, so a hang names itself (a CI job that
# hung used to run 46 minutes and leave no log), then the file counts as
# failed. Plain bash: macOS has no timeout(1).
TEST_TIMEOUT="${TEST_TIMEOUT:-600}"
# Git Bash's ps knows no -o: there "ps -ef" (uid pid ppid tty stime command),
# its own processes and the native ones they started; a native program's
# own children are not in it, so a tree is stopped with taskkill there too.
procs() {  # procs: "pid ppid [rest]" per process
    if [ "${win}" = true ]; then ps -ef 2>/dev/null | awk 'NR > 1 { pid = $2; ppid = $3; $1 = ""; $2 = ""; $3 = ""; print pid, ppid, $0 }'
    else ps -A -o pid=,ppid=,etime=,command= 2>/dev/null; fi
}
tree() {  # tree <pid>: the pid and its descendants, one "pid ppid elapsed command" line each
    procs | awk -v root="$1" '
        { pid[NR] = $1; ppid[NR] = $2; line[NR] = $0 }
        END { keep[root] = 1; for (pass = 0; pass < 8; pass++) for (i = 1; i <= NR; i++) if (keep[ppid[i]]) keep[pid[i]] = 1
              for (i = 1; i <= NR; i++) if (keep[pid[i]]) print "    " substr(line[i], 1, 200) }'
}
stop_tree() {  # stop_tree <pid>: TERM the descendants, deepest first, then the pid
    local kid
    if [ "${win}" = true ]; then   # the Windows process tree, native children included
        local w; w="$(cat "/proc/$1/winpid" 2>/dev/null)" && [ -n "${w}" ] && taskkill //PID "${w}" //T //F >/dev/null 2>&1
    fi
    for kid in $(procs | awk -v p="$1" '$2 == p { print $1 }'); do stop_tree "${kid}"; done
    kill -TERM "$1" 2>/dev/null
}
run() {  # run <label> <cmd...>
    ran=$((ran + 1))
    local label="$1" pid dog rc
    echo "=== ${label}"
    shift
    "$@" &
    pid=$!
    ( sleep "${TEST_TIMEOUT}"
      if kill -0 "${pid}" 2>/dev/null; then
          echo "--- TIMEOUT: ${label} still running after ${TEST_TIMEOUT}s; its processes:"
          tree "${pid}"
          stop_tree "${pid}"
      fi ) &
    dog=$!
    wait "${pid}"; rc=$?
    stop_tree "${dog}"; wait "${dog}" 2>/dev/null
    if [ "${rc}" -eq 0 ]; then echo "--- ok"; else echo "--- FAIL"; fail=1; fi
}

for t in "${here}"/*.sh; do
    case " ${skip} " in *" $(basename "${t}") "*) continue ;; esac
    picked "$(basename "${t}")" || continue
    run "$(basename "${t}")" bash "${t}"
done

# the extension lets-code writes into ~/.pi/agent/extensions/lets-code (an
# index and one module per feature), produced here into a scratch agent dir
# from the functions in the script
agent="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-ci.XXXXXX")"
trap 'rm -rf "${agent}" ${pyw:+"${pyw}"}' EXIT
mkdir -p "${agent}/extensions"
# (the extension sources contain lines that start with "}", so the functions
# are cut out by their heredoc terminator rather than by a sed range)
# (written to a file with "\n" line ends, read as UTF-8: the same on Windows)
python3 - "${root}/lets-code" "${agent}/writers.sh" <<'PYX'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
out = open(sys.argv[2], "w", encoding="utf-8", newline="\n")
# the windows section first: the switches the writers ask (on_windows,
# native_path, have_python) and, on Windows, its python3
i = s.find("\n# ------------------------------------------------------------------ windows\n")
if i >= 0:
    out.write(s[i:s.find("\n# Stamped by", i)] + "\n")
# the helpers the writers share and the index of the one lets-code extension
# (the block between the "extension dirs" and "themes" section rules)
i = s.find("\n# ------------------------------------------------------------ extension dirs\n")
if i >= 0:
    out.write(s[i:s.find("\n# ------------------------------------------------------------------ themes\n", i)])
for name in ("pi_write_gitguard_extension", "pi_write_memguard_extension", "pi_write_agentguard_extension", "pi_write_mandate_extension", "pi_write_subagent_extension", "pi_write_subagent_view_extension", "pi_write_experts_extension", "pi_write_factory_extension", "pi_write_core_memory_extension", "pi_write_sandbox_extension", "pi_write_sessiontag_extension", "pi_write_sessions_extension", "pi_write_metrics_extension", "pi_write_grounding_extension", "pi_write_backend_extension", "pi_write_claude_extension", "pi_write_claudecode_extension"):
    i = s.find("\n%s() {" % name)
    if i < 0:
        continue
    j = s.find("\nTS\n", i)
    k = s.find("\n}\n", j)
    out.write(s[i:k + 3])
out.close()
PYX
(
    set -e
    PI_AGENT_DIR="${agent}"
    LOG_PREFIX="[lets-code]"; log() { :; }; log_verbose() { :; }; VERBOSE=false
    npm() { return 1; }     # the sandbox writer would install its runtime; not here
    SANDBOX_RUNTIME_VERSION="test"; SB_NOTE=""
    . "${agent}/writers.sh"
    for f in pi_write_lets_code_extension pi_write_gitguard_extension pi_write_memguard_extension pi_write_agentguard_extension pi_write_mandate_extension pi_write_subagent_extension pi_write_experts_extension pi_write_factory_extension pi_write_core_memory_extension pi_write_sandbox_extension pi_write_sessiontag_extension pi_write_sessions_extension pi_write_metrics_extension pi_write_grounding_extension pi_write_backend_extension pi_write_claude_extension pi_write_claudecode_extension; do
        if declare -F "${f}" >/dev/null; then "${f}"; fi
    done
) || { echo "could not extract the extensions from lets-code"; exit 1; }

# the built-in experts, written by lets-code's own writers into a scratch
# agent dir (files only: nothing is installed) and linted as built-ins with
# the expert builder's expert-lint, the same check a new expert gets
python3 - "${root}/lets-code" "${agent}/experts.sh" <<'PYX'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
out = open(sys.argv[2], "w", encoding="utf-8", newline="\n")
i = s.find("\n# ------------------------------------------------------------------ windows\n")
if i >= 0:
    out.write(s[i:s.find("\n# Stamped by", i)] + "\n")
def cut(start, last_fn, end="\n}\n"):
    i = s.find(start)
    j = s.find(end, s.find(last_fn, i))
    if i < 0 or j < 0:
        sys.exit("cannot find %s in lets-code" % last_fn.strip())
    return s[i:j + len(end)]
out.write(cut("\nREA_VERSION=", "\nrea_write_agent() {"))
out.write(cut("\npi_write_tester() {", "\npi_write_tester() {", "\n}  # end of pi_write_tester\n"))
out.write(cut("\npi_write_api_tester() {", "\npi_write_api_tester() {", "\n}  # end of pi_write_api_tester\n"))
out.write(cut("\nUI_TESTER_PINS=", "\nui_tester_write_agent() {"))
out.write(cut("\nJUDGE_DIR=", "\njudge_write_agent() {"))
i = s.find("\n# Termux device expert:"); j = s.find("\non_termux() {", i)   # its writer, knowledge and on_termux
out.write(s[i:s.find("\n", j + 1) + 1])
out.write(cut("\npi_write_expert_builder() {", "\npi_write_expert_builder() {", "\n}  # end of pi_write_expert_builder\n"))
out.write(cut("\npi_write_developer() {", "\npi_write_developer() {", "\n}  # end of pi_write_developer\n"))
out.write(cut("\npi_write_expert_reviewer() {", "\npi_write_expert_reviewer() {", "\n}  # end of pi_write_expert_reviewer\n"))
out.write(cut("\npi_write_software_factory() {", "\npi_write_software_factory() {", "\n}  # end of pi_write_software_factory\n"))
out.write(cut("\npi_write_design_reviewer() {", "\npi_write_design_reviewer() {", "\n}  # end of pi_write_design_reviewer\n"))
out.write(cut("\nRESEARCHER_PINS=", "\npi_write_researcher() {", "\n}  # end of pi_write_researcher\n"))
out.write(cut("\npi_write_video_scan() {", "\npi_write_video_scan() {", "\n}  # end of pi_write_video_scan\n"))
out.close()
PYX
(
    set -e
    PI_AGENT_DIR="${agent}/builtin"; mkdir -p "${PI_AGENT_DIR}"
    LOG_PREFIX="[lets-code]"; log() { :; }
    . "${agent}/experts.sh"
    pi_write_rea files; pi_write_tester; pi_write_api_tester; pi_write_ui_tester files; pi_write_judge; write_termux_agent; pi_write_expert_builder; pi_write_developer; pi_write_expert_reviewer; pi_write_design_reviewer; pi_write_software_factory; pi_write_researcher; pi_write_video_scan
) || { echo "could not write the built-in experts from lets-code"; exit 1; }
picked builtin && run "built-in experts: expert-lint --builtin" node "${agent}/builtin/expert-builder/bin/expert-lint" --builtin "${agent}/builtin/agents"

for t in "${here}"/*.test.mjs; do
    [ -e "${t}" ] || continue
    picked "$(basename "${t}")" || continue
    case "$(basename "${t}")" in
        lets-code*)                 ext="${agent}/extensions/lets-code/index.ts" ;;
        git-guard*|git-checkpoint*) ext="${agent}/extensions/lets-code/git-guard.ts" ;;
        agent-guard*)               ext="${agent}/extensions/lets-code/agent-guard.ts" ;;
        mem-guard*)                 ext="${agent}/extensions/lets-code/memory-guard.ts" ;;
        mandate*)                   ext="${agent}/extensions/lets-code/mandate.ts" ;;
        subagent*)                  ext="${agent}/extensions/lets-code/subagents.ts" ;;
        expert*)                ext="${agent}/extensions/lets-code/experts.ts" ;;
        factory*)                   ext="${agent}/extensions/lets-code/factory.ts" ;;
        core-memory*)               ext="${agent}/extensions/lets-code/core-memory.ts" ;;
        claude-code*)               ext="${agent}/extensions/lets-code/claude-code.ts" ;;
        claude.test.mjs)            ext="${agent}/extensions/lets-code/claude/index.ts" ;;
        sandbox*)                   ext="${agent}/extensions/lets-code/sandbox/index.ts" ;;
        session-tag*)               ext="${agent}/extensions/lets-code/session-tag.ts" ;;
        sessions*)                  ext="${agent}/extensions/lets-code/sessions.ts" ;;
        metrics*)                   ext="${agent}/extensions/lets-code/footer.ts" ;;
        grounding*)                 ext="${agent}/extensions/lets-code/grounding.ts" ;;
        backend*)                   ext="${agent}/extensions/lets-code/backend.ts" ;;
        platform*)                  ext="${root}/lets-code" ;;   # cuts lc_ts_platform out itself
        *)                          ext="" ;;
    esac
    if [ -n "${ext}" ] && [ ! -f "${ext}" ]; then echo "=== $(basename "${t}"): skipped (no ${ext#${agent}/extensions/} in this build)"; continue; fi
    run "$(basename "${t}")" node "${t}" ${ext:+"${ext}"}
done

echo
echo "${ran} test files, $([ "${fail}" = 0 ] && echo all passed || echo FAILURES)"
exit "${fail}"
