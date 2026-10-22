#!/usr/bin/env bash
# Unit test for pi_write_ui_tester: extracts the functions from ./lets-code and
# runs them against a scratch agent dir with a fake npm (a stub install with a
# fake playwright), fake appium/adb for the mobile check, and e2e-init.
set -eu
src="$(dirname "$0")/../lets-code"
PI_AGENT_DIR=/nonexistent     # UI_TESTER_DIR is derived from it; set for real below
eval "$(python3 - "${src}" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.find("\nUI_TESTER_PINS=")
j = s.find("\n}\n", s.find("\nui_tester_write_agent() {"))
sys.stdout.write(s[i:j + 3])
PY
)"
LOG_PREFIX="[lets-code]"; log() { echo "${LOG_PREFIX} ${1}"; }
bash_bin="$(command -v bash)"

work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ui-tester-test.XXXXXX")" && pwd)"   # macOS TMPDIR ends in /
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin" "${work}/agent"
cat > "${work}/bin/npm" <<'SH'
#!/bin/sh
# records the call (cwd, args, deps asked for); installs a stub
{ printf '%s|%s|' "$(pwd)" "$*"; python3 -c 'import json; d=json.load(open("package.json")); print(",".join(sorted(f"{k}@{v}" for k, v in {**d.get("dependencies", {}), **d.get("devDependencies", {})}.items())))'; } >> "${NPM_LOG}"
mkdir -p node_modules/.bin
printf '#!/bin/sh\necho "playwright $*" >> "%s"\n' "${PW_LOG}" > node_modules/.bin/playwright; chmod +x node_modules/.bin/playwright
SH
chmod +x "${work}/bin/npm"
export PATH="${work}/bin:${PATH}" NPM_LOG="${work}/npm.log" PW_LOG="${work}/pw.log"
: > "${NPM_LOG}"
PI_AGENT_DIR="${work}/agent"; UI_TESTER_DIR="${PI_AGENT_DIR}/ui-tester"

fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }
pins_sorted="$(printf '%s\n' ${UI_TESTER_PINS} | sort | tr '\n' ',' | sed 's/,$//')"

pi_write_ui_tester on >/dev/null 2>&1
t "ready"                          "${UI_TESTER_NOTE}" ""
t "installed once"                 "$(grep -c "^${UI_TESTER_DIR}/runtime|" "${NPM_LOG}")" 1
t "the pinned packages"            "$(cut -d'|' -f3 "${NPM_LOG}")" "${pins_sorted}"
t "install scripts off"            "$(cut -d'|' -f2 "${NPM_LOG}" | grep -c -- '--ignore-scripts')" 1
t "exact versions"                 "$(printf '%s\n' ${UI_TESTER_PINS} | grep -c '@[0-9][0-9.]*$')" 4
t "the API, not achilles"          "$(printf '%s\n' ${UI_TESTER_PINS} | grep -c '^@civitas-cerebrum/achilles')" 0
t "chromium"                       "$(cat "${PW_LOG}")" "playwright install chromium"
t "marker = pins"                  "$(cat "${UI_TESTER_DIR}/runtime/.installed")" "${UI_TESTER_PINS}"
t "no agent dir, no extension"     "$([ -e "${UI_TESTER_DIR}/agent" ] || [ -e "${UI_TESTER_DIR}/extension.ts" ] && echo yes || echo no)" no
t "helpers executable"             "$([ -x "${UI_TESTER_DIR}/bin/e2e-init" ] && [ -x "${UI_TESTER_DIR}/bin/mobile-check" ] && echo yes)" yes
t "peek: lets-code's"              "$(head -n 1 "${UI_TESTER_DIR}/bin/peek.mjs" | grep -c 'Written by lets-code')" 1
t "refs: paths filled in"          "$(cat "${UI_TESTER_DIR}"/ref/*.md | grep -c '@@T@@')" 0
t "prompt: paths filled in"        "$(grep -c '@@T@@' "${UI_TESTER_DIR}/prompt.md"):$(grep -c "${UI_TESTER_DIR}/bin/e2e-init" "${UI_TESTER_DIR}/prompt.md")" "0:1"
t "prompt: no harness tools"       "$(grep -c -E '\b(Skill|Agent|Task) ?\{|hook|ledger' "${UI_TESTER_DIR}/prompt.md")" 0
for r in $(grep -o "${UI_TESTER_DIR}/ref/[a-z-]*\.md" "${UI_TESTER_DIR}/prompt.md" | sort -u); do
    t "ref $(basename "${r}") written" "$([ -s "${r}" ] && echo yes)" yes
done
t "refs: none unreferenced"        "$(for r in "${UI_TESTER_DIR}"/ref/*.md; do grep -q "${r}" "${UI_TESTER_DIR}/prompt.md" || echo "${r}"; done)" ""

# the ui-tester expert
af="${PI_AGENT_DIR}/agents/ui-tester.md"
t "agent file written"             "$(grep -c '^# Written by lets-code' "${af}")" 1
t "agent: in place"                "${UI_TESTER_AGENT}" 1
t "agent: no agent dir"            "$(grep -c '^agent_dir:' "${af}")" 0
t "agent: prompt exists"           "$([ -f "${PI_AGENT_DIR}/$(sed -n 's/^append_prompt: //p' "${af}")" ] && echo yes)" yes
t "agent: requires the install"    "$([ -e "${PI_AGENT_DIR}/$(sed -n 's/^requires: //p' "${af}")" ] && echo yes)" yes
t "agent: pi's tools"              "$(sed -n 's/^tools: //p' "${af}")" "bash, read, edit, write, grep, find, ls"
t "agent: timeout 3600"            "$(grep '^timeout:' "${af}")" "timeout: 3600"
t "agent: an expert"               "$(sed -n 's/^expert: //p' "${af}")" true
t "agent: not on Termux"           "$(sed -n 's/^platform: //p' "${af}")" "linux, darwin"
t "agent: its setup script"        "$([ -x "${PI_AGENT_DIR}/$(sed -n 's/^setup: //p' "${af}")" ] && echo yes)" yes
t "agent: use_for fits the line"   "$([ "$(sed -n 's/^use_for: //p' "${af}" | wc -c)" -le 101 ] && echo yes)" yes
t "agent: keywords fit"            "$([ "$(sed -n 's/^keywords: //p' "${af}" | wc -c)" -le 41 ] && echo yes)" yes
t "agent: brief template"          "$(sed -n 's/^  - \([a-z_]*\).*/\1/p' "${af}" | tr '\n' ' ')" "target platform goal how_to_run scope constraints "
t "agent: required fields"         "$(grep -c '^  - [a-z_]* (required):' "${af}" | tr -d ' ')" 2
rm -rf "${PI_AGENT_DIR}/agents"; mkdir -p "${PI_AGENT_DIR}/agents"
printf -- '---\nname: ui-tester\ndescription: mine\n---\nmine\n' > "${af}"
pi_write_ui_tester on >/dev/null 2>&1
t "user's own file kept"           "$(grep -c 'description: mine' "${af}")" 1
t "user's file: not ours"          "${UI_TESTER_AGENT:-none}" none
rm -f "${af}"
pi_write_ui_tester on >/dev/null 2>&1
t "agent rewritten after removal"  "$(grep -c '^# Written by lets-code' "${af}")" 1
t "no temp files left"             "$(ls "${PI_AGENT_DIR}/agents" | tr '\n' ' ')" "ui-tester.md "
t "no reinstall"                   "$(grep -c "^${UI_TESTER_DIR}/runtime|" "${NPM_LOG}")" 1
echo old > "${UI_TESTER_DIR}/runtime/.installed"
pi_write_ui_tester on >/dev/null 2>&1
t "other pins -> reinstall"        "$(grep -c "^${UI_TESTER_DIR}/runtime|" "${NPM_LOG}"):$(cat "${UI_TESTER_DIR}/runtime/.installed")" "2:${UI_TESTER_PINS}"
mkdir -p "${UI_TESTER_DIR}/agent"; : > "${UI_TESTER_DIR}/extension.ts"
pi_write_ui_tester files >/dev/null
t "an earlier design's files go"   "$([ -e "${UI_TESTER_DIR}/agent" ] || [ -e "${UI_TESTER_DIR}/extension.ts" ] && echo yes || echo no)" no

# e2e-init: a test project from the pins, nothing overwritten
proj="${work}/site"; mkdir -p "${proj}"
out="$(bash "${UI_TESTER_DIR}/bin/e2e-init" "${proj}" http://localhost:8765)"
t "e2e-init: says ready"           "$(echo "${out}" | grep -c '^ready: ')" 1
t "e2e-init: web pins as devDeps"  "$(grep "^${proj}|" "${NPM_LOG}" | cut -d'|' -f2)" "install -D --prefer-offline --ignore-scripts --no-audit --no-fund --loglevel=error $(printf '%s\n' ${UI_TESTER_PINS} | grep -v '^webdriverio@' | tr '\n' ' ' | sed 's/ $//')"
t "e2e-init: baseURL"              "$(grep -c "baseURL: 'http://localhost:8765'," "${proj}/playwright.config.ts")" 1
t "e2e-init: fixture"              "$(grep -c "baseFixture(base, 'tests/data/page-repository.json')" "${proj}/tests/fixtures/base.ts")" 1
t "e2e-init: page repository"      "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])))' "${proj}/tests/data/page-repository.json")" "{'pages': []}"
t "e2e-init: specs dir"            "$([ -d "${proj}/tests/e2e" ] && echo yes)" yes
echo '// mine' > "${proj}/playwright.config.ts"; echo '{"pages":[{"name":"X"}]}' > "${proj}/tests/data/page-repository.json"
bash "${UI_TESTER_DIR}/bin/e2e-init" "${proj}" >/dev/null
t "e2e-init: never overwrites"     "$(cat "${proj}/playwright.config.ts")|$(cat "${proj}/tests/data/page-repository.json")" '// mine|{"pages":[{"name":"X"}]}'
p2="${work}/nourl"; bash "${UI_TESTER_DIR}/bin/e2e-init" "${p2}" >/dev/null
t "e2e-init: no URL, no baseURL"   "$(grep -c baseURL "${p2}/playwright.config.ts")" 0
p3="${work}/app-mobile"; out="$(bash "${UI_TESTER_DIR}/bin/e2e-init" --mobile "${p3}")"
t "e2e-init --mobile: WebdriverIO and the repository" "$(grep "^${p3}|" "${NPM_LOG}" | cut -d'|' -f2 | tr ' ' '\n' | grep '@' | sort | tr '\n' ' ')" "$(printf '%s\n' ${UI_TESTER_PINS} | grep -E '^(webdriverio|@civitas-cerebrum/element-repository)@' | sort | tr '\n' ' ')"
t "e2e-init --mobile: no Playwright config" "$([ -e "${p3}/playwright.config.ts" ] && echo yes || echo no):$([ -d "${p3}/tests/mobile" ] && echo yes)" "no:yes"

# mobile-check: what is missing, then ready with appium, adb, a device and the SDK
min="${work}/min"; mkdir -p "${min}"
for c in awk wc tr grep sort uname sed tail; do ln -s "$(command -v "${c}")" "${min}/${c}"; done
rc=0; out="$(env -i PATH="${min}" HOME="${work}" "${bash_bin}" "${UI_TESTER_DIR}/bin/mobile-check")" || rc=$?
t "mobile: not ready -> exit 1"    "${rc}" 1
t "mobile: says appium is missing" "$(echo "${out}" | grep -c 'appium not found')" 1
t "mobile: says adb is missing"    "$(echo "${out}" | grep -c 'adb not found')" 1
t "mobile: web unaffected"         "$(echo "${out}" | tail -n 1)" "mobile: not ready (missing: appium android-sdk); web testing is unaffected"
printf '#!/bin/sh\ncase "$1" in --version) echo 2.11.0 ;; driver) echo "uiautomator2@3.0.0 [installed (npm)]" ;; esac\n' > "${min}/appium"
printf '#!/bin/sh\nprintf "List of devices attached\\nemulator-5554\\tdevice\\n\\n"\n' > "${min}/adb"
printf '#!/bin/sh\n' > "${min}/java"; chmod +x "${min}/appium" "${min}/adb" "${min}/java"
rc=0; out="$(env -i PATH="${min}" HOME="${work}" ANDROID_HOME=/sdk "${bash_bin}" "${UI_TESTER_DIR}/bin/mobile-check")" || rc=$?
t "mobile: ready -> exit 0"        "${rc}:$(echo "${out}" | tail -n 1)" "0:mobile: ready"
t "mobile: one device"             "$(echo "${out}" | grep -c '1 device')" 1
t "mobile: the driver"             "$(echo "${out}" | grep -c 'drivers: uiautomator2')" 1

# setup reports the mobile check on stderr, never fails on it
rm -rf "${UI_TESTER_DIR}/runtime/.installed"
err="$(bash "${UI_TESTER_DIR}/setup" 2>&1 >/dev/null)"; rc=$?
t "setup: ok without mobile"       "${rc}" 0
t "setup: mobile lines on stderr"  "$(echo "${err}" | grep -c 'ui-tester: mobile: ')" "$(bash "${UI_TESTER_DIR}/bin/mobile-check" 2>/dev/null | wc -l | tr -d ' ')"

# files (experts on, the expert dormant): everything but the install
rm -rf "${UI_TESTER_DIR}" "${af}"; : > "${NPM_LOG}"
pi_write_ui_tester files >/dev/null
t "files: no install"              "$(wc -l < "${NPM_LOG}" | tr -d ' ')" 0
t "files: agent file, setup, prompt" "$([ -e "${af}" ] && [ -x "${UI_TESTER_DIR}/setup" ] && [ -s "${UI_TESTER_DIR}/prompt.md" ] && echo yes):${UI_TESTER_AGENT}" "yes:1"
t "files: setup --no-install says not installed" "$(bash "${UI_TESTER_DIR}/setup" --no-install >/dev/null 2>&1; echo $?)" 3

# browser download fails: a note, not marked installed (not set up)
rm -rf "${UI_TESTER_DIR}"
mkdir -p "${work}/pwbad"; printf '#!/bin/sh\nmkdir -p node_modules/.bin\nprintf "#!/bin/sh\\nexit 1\\n" > node_modules/.bin/playwright; chmod +x node_modules/.bin/playwright\n' > "${work}/pwbad/npm"
chmod +x "${work}/pwbad/npm"
PATH="${work}/pwbad:${PATH}" pi_write_ui_tester on >/dev/null 2>&1
t "browsers fail -> note"          "$(echo "${UI_TESTER_NOTE}" | grep -c 'browser download failed')" 1
t "browsers fail -> not installed" "$([ -e "${UI_TESTER_DIR}/runtime/.installed" ] && echo yes || echo no)" no

# install fails: a note; the agent file is there but not set up (requires)
rm -rf "${UI_TESTER_DIR}" "${af}"
mkdir -p "${work}/badbin"; printf '#!/bin/sh\nexit 1\n' > "${work}/badbin/npm"; chmod +x "${work}/badbin/npm"
PATH="${work}/badbin:${PATH}" pi_write_ui_tester on >/dev/null 2>&1
t "install fails -> note"          "$(echo "${UI_TESTER_NOTE}" | grep -c 'install failed')" 1
t "not installed -> no marker"     "$([ -e "${PI_AGENT_DIR}/$(sed -n 's/^requires: //p' "${af}")" ] && echo yes || echo no)" no
exit ${fail}
