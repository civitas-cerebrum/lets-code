#!/usr/bin/env bash
# Unit test for normalize_endpoint: extracts the function from ./lets-code.
set -eu
eval "$(sed -n '/^normalize_endpoint() {/,/^}/p; /^normalize_endpoints() {/,/^}/p' "$(dirname "$0")/../lets-code")"

fail=0
check() {
    local got; got="$(normalize_endpoint "$1")"
    if [ "${got}" = "$2" ]; then echo "ok    $1 -> ${got}"; else echo "FAIL  $1 -> ${got} (want $2)"; fail=1; fi
}
check 10.0.0.5/vllm            http://10.0.0.5/vllm
check 10.0.0.6:8000            http://10.0.0.6:8000
check 10.0.0.6:8000/v1/        http://10.0.0.6:8000
check vllm.example.com               https://vllm.example.com
check vllm.example.com/v1            https://vllm.example.com
check llm.example.com:8443/api      https://llm.example.com:8443/api
check localhost:8000                http://localhost:8000
check gpu-box.local/vllm           http://gpu-box.local/vllm
check gpu-box:8000                 http://gpu-box:8000
check '[::1]:8000'                  'http://[::1]:8000'
check http://vllm.example.com        http://vllm.example.com
check https://10.0.0.5/vllm/   https://10.0.0.5/vllm
check https://openrouter.ai/api/v1  https://openrouter.ai/api

got="$(normalize_endpoints "vllm.example.com 10.0.0.5/vllm")"
want="https://vllm.example.com http://10.0.0.5/vllm"
if [ "${got}" = "${want}" ]; then echo "ok    list -> ${got}"; else echo "FAIL  list -> ${got} (want ${want})"; fail=1; fi
exit "${fail}"
