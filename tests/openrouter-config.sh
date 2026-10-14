#!/usr/bin/env bash
# Unit test: pi_write_configs writes OpenRouter's reasoning mode (not vLLM's
# chat-template kwargs) for an openrouter.ai endpoint, and leaves vLLM as it was;
# on vLLM, xhigh gets its template value and a 32k budget only when the cap fits.
set -eu
eval "$(sed -n '/^pi_write_configs() {/,/^PY$/p' "$(dirname "$0")/../lets-code"; echo '}')"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got $2, want $3"; fail=1; fi; }
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
PI_AGENT_DIR="$d/or" pi_write_configs https://openrouter.ai/api/v1 openai-completions vendor/model 131072 32768 false true off
m="$d/or/models.json"
check "openrouter: thinkingFormat" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat'].get('thinkingFormat'))")" openrouter
check "openrouter: no chat-template kwargs" "$(python3 -c "import json;print('chatTemplateKwargs' in json.load(open('$m'))['providers']['lets-code']['compat'])")" False
check "openrouter: no thinking_token_budget flag" "$(python3 -c "import json;print('supportsThinkingTokenBudget' in json.load(open('$m'))['providers']['lets-code']['compat'])")" False
check "openrouter: reasoning model" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['models'][0].get('reasoning'))")" True
PI_AGENT_DIR="$d/vllm" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 196608 32768 false true medium '{"low": "low"}'
m="$d/vllm/models.json"
check "vllm: chat-template mode kept" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat'].get('thinkingFormat'))")" chat-template
check "vllm: effort variable kept" "$(python3 -c "import json;print('reasoning_effort' in json.load(open('$m'))['providers']['lets-code']['compat']['chatTemplateKwargs'])")" True
# xhigh: mapped and given its own budget only when the cap leaves answer room
j() { python3 -c "import json,sys;m=json.load(open(sys.argv[1]))['providers']['lets-code']['models'][0];print($2)" "$1"; }
EM='{"minimal": "low", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh"}'
PI_AGENT_DIR="$d/x32" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 32768 false true medium "$EM"
check "vllm cap 32768: xhigh unmapped" "$(j "$d/x32/models.json" "'xhigh' in m['thinkingLevelMap']")" False
check "vllm cap 32768: other levels as before" "$(j "$d/x32/models.json" "json.dumps(m['thinkingLevelMap'])")" '{"minimal": "low", "low": "low", "medium": "medium", "high": "high"}'
check "vllm cap 32768: no per-level sampling" "$(j "$d/x32/models.json" "'samplingParamsByThinkingLevel' in m")" False
# unpinned cap: xhigh still offered, with its own output cap for xhigh requests only
XHIGH_LEVEL_CAP=49152 PI_AGENT_DIR="$d/xl" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 32768 false true medium "$EM"
check "vllm cap 32768 + level cap: xhigh mapped" "$(j "$d/xl/models.json" "m['thinkingLevelMap'].get('xhigh')")" xhigh
check "vllm cap 32768 + level cap: xhigh request cap" "$(j "$d/xl/models.json" "json.dumps(m['samplingParamsByThinkingLevel'])")" '{"xhigh": {"thinking_token_budget": 32768, "max_tokens": 49152, "max_completion_tokens": 49152}}'
check "vllm cap 32768 + level cap: maxTokens unchanged" "$(j "$d/xl/models.json" "m['maxTokens']")" 32768
XHIGH_LEVEL_CAP=40959 PI_AGENT_DIR="$d/xs" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 32768 false true medium "$EM"
check "vllm level cap 40959: too small for xhigh" "$(j "$d/xs/models.json" "'xhigh' in m['thinkingLevelMap']")" False
XHIGH_LEVEL_CAP=49152 PI_AGENT_DIR="$d/xb" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 49152 false true xhigh "$EM"
check "vllm cap 49152 + level cap: no request cap needed" "$(j "$d/xb/models.json" "json.dumps(m['samplingParamsByThinkingLevel'])")" '{"xhigh": {"thinking_token_budget": 32768}}'
PI_AGENT_DIR="$d/x48" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 49152 false true xhigh "$EM"
check "vllm cap 49152: xhigh mapped" "$(j "$d/x48/models.json" "m['thinkingLevelMap'].get('xhigh')")" xhigh
check "vllm cap 49152: max unmapped" "$(j "$d/x48/models.json" "'max' in m['thinkingLevelMap']")" False
check "vllm cap 49152: xhigh budget" "$(j "$d/x48/models.json" "json.dumps(m['samplingParamsByThinkingLevel'])")" '{"xhigh": {"thinking_token_budget": 32768}}'
check "vllm cap 49152: maxTokens" "$(j "$d/x48/models.json" "m['maxTokens']")" 49152
check "vllm cap 49152: startup level" "$(python3 -c "import json;print(json.load(open('$d/x48/settings.json'))['modelThinkingLevels']['lets-code/qwen'])")" xhigh
PI_AGENT_DIR="$d/x40" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 40959 false true xhigh "$EM"
check "vllm cap 40959: too small for xhigh" "$(j "$d/x40/models.json" "'xhigh' in m['thinkingLevelMap']")" False
PI_AGENT_DIR="$d/xne" pi_write_configs http://10.0.0.5/vllm/v1 openai-completions qwen 262144 49152 false true xhigh
check "vllm no effort control: xhigh still supported" "$(j "$d/xne/models.json" "json.dumps(m.get('thinkingLevelMap'))")" '{"xhigh": "xhigh"}'
check "vllm no effort control: no effort kwarg" "$(python3 -c "import json;print('reasoning_effort' in json.load(open('$d/xne/models.json'))['providers']['lets-code']['compat']['chatTemplateKwargs'])")" False
PI_AGENT_DIR="$d/xor" pi_write_configs https://openrouter.ai/api/v1 openai-completions vendor/model 262144 49152 false true xhigh
check "openrouter: no xhigh sampling override" "$(j "$d/xor/models.json" "'samplingParamsByThinkingLevel' in m")" False
LETS_CODE_OPENROUTER_PROVIDER=Alibaba PI_AGENT_DIR="$d/pin" pi_write_configs https://openrouter.ai/api/v1 openai-completions qwen/qwen3.8-27b 196608 32768 false true off
m="$d/pin/models.json"
check "openrouter: provider pinned without fallbacks" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat'].get('openRouterRouting'))")" "{'order': ['Alibaba'], 'allow_fallbacks': False}"
check "openrouter: no pin by default" "$(python3 -c "import json;print('openRouterRouting' in json.load(open('$d/or/models.json'))['providers']['lets-code']['compat'])")" False
exit "$fail"
