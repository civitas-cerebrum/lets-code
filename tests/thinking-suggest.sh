#!/usr/bin/env bash
# Unit test for suggested_thinking_level: setup's suggestion stops at medium
# (the default) however large the window; small windows get lower levels.
set -eu
eval "$(sed -n '/^suggested_thinking_level() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
fail=0
check() { local got; got="$(suggested_thinking_level "$1" "$2")"; if [ "${got}" = "$3" ]; then echo "ok    context $1, cap $2 -> ${got}"; else echo "FAIL  context $1, cap $2 -> ${got} (want $3)"; fail=1; fi; }
check 1048576 32768 medium
check 262144  32768 medium
check 131072  32768 medium
check 65536   16384 medium
check 32768   8192  low
check 16384   4096  low
check 8192    2048  minimal
check 2048    512   off
exit "${fail}"
