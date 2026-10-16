#!/usr/bin/env bash
# Unit test for pi_write_judge: extracts the functions from ./lets-code and
# runs them against a scratch agent dir; then scratch-copy against a small
# git repo (working tree, a revision, a plain dir) without touching it.
set -eu
src="$(dirname "$0")/../lets-code"
PI_AGENT_DIR=/nonexistent     # JUDGE_DIR is derived from it; set for real below
eval "$(python3 - "${src}" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\nJUDGE_DIR=")
j = s.find("\n}\n", s.find("\njudge_write_agent() {"))
sys.stdout.write(s[i:j + 3])
PY
)"

work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/judge-test.XXXXXX")" && pwd -P)"   # macOS: TMPDIR ends in /, /var is /private/var
trap 'rm -rf "${work}"' EXIT
PI_AGENT_DIR="${work}/agent"; JUDGE_DIR="${PI_AGENT_DIR}/acceptance-judge"
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }

pi_write_judge
J="${JUDGE_DIR}"
t "prompt written"                 "$([ -s "${J}/prompt.md" ] && echo yes)" yes
t "helper executable"              "$([ -x "${J}/bin/scratch-copy" ] && echo yes)" yes
t "helper: lets-code's"            "$(sed -n 2p "${J}/bin/scratch-copy" | grep -c 'Written by lets-code')" 1
t "paths filled in"                "$(cat "${J}/prompt.md" "${J}"/ref/*.md | grep -c '@@J@@')" 0
t "prompt names the helper"        "$(grep -c "${J}/bin/scratch-copy" "${J}/prompt.md")" 1
t "prompt: no harness tools"       "$(grep -c -E '\b(Skill|Agent|Task) ?\{|hook|ledger' "${J}/prompt.md")" 0
for r in $(grep -o "${J}/ref/[a-z-]*\.md" "${J}/prompt.md" | sort -u); do
    t "ref $(basename "${r}") written" "$([ -s "${r}" ] && echo yes)" yes
done
t "refs: none unreferenced"        "$(for r in "${J}"/ref/*.md; do grep -q "${r}" "${J}/prompt.md" || echo "${r}"; done)" ""
t "prompt: the three verdicts"     "$(grep -c -E '^   - (PASS|FAIL|UNVERIFIABLE): ' "${J}/prompt.md")" 3
t "prompt: ACCEPT only on all PASS" "$(grep -c 'ACCEPT only when every criterion is PASS' "${J}/prompt.md")" 1
t "prompt: negative control"       "$(grep -c 'would this check pass if the change did nothing' "${J}/prompt.md")" 1
t "prompt: no PASS without a run"  "$(grep -c 'No PASS without executed evidence' "${J}/prompt.md")" 1
t "prompt: report headings"        "$(grep '^## ' "${J}/prompt.md" | tail -n 4 | tr '\n' '|')" "## Verdict|## Criteria|## Missing|## Relied on|"
t "prompt: about 700 words"        "$([ "$(wc -w < "${J}/prompt.md")" -le 800 ] && echo yes)" yes

# the expert
af="${PI_AGENT_DIR}/agents/acceptance-judge.md"
t "agent file written"             "$(grep -c '^# Written by lets-code' "${af}")" 1
t "agent: in place"                "${JUDGE_AGENT}" 1
t "agent: prompt exists"           "$([ -f "${PI_AGENT_DIR}/$(sed -n 's/^append_prompt: //p' "${af}")" ] && echo yes)" yes
t "agent: read and run, no edit"   "$(sed -n 's/^tools: //p' "${af}")" "read, bash, grep, find, ls"
t "agent: the verify role"         "$(sed -n 's/^role: //p' "${af}")" verify
t "agent: an expert"               "$(sed -n 's/^expert: //p' "${af}")" true
t "agent: everywhere (no platform)" "$(grep -c '^platform:' "${af}")" 0
t "agent: nothing to set up"       "$(grep -c -E '^(setup|setup_note|requires|agent_dir):' "${af}")" 0
t "agent: timeout 1800"            "$(grep '^timeout:' "${af}")" "timeout: 1800"
t "agent: use_for fits the line"   "$([ "$(sed -n 's/^use_for: //p' "${af}" | wc -c)" -le 101 ] && echo yes)" yes
t "agent: keywords fit"            "$([ "$(sed -n 's/^keywords: //p' "${af}" | wc -c)" -le 41 ] && echo yes)" yes
t "agent: brief template"          "$(sed -n 's/^  - \([a-z_]*\).*/\1/p' "${af}" | tr '\n' ' ')" "criteria artifact claim how_to_run constraints "
t "agent: required fields"         "$(grep -c '^  - [a-z_]* (required):' "${af}" | tr -d ' ')" 2
before="$(cat "${af}")"; pi_write_judge
t "rewrite is stable"              "$(cat "${af}")" "${before}"
rm -rf "${PI_AGENT_DIR}/agents"; mkdir -p "${PI_AGENT_DIR}/agents"
printf -- '---\nname: acceptance-judge\ndescription: mine\n---\nmine\n' > "${af}"
pi_write_judge
t "user's own file kept"           "$(grep -c 'description: mine' "${af}")" 1
t "user's file: not ours"          "${JUDGE_AGENT:-none}" none
rm -f "${af}"; pi_write_judge
t "agent rewritten after removal"  "$(grep -c '^# Written by lets-code' "${af}")" 1
t "no temp files left"             "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "acceptance-judge.md "

# scratch-copy: a repo with a commit, an uncommitted edit, an untracked file,
# an ignored file, a deleted tracked file and node_modules
export TMPDIR="${work}/tmp"; mkdir -p "${TMPDIR}"
sc="${J}/bin/scratch-copy"
r="${work}/repo"; mkdir -p "${r}/src" "${r}/node_modules/dep"
g() { git -C "${r}" -c user.name=t -c user.email=t@t "$@" >/dev/null; }
g init -q; printf 'node_modules/\n*.log\n' > "${r}/.gitignore"
echo v1 > "${r}/src/a.txt"; echo gone > "${r}/src/b.txt"; g add -A; g commit -qm one
first="$(git -C "${r}" rev-parse HEAD)"
echo v2 > "${r}/src/a.txt"; g commit -qam two
echo v3 > "${r}/src/a.txt"; echo new > "${r}/src/c.txt"; echo noise > "${r}/x.log"; rm "${r}/src/b.txt"
status_before="$(git -C "${r}" status --porcelain)"
c="$(bash "${sc}" "${r}")"
t "copy: under the temp dir"       "$([ "${c#"${TMPDIR}/lets-code-judge/"}" != "${c}" ] && echo yes)" yes
t "copy: the working tree"         "$(cat "${c}/src/a.txt"):$(cat "${c}/src/c.txt")" "v3:new"
t "copy: no ignored, no deleted"   "$([ -e "${c}/x.log" ] || [ -e "${c}/src/b.txt" ] && echo yes || echo no)" no
t "copy: dependencies linked"      "$([ -L "${c}/node_modules" ] && [ -d "${c}/node_modules/dep" ] && echo yes)" yes
t "copy: its own git repo, clean"  "$(git -C "${c}" rev-parse --show-toplevel):$(git -C "${c}" status --porcelain)" "${c}:"
c1="$(bash "${sc}" "${r}" "${first}")"
t "copy of a revision"             "$(cat "${c1}/src/a.txt"):$(cat "${c1}/src/b.txt")" "v1:gone"
cs="$(bash "${sc}" "${r}/src")"
t "copy of a subdir: same subdir"  "$(basename "${cs}"):$(cat "${cs}/a.txt")" "src:v3"
echo broken > "${c}/src/a.txt"
t "the original untouched"         "$(git -C "${r}" status --porcelain):$(cat "${r}/src/a.txt")" "${status_before}:v3"
t "the original's git: no worktree" "$(git -C "${r}" worktree list | wc -l | tr -d ' ')" 1
p="${work}/plain"; mkdir -p "${p}"; echo x > "${p}/f"
cp_="$(bash "${sc}" "${p}")"
t "plain dir copied"               "$(cat "${cp_}/f")" x
rc=0; bash "${sc}" "${p}" HEAD >/dev/null 2>&1 || rc=$?
t "plain dir has no revision"      "${rc}" 2
rc=0; bash "${sc}" "${work}/nope" >/dev/null 2>&1 || rc=$?
t "missing dir: usage"             "${rc}" 2
bash "${sc}" --clean >/dev/null
t "--clean removes the copies"     "$([ -e "${TMPDIR}/lets-code-judge" ] && echo yes || echo no)" no
exit ${fail}
