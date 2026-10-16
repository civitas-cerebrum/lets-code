#!/usr/bin/env bash
# Unit test: the $var names pi_write_configs writes into models.json must be
# names pi's models.json schema accepts. Since pi 1.2.0 the schema only
# allows thinking.enabled, thinking.effort and thinking.budget; any other
# name (2026-10-16 shipped "thinking.level" for the template effort control)
# makes pi reject the whole lets-code provider: "Unknown provider".
# No model server needed: asserts on the generated models.json only.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(sed -n '/^pi_write_configs() {/,/^PY$/p' "${here}/../lets-code"; echo '}')"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT

# vLLM chat-template mode with the server template exposing effort control
# (non-empty effort map): the reasoning_effort kwarg carries pi's name for
# the current thinking level, not lets-code's own wording.
PI_AGENT_DIR="$d/vllm" pi_write_configs http://192.168.0.114/vllm/v1 openai-completions qwen 196608 32768 false true medium '{"low": "low"}'
m="$d/vllm/models.json"
check "effort \$var is pi's thinking.effort" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat']['chatTemplateKwargs']['reasoning_effort']['\$var'])")" "thinking.effort"
check "effort kwarg omitted when thinking off" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['compat']['chatTemplateKwargs']['reasoning_effort'].get('omitWhenOff'))")" "True"
check "level map kept with the kwarg" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code']['models'][0].get('thinkingLevelMap'))")" "{'low': 'low'}"

# the same call without an effort map: the kwarg is absent, not a stub
PI_AGENT_DIR="$d/nomap" pi_write_configs http://192.168.0.114/vllm/v1 openai-completions qwen 196608 32768 false true medium ''
check "no effort kwarg without effort map" "$(python3 -c "import json;print('reasoning_effort' in json.load(open('$d/nomap/models.json'))['providers']['lets-code']['compat']['chatTemplateKwargs'])")" "False"

# the whole class: every \$var the writer may emit (chatTemplateKwargs or
# chatTemplateArgs, any provider) must be one pi's schema accepts
allowed='{"thinking.enabled", "thinking.effort", "thinking.budget"}'
for m in "$d/vllm/models.json" "$d/nomap/models.json"; do
bad="$(python3 - "$m" <<'PY'
import json, sys
allowed = {"thinking.enabled", "thinking.effort", "thinking.budget"}
doc = json.load(open(sys.argv[1]))
bad = []
for prov in doc.get("providers", {}).values():
    compat = prov.get("compat") or {}
    for key in ("chatTemplateKwargs", "chatTemplateArgs"):
        for name, val in (compat.get(key) or {}).items():
            if isinstance(val, dict) and val.get("$var") not in allowed:
                bad.append(f"{key}.{name}={val.get('$var')}")
print(";".join(bad))
PY
)"
check "all \$vars in pi's accepted set ($m)" "$bad" ""
done
exit "$fail"
