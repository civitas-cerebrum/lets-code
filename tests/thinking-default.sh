#!/usr/bin/env bash
# lc_thinking_default and pi_write_configs' note of what it wrote: the default
# for new sessions changes only where pi changes it (its settings menu, the
# thinking selector's set-as-default key) or in setup; a level picked in a
# session is never saved as one.
set -u
L="$(dirname "$0")/../lets-code"
eval "$(sed -n '/^lc_thinking_default() {/,/^}$/p' "${L}")"
eval "$(sed -n '/^pi_write_configs() {/,/^PY$/p' "${L}"; echo '}')"
PI_AGENT_DIR="$(mktemp -d)"; trap 'rm -rf "${PI_AGENT_DIR}"' EXIT
export PI_AGENT_DIR PROVIDER_ID=lets-code
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
st() { python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "${PI_AGENT_DIR}/lets-code-state.json" "$1"; }
setj() { python3 -c 'import json, os, sys; p = sys.argv[1]; d = json.load(open(p)) if os.path.exists(p) else {}; exec(sys.argv[2]); json.dump(d, open(p, "w"))' "${PI_AGENT_DIR}/$1" "$2"; }
write() { pi_write_configs http://h/v1 openai-completions qwen 131072 32768 false true "$1" >/dev/null; }
K=lets-code/qwen

check "nothing set: no default" "$(lc_thinking_default "${K}")" ""
write medium
check "the level written is noted" "$(st 'd["thinkingSeen"]["models"]["lets-code/qwen"]')" "medium"
check "a launch that changes nothing: no default" "$(lc_thinking_default "${K}")" ""
setj settings.json 'd["modelThinkingLevels"]["lets-code/qwen"] = "high"'
check "pi's settings menu: the new default" "$(lc_thinking_default "${K}")" "high"
write high
check "kept on later launches" "$(lc_thinking_default "${K}")" "high"
setj settings.json 'd["modelThinkingLevels"]["lets-code/other"] = "off"'
check "another model's level: not this one's" "$(lc_thinking_default "${K}")" "high"
setj settings.json 'd["defaultThinkingLevel"] = "low"'
check "the selector's set-as-default key: the new default" "$(lc_thinking_default "${K}")" "low"
write low
check "kept on later launches" "$(lc_thinking_default "${K}")" "low"
setj settings.json 'd["modelThinkingLevels"]["lets-code/qwen"] = "huge"'
check "an invalid level is ignored" "$(lc_thinking_default "${K}")" "low"
write low
# the global default is noticed by each model at its own next launch
K2=lets-code/other2
check "model 2: first launch" "$(lc_thinking_default "${K2}")" ""
setj settings.json 'd["defaultThinkingLevel"] = "xhigh"'
check "set-as-default: model 2 takes it up" "$(lc_thinking_default "${K2}")" "xhigh"
check "set-as-default: and model 1 too, launched later" "$(lc_thinking_default "${K}")" "xhigh"
write xhigh
# pi's "remove override" in the settings menu: back to lets-code's level
setj settings.json 'd["modelThinkingLevels"].pop("lets-code/qwen")'
check "override removed in pi: the adopted default goes" "$(lc_thinking_default "${K}")" ""
write medium
setj settings.json 'd["modelThinkingLevels"]["lets-code/qwen"] = "low"'
setj settings.json 'd["defaultThinkingLevel"] = "high"'
LC_THINKING_RESET=1 write medium
check "setup's answer replaces it, and changes in pi made before setup" "$(lc_thinking_default "${K}")" ""
write medium
pi_write_configs http://h/v1 openai-completions qwen 131072 32768 false false off >/dev/null
check "thinking unregistered: nothing noted for it" "$(st '"lets-code/qwen" in d["thinkingSeen"]["models"]')" "False"
printf 'not json' > "${PI_AGENT_DIR}/lets-code-state.json"
check "unreadable state: no default, no failure" "$(lc_thinking_default "${K}"; echo "rc=$?")" "rc=0"
check "unreadable state: left as it is" "$(cat "${PI_AGENT_DIR}/lets-code-state.json")" "not json"
write medium
check "unreadable state: the launch still writes its configs" "$?" "0"
exit "${fail}"
