#!/usr/bin/env bash
# Unit test for default_output_cap: the default output cap is 32768 but
# never more than a quarter of the context window.
set -eu
eval "$(sed -n '/^DEFAULT_OUTPUT_CAP=/p; /^default_output_cap() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
fail=0
check() { local got; got="$(default_output_cap "$1")"; if [ "${got}" = "$2" ]; then echo "ok    context $1 -> ${got}"; else echo "FAIL  context $1 -> ${got} (want $2)"; fail=1; fi; }
check 196608 32768
check 131072 32768
check 32768  8192
check 8192   2048
check ""     32768
check abc    32768
exit "${fail}"
