#!/usr/bin/env bash
# Unit test for normalize_endpoint: extracts the function from ./lets-code.
set -eu
eval "$(sed -n '/^normalize_endpoint() {/,/^}/p; /^normalize_endpoints() {/,/^}/p' "$(dirname "$0")/../lets-code")"

fail=0
check() {
    local got; got="$(normalize_endpoint "$1")"
    if [ "${got}" = "$2" ]; then echo "ok    $1 -> ${got}"; else echo "FAIL  $1 -> ${got} (want $2)"; fail=1; fi
}
check 192.168.0.114/vllm            http://192.168.0.114/vllm
check 192.168.0.112:8000            http://192.168.0.112:8000
check 192.168.0.112:8000/v1/        http://192.168.0.112:8000
check vllm.i-bora.com               https://vllm.i-bora.com
check vllm.i-bora.com/v1            https://vllm.i-bora.com
check llm.example.com:8443/api      https://llm.example.com:8443/api
check localhost:8000                http://localhost:8000
check borealis.local/vllm           http://borealis.local/vllm
check borealis:8000                 http://borealis:8000
check '[::1]:8000'                  'http://[::1]:8000'
check http://vllm.i-bora.com        http://vllm.i-bora.com
check https://192.168.0.114/vllm/   https://192.168.0.114/vllm
check https://openrouter.ai/api/v1  https://openrouter.ai/api

got="$(normalize_endpoints "vllm.i-bora.com 192.168.0.114/vllm")"
want="https://vllm.i-bora.com http://192.168.0.114/vllm"
if [ "${got}" = "${want}" ]; then echo "ok    list -> ${got}"; else echo "FAIL  list -> ${got} (want ${want})"; fail=1; fi
exit "${fail}"
