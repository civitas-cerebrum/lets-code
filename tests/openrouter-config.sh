#!/usr/bin/env bash
# Unit test: pi_write_configs writes OpenRouter's reasoning mode (not vLLM's
# chat-template kwargs) for an openrouter.ai endpoint, and leaves vLLM as it was.
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
PI_AGENT_DIR="$d/vllm" pi_write_configs http://192.168.0.114/vllm/v1 openai-completions qwen 196608 32768 false true medium '{"low": "low"}'
m="$d/vllm/models.json"
check "vllm: chat-template mode kept" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat'].get('thinkingFormat'))")" chat-template
check "vllm: effort variable kept" "$(python3 -c "import json;print('reasoning_effort' in json.load(open('$m'))['providers']['lets-code']['compat']['chatTemplateKwargs'])")" True
LETS_CODE_OPENROUTER_PROVIDER=Alibaba PI_AGENT_DIR="$d/pin" pi_write_configs https://openrouter.ai/api/v1 openai-completions qwen/qwen3.8-27b 196608 32768 false true off
m="$d/pin/models.json"
check "openrouter: provider pinned without fallbacks" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat'].get('openRouterRouting'))")" "{'order': ['Alibaba'], 'allow_fallbacks': False}"
check "openrouter: no pin by default" "$(python3 -c "import json;print('openRouterRouting' in json.load(open('$d/or/models.json'))['providers']['lets-code']['compat'])")" False
exit "$fail"
