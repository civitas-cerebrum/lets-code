#!/usr/bin/env bash
# Unit test for pi_write_expert_builder and its helpers: extracts the writer
# from ./lets-code, writes the expert-builder into a scratch agent dir, then
# checks expert-lint on good and bad fixtures, expert-new init and pack (a
# packed expert written back by its own writer and linted as a built-in),
# and route-check against a fake launcher (verdicts, scores, scrubbed env,
# the scratch dir). Needs bash, python3, node.
set -eu
src="$(dirname "$0")/../lets-code"
eval "$(python3 - "${src}" <<'PY'
import sys
s = open(sys.argv[1]).read()
end = "\n}  # end of pi_write_expert_builder\n"
i = s.find("\npi_write_expert_builder() {")
j = s.find(end, i)
sys.stdout.write(s[i:j + len(end)])
PY
)"
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eb-test.XXXXXX")" && pwd)"   # macOS TMPDIR ends in /
trap 'rm -rf "${work}"' EXIT
PI_AGENT_DIR="${work}/agent"; mkdir -p "${PI_AGENT_DIR}"
D="${PI_AGENT_DIR}/expert-builder"; af="${PI_AGENT_DIR}/agents/expert-builder.md"
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
has() { case "$2" in *"$3"*) echo "ok    $1" ;; *) echo "FAIL  $1 -> no \"$3\" in: $(printf '%s' "$2" | head -c 600)"; fail=1 ;; esac; }
hasnt() { case "$2" in *"$3"*) echo "FAIL  $1 -> \"$3\" in: $(printf '%s' "$2" | head -c 600)"; fail=1 ;; *) echo "ok    $1" ;; esac; }

# ------------------------------------------------------------ the writer
pi_write_expert_builder
t "agent file written"             "$(grep -c '^# Written by lets-code' "${af}")" 1
t "agent: in place"                "${EB_AGENT}" 1
t "agent: an expert"               "$(sed -n 's/^expert: //p' "${af}")" true
t "agent: no setup, no platform"   "$(grep -cE '^(setup|platform|requires):' "${af}" || true)" 0
t "agent: pi's tools"              "$(sed -n 's/^tools: //p' "${af}")" "bash, read, edit, write, grep, find, ls"
t "agent: brief template"          "$(sed -n 's/^  - \([a-z_]*\).*/\1/p' "${af}" | tr '\n' ' ')" "domain sources scope name platform constraints "
t "agent: one required field"      "$(grep -c '^  - [a-z_]* (required):' "${af}")" 1
t "helpers executable"             "$([ -x "${D}/bin/expert-lint" ] && [ -x "${D}/bin/expert-new" ] && [ -x "${D}/bin/route-check" ] && echo yes)" yes
t "helpers: lets-code's"           "$(head -n 2 "${D}"/bin/* | grep -c 'Written by lets-code (expert-builder)')" 3
t "paths filled in"                "$(cat "${D}/prompt.md" "${D}"/ref/*.md | grep -cE '@@EB@@|@@AGENT@@' || true)" 0
t "prompt: the helpers' paths"     "$(grep -cE "${D}/bin/(expert-lint|expert-new|route-check) " "${D}/prompt.md")" 3
for r in $(grep -o "${D}/ref/[a-z-]*\.md" "${D}/prompt.md" | sort -u); do
    t "ref $(basename "${r}") written" "$([ -s "${r}" ] && echo yes)" yes
done
t "refs: none unreferenced"        "$(for r in "${D}"/ref/*.md; do grep -q "${r}" "${D}/prompt.md" || echo "${r}"; done)" ""
t "prompt: no harness tools"       "$(grep -c -E '\b(Skill|Task|TodoWrite|WebFetch) ?[({]' "${D}/prompt.md" || true)" 0
t "the builder lints clean"        "$(node "${D}/bin/expert-lint" --builtin "${af}" | tail -n 1)" "expert-lint: expert-builder: 0 errors, 0 warnings"
before="$(cat "${af}")"; pi_write_expert_builder
t "rewrite is stable"              "$(cat "${af}")" "${before}"
printf -- '---\nname: expert-builder\ndescription: mine\n---\nmine\n' > "${af}"
pi_write_expert_builder
t "user's own file kept"           "$(grep -c 'description: mine' "${af}")" 1
t "user's file: not ours"          "${EB_AGENT:-none}" none
rm -f "${af}"; pi_write_expert_builder
t "no temp files left"             "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "expert-builder.md "
mkdir -p "${D}/work"; echo keep > "${D}/work/x.prompts"; pi_write_expert_builder
t "work dir kept"                  "$(cat "${D}/work/x.prompts")" keep

LINT="${D}/bin/expert-lint"; NEW="${D}/bin/expert-new"; RC="${D}/bin/route-check"
lint() { node "${LINT}" "$@" 2>&1 || true; }
lintrc() { node "${LINT}" "$@" >/dev/null 2>&1 && echo 0 || echo $?; }

# ------------------------------------------------------------ expert-lint
L="${work}/lint"; mkdir -p "${L}/agents" "${L}/conf/ref" "${L}/conf/bin"
good() { cat <<'MD'
---
name: conf
description: Converts and validates config files
tools: bash, read, write
timeout: 900
expert: true
use_for: converting and validating JSON, YAML and TOML config files
keywords: config files, YAML
job: Converts a config file between JSON, YAML and TOML and validates it; a few minutes
brief:
  - file (required): the config file's path
  - to: the format to convert to
---
You convert config files. Read @L@/conf/ref/formats.md before converting.
Run @L@/conf/bin/check <file>.
MD
}
good | sed "s|@L@|${L}|g" > "${L}/agents/conf.md"
echo "# formats" > "${L}/conf/ref/formats.md"
printf '#!/usr/bin/env bash\necho ok\n' > "${L}/conf/bin/check"; chmod 755 "${L}/conf/bin/check"
out="$(lint --user "${L}/agents/conf.md")"
t "lint: a good expert passes"     "$(lintrc --user "${L}/agents/conf.md")" 0
t "lint: no errors, no warnings"   "$(echo "${out}" | tail -n 1)" "expert-lint: conf: 0 errors, 0 warnings"
has "lint: the entry's cost"       "${out}" 'cost: its entry "conf (converting and validating JSON, YAML and TOML config files)" is'
t "lint: a dir lints its experts"  "$(lint --user "${L}/agents" | grep -c '^expert-lint: ')" 1
t "lint: usage"                    "$(lintrc)" 2
t "lint: --list"                   "$(lint --list --agent-dir "${L}")" "expert conf: converting and validating JSON, YAML and TOML config files | keywords: config files, YAML"
# each bad fixture: one change to the good file, and the finding it must give
bad() {  # bad <label> <perl-expr> <severity: rule: text> [lint options]
    local label="$1" expr="$2" want="$3"; shift 3
    good | sed "s|@L@|${L}|g" | perl -pe "${expr}" > "${L}/agents/conf.md"
    has "lint: ${label}" "$(lint "$@" "${L}/agents/conf.md")" "${want}"
}
bad "no frontmatter"           '$_="" if $.==1'                                              "error: frontmatter:"
bad "not an expert"            '$_="" if /^expert:/'                                     "error: expert:"
bad "bad name"                 's/^name: conf/name: -conf/'                     "error: name:"
bad "no description"           '$_="" if /^description:/'                                "error: description:"
bad "no use_for"               '$_="" if /^use_for:/'                                    "error: use_for: missing"
bad "use_for too long"         's/^use_for: .*/use_for: converting and validating JSON, YAML and TOML config files, and also INI, HCL, XML, properties and dotenv files/' "error: use_for: 111 characters"
bad "use_for: what it is"      's/^use_for: .*/use_for: an expert for config files/' "warning: use_for: starts with what it is"
bad "keywords too long"        's/^keywords: .*/keywords: config files, YAML, TOML, JSON, INI, HCL, XML/' "error: keywords:"
bad "brief: bad item"          's/^  - to: the format/  - to the format/'        "error: brief:"
bad "brief: a field twice"     's/^  - to: .*/  - file: again/'                  "error: brief: field file twice"
bad "brief: inline"            's/^brief:$/brief: file/'                         "error: brief: brief takes a block list"
bad "brief: none required"     's/^  - file \(required\):/  - file:/'              "warning: brief: no required field"
bad "unknown tool"             's/^tools: .*/tools: bash, Read, websearch/'      "error: tools: Read is not a pi tool"
bad "no tools"                 '$_="" if /^tools:/'                                      "warning: tools: none"
bad "bad thinking"             's/^timeout: 900/thinking: max/'                  "error: thinking: max"
bad "bad timeout"              's/^timeout: 900/timeout: 90s/'                   "error: timeout:"
bad "bad platform"             's/^timeout: 900/platform: linux, macos/'         "error: platform: macos"
bad "path outside"             's|^timeout: 900|append_prompt: ../../etc/passwd|' "error: append_prompt: ../../etc/passwd is outside"
bad "missing path, no setup"   's|^timeout: 900|requires: conf/runtime/.installed|' "error: requires: conf/runtime/.installed does not exist and there is no setup"
bad "unknown field"            's/^use_for:/usefor:/'                            "warning: field: unknown field usefor (ignored by lets-code; a typo of use_for)"
bad "names a missing ref"      's|ref/formats.md|ref/nothere.md|'                "error: refs: the instructions name conf/ref/nothere.md, which does not exist"
bad "an unreferenced ref"      's|Read .*formats.md before converting.|Convert.|' "warning: refs: conf/ref/formats.md is never named"
bad "harness tool names"       's|^You convert config files.|Use the Skill tool to convert.|' "warning: body: names a tool pi does not have"
bad "the lets-code line, user" 's|^name: conf|# Written by lets-code (conf); regenerated on launch, edits are overwritten.\nname: conf|' "error: marker:" --user
bad "builtin without the line" 's/^x//'                                          "error: marker: a built-in must carry" --builtin
bad "a TODO left"              's/^job: .*/job: TODO(expert-new)/'               "error: todo: agents/conf.md still has"
good | sed "s|@L@|${L}|g" > "${L}/agents/conf.md"
printf -- '---\nname: conf\ndescription: x\nexpert: true\nuse_for: other\n---\nx\n' > "${L}/agents/conf2.md"
has "lint: the same name twice"    "$(lint "${L}/agents/conf.md")" "error: name: conf2.md has the same name conf"
printf -- '---\nname: cfg\ndescription: x\nexpert: true\nuse_for: validating YAML and TOML config files\n---\nx\n' > "${L}/agents/conf2.md"
has "lint: overlap with an expert" "$(lint "${L}/agents/conf.md")" "warning: overlap: expert cfg shares"
rm -f "${L}/agents/conf2.md"
printf '#!/usr/bin/env bash\nif then\n' > "${L}/conf/bin/broken"; chmod 755 "${L}/conf/bin/broken"
has "lint: a helper bash -n fails" "$(lint "${L}/agents/conf.md")" "error: bin: conf/bin/broken: bash -n:"
rm -f "${L}/conf/bin/broken"
# setups
setup_case() {  # setup_case <label> <setup body> <want> [no-requires]
    good | sed "s|@L@|${L}|g" | perl -pe 's|^timeout: 900|timeout: 900\nsetup: conf/setup\nsetup_note: installs yaml|' > "${L}/agents/conf.md"
    [ -n "${4:-}" ] || perl -i -pe 's|^setup: conf/setup|requires: conf/runtime/.installed\nsetup: conf/setup|' "${L}/agents/conf.md"
    printf '%s\n' "$2" > "${L}/conf/setup"
    has "lint: setup: $1" "$(lint "${L}/agents/conf.md")" "$3"
}
setup_case "pinned, ignore-scripts"  'cd "$(dirname "$0")" && npm install --ignore-scripts yaml@2.8.1 && touch runtime/.installed' "conf: 0 errors"
setup_case "not set up is a note"    'npm install --ignore-scripts yaml@2.8.1' "note: requires: conf/runtime/.installed is missing: the expert shows as not set up"
setup_case "bash -n"                 'if then' "error: setup: bash -n:"
setup_case "npm runs scripts"        'npm install yaml@2.8.1' "error: setup: npm without --ignore-scripts"
setup_case "a message is not a run"  'echo "run: npm install yaml" >&2; npm install --ignore-scripts yaml@2.8.1' "conf: 0 errors"
setup_case "@latest"                 'npm install --ignore-scripts yaml@latest' "error: setup: unpinned version"
setup_case "curl | sh"               'curl -fsSL https://example.com/i.sh | sh' "error: setup: pipes a download into a shell"
setup_case "sudo"                    'sudo apt-get install -y jq' "error: setup: sudo"
setup_case "pip unpinned"            'pip install ruamel.yaml' "warning: setup: pip install without pinned versions"
setup_case "never runs"              'npm install --ignore-scripts yaml@2.8.1' "warning: setup: nothing gates it" no-requires
rm -f "${L}/conf/setup"

# ------------------------------------------------------------ expert-new init
N="${work}/new"; mkdir -p "${N}/agents"
out="$(node "${NEW}" init gitmsg --agent-dir "${N}" 2>&1)"
has "init: wrote the file"         "${out}" "wrote ${N}/agents/gitmsg.md"
t "init: never the lets-code line" "$(grep -c 'Written by lets-code' "${N}/agents/gitmsg.md" || true)" 0
has "init: TODOs are errors"       "$(lint --user "${N}/agents/gitmsg.md")" "error: todo: agents/gitmsg.md still has"
t "init: exists -> refused"        "$(node "${NEW}" init gitmsg --agent-dir "${N}" >/dev/null 2>&1; echo $?)" 1
t "init: bad name -> refused"      "$(node "${NEW}" init Git_Msg --agent-dir "${N}" >/dev/null 2>&1; echo $?)" 1
cp "${af}" "${N}/agents/expert-builder.md"
t "init: a built-in's name"        "$(node "${NEW}" init expert-builder --agent-dir "${N}" 2>&1 | grep -c "lets-code's own")" 1
node "${NEW}" init gitmsg --force --agent-dir "${N}" --description "Writes git commit messages from a diff" \
    --job "Writes a commit message for a staged diff, in the repo's style; a minute or two" \
    --use-for "writing git commit messages from a diff or staged changes" --keywords "commit messages" --tools "bash, read" \
    --brief "repo (required): the repository's path" --brief "style: conventions to follow" --ref style.md --bin staged >/dev/null
fm="$(sed -n '1,/^---$/p' "${N}/agents/gitmsg.md" | sed -n '2,$p')"
has "init: use_for given"          "${fm}" "use_for: writing git commit messages from a diff or staged changes"
has "init: the brief, in order"    "${fm}" "brief:
  - repo (required): the repository's path
  - style: conventions to follow"
t "init: helper executable"        "$([ -x "${N}/gitmsg/bin/staged" ] && echo yes)" yes
t "init: ref stub"                 "$([ -s "${N}/gitmsg/ref/style.md" ] && echo yes)" yes
has "init: body names the ref"     "$(cat "${N}/agents/gitmsg.md")" "${N}/gitmsg/ref/style.md"
# fill in the TODOs the way the builder would
python3 - "${N}" <<'PY'
import os, re, sys
n = sys.argv[1]
for p in [f"{n}/agents/gitmsg.md", f"{n}/gitmsg/ref/style.md", f"{n}/gitmsg/bin/staged"]:
    s = open(p).read()
    s = re.sub(r"TODO\(expert-new\)( \([^)]*\))?:?", "done", s)
    open(p, "w").write(s)
PY
t "init: filled in, lint passes"   "$(lintrc --user "${N}/agents/gitmsg.md")" 0
t "init: --setup gates it"         "$(node "${NEW}" init withsetup --agent-dir "${N}" --setup >/dev/null; grep -c '^requires: withsetup/runtime/.installed' "${N}/agents/withsetup.md"):$(bash -n "${N}/withsetup/setup" && echo syntax-ok)" "1:syntax-ok"
has "init: --setup is pinned"      "$(cat "${N}/withsetup/setup")" "npm install --ignore-scripts"
rm -rf "${N}/agents/withsetup.md" "${N}/withsetup" "${N}/agents/expert-builder.md"

# ------------------------------------------------------------ expert-new pack
node "${NEW}" pack gitmsg --agent-dir "${N}" > "${work}/packed.sh"
t "pack: bash -n"                  "$(bash -n "${work}/packed.sh" && echo ok)" ok
t "pack: the paths as @@D@@"       "$(grep -c "${N}" "${work}/packed.sh" || true):$(grep -c '@@D@@/ref/style.md' "${work}/packed.sh")" "0:1"
t "pack: the end sentinel"         "$(grep -c '^}  # end of pi_write_gitmsg$' "${work}/packed.sh")" 1
P="${work}/packed-agent"; mkdir -p "${P}"
( PI_AGENT_DIR="${P}"; . "${work}/packed.sh"; pi_write_gitmsg )
t "pack: the writer writes it"     "$(grep -c '^# Written by lets-code (gitmsg)' "${P}/agents/gitmsg.md")" 1
t "pack: its paths filled in"      "$(grep -c "${P}/gitmsg/ref/style.md" "${P}/agents/gitmsg.md")" 1
t "pack: helper kept executable"   "$([ -x "${P}/gitmsg/bin/staged" ] && echo yes)" yes
t "pack: same files"               "$(cd "${N}/gitmsg" && find . -type f | sort | tr '\n' ' ')" "$(cd "${P}/gitmsg" && find . -type f | sort | tr '\n' ' ')"
t "pack: lints as a built-in"      "$(lintrc --builtin "${P}/agents/gitmsg.md")" 0
printf -- '---\nname: gitmsg\ndescription: mine\n---\nmine\n' > "${P}/agents/gitmsg.md"
( PI_AGENT_DIR="${P}"; . "${work}/packed.sh"; pi_write_gitmsg )
t "pack: a user's file kept"       "$(grep -c 'description: mine' "${P}/agents/gitmsg.md")" 1
t "pack: --test is a test"         "$(node "${NEW}" pack gitmsg --agent-dir "${N}" --test | bash -n && echo ok)" ok

# ------------------------------------------------------------ route-check
F="${work}/fake"; mkdir -p "${F}"
cat > "${F}/launcher" <<'SH'
#!/usr/bin/env bash
# a fake lets-code: records its env, then plays the events the prompt names
for a; do p="$a"; done
echo "depth=${LETS_CODE_SUBAGENT_DEPTH:-}|experts=${LETS_CODE_EXPERTS_ON:-}|endpoints=${LETS_CODE_ENDPOINTS:-}|dir=${PI_CODING_AGENT_DIR}|cwd=$(pwd -P)|args=$*" >> "${FAKE_LOG}"
ev() { printf '%s\n' "$1"; }
use() { ev '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":100,"output":10}}}'; }
call() { ev "{\"type\":\"tool_execution_start\",\"toolName\":\"$1\",\"args\":$2}"; }
case "${p}" in
    *convert*) use; call ls '{}'; call expert '{"action":"list"}'; use; call expert '{"action":"run","name":"conf","brief":{"file":"a.yaml"}}'; sleep 5 ;;
    *parallel*) use; call expert '{"action":"run","runs":[{"name":"conf","brief":{}}]}' ;;
    *browser*) use; call expert '{"action":"enable","name":"tester"}' ;;
    *explain*) use; ev '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"YAML is..."}],"usage":{"input":50,"output":40}}}' ;;
    *edit*) use; call read '{"path":"a.json"}'; call edit '{"path":"a.json"}'; sleep 5 ;;
    *loop*) use; for i in 1 2 3 4 5 6 7 8 9 10; do call bash '{"command":"ls"}'; done; sleep 5 ;;
    *scout*) use; call subagent '{"agent":"scout","task":"look"}' ;;
    *hang*) sleep 30 ;;
    *) echo "unexpected" >&2; exit 3 ;;
esac
SH
chmod 755 "${F}/launcher"
S="${work}/scratch-src"; mkdir -p "${S}/agents" "${S}/sessions" "${S}/conf/runtime" "${S}/extensions/lets-code/node_modules/x"
cp "${L}/agents/conf.md" "${S}/agents/"; echo '{}' > "${S}/models.json"; echo '{"experts":{"conf":true}}' > "${S}/lets-code-state.json"
touch "${S}/sessions/s.jsonl" "${S}/conf/runtime/big" "${S}/extensions/lets-code/node_modules/x/i.js"
cat > "${work}/p.txt" <<'TXT'
# conf's prompts
+ convert a.yaml to TOML
+ parallel conversion
+ hang forever
- explain YAML
- edit a.json
- loop a while
- scout the repo
=tester check the signup form in a browser
TXT
export FAKE_LOG="${F}/log"; : > "${FAKE_LOG}"
out="$(LETS_CODE_SUBAGENT_DEPTH=1 LETS_CODE_EXPERTS_ON=1 LETS_CODE_ENDPOINTS=http://x node "${RC}" "${work}/p.txt" "${work}/scratch" --expert conf --from "${S}" --launcher "${F}/launcher" --timeout 3 --max-own 8 --json "${work}/r.json" 2>&1)"
has "route: routed, after a list"  "${out}" "ok   + expert:conf | "
has "route: runs:[..] counts"      "${out}" "ok   + expert:conf | "
has "route: a timeout is a miss"   "${out}" "MISS + timeout (timed out)"
has "route: an answer is own"      "${out}" "ok   - own (answered without tools)"
has "route: an edit is own"        "${out}" "ok   - own (its own edit)"
has "route: max own calls"         "${out}" "ok   - own (8 tool calls of its own)"
has "route: a subagent"            "${out}" "ok   - subagent:scout"
has "route: another expert kept"   "${out}" "ok   =tester expert:tester"
has "route: the summary"           "${out}" "route-check: conf: recall 2/3, false triggers 0/5, precision 100%, other experts kept 1/1, timeouts 1;"
t "route: the JSON summary"        "$(python3 -c 'import json,sys; s=json.load(open(sys.argv[1]))["summary"]; print(s["recall"], s["falseTriggers"], s["precision"], s["input"] > 0)' "${work}/r.json")" "[2, 3] [0, 5] 1 True"
t "route: one session a prompt"    "$(wc -l < "${FAKE_LOG}" | tr -d ' ')" 8
t "route: depth scrubbed"          "$(grep -c '^depth=|experts=|' "${FAKE_LOG}")" 8
t "route: user's config env kept"  "$(grep -c 'endpoints=http://x' "${FAKE_LOG}")" 8
t "route: the scratch agent dir"   "$(grep -c "dir=${work}/scratch|cwd=$(cd "${work}" && pwd -P)/scratch/project|" "${FAKE_LOG}")" 8
has "route: print mode, low"       "$(head -n 1 "${FAKE_LOG}")" "args=--thinking-level low --mode json --no-session -p convert a.yaml to TOML"
t "route: scratch, all dormant"    "$([ -e "${work}/scratch/lets-code-state.json" ] && echo state || echo none)" none
t "route: no sessions, no installs" "$([ -e "${work}/scratch/sessions" ] || [ -e "${work}/scratch/conf/runtime" ] && echo copied || echo left-out)" left-out
t "route: extensions copied whole" "$([ -e "${work}/scratch/extensions/lets-code/node_modules/x/i.js" ] && echo yes)" yes
t "route: given scratch kept"      "$([ -d "${work}/scratch/agents" ] && echo yes)" yes
t "route: the source untouched"    "$(cat "${S}/lets-code-state.json")" '{"experts":{"conf":true}}'
: > "${FAKE_LOG}"
printf '+ convert a.yaml\n' > "${work}/p1.txt"
out="$(node "${RC}" "${work}/p1.txt" --expert conf --from "${S}" --launcher "${F}/launcher" 2>&1)"
has "route: a temp scratch"        "${out}" "scratch ${S}/expert-builder/work/route."
t "route: temp scratch removed"    "$(ls "${S}/expert-builder/work" | wc -l | tr -d ' ')" 0
t "route: refuses the real dir"    "$(node "${RC}" "${work}/p1.txt" "${S}" --expert conf --from "${S}" --launcher "${F}/launcher" >/dev/null 2>&1; echo $?)" 2
t "route: refuses xhigh"           "$(node "${RC}" "${work}/p1.txt" "${work}/s2" --expert conf --thinking xhigh >/dev/null 2>&1; echo $?)" 2
t "route: bad prompts file"        "$(printf 'convert it\n' > "${work}/bad.txt"; node "${RC}" "${work}/bad.txt" "${work}/s2" --expert conf >/dev/null 2>&1; echo $?)" 2
t "route: no such expert"          "$(node "${RC}" "${work}/p1.txt" "${work}/s3" --expert nope --from "${S}" --launcher "${F}/launcher" >/dev/null 2>&1; echo $?)" 1
t "route: --dry-run runs nothing"  "$(node "${RC}" "${work}/p1.txt" "${work}/s4" --expert conf --launcher "${F}/launcher" --dry-run | grep -c -- '--mode json --no-session -p "convert a.yaml"'):$(wc -l < "${FAKE_LOG}" | tr -d ' ')" "1:1"
D2="${work}/draft"; mkdir -p "${D2}/agents" "${D2}/conf/ref"; cp "${L}/agents/conf.md" "${D2}/agents/"; echo x > "${D2}/conf/ref/formats.md"
rm -f "${S}/agents/conf.md"
out="$(node "${RC}" "${work}/p1.txt" "${work}/s5" --expert conf --from "${S}" --draft "${D2}" --launcher "${F}/launcher" 2>&1)"
has "route: --draft adds it"       "${out}" "recall 1/1"
t "route: --draft copies its dir"  "$([ -f "${work}/s5/conf/ref/formats.md" ] && echo yes)" yes
exit "${fail}"
