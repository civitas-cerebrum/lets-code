#!/usr/bin/env bash
# Unit test for default_output_cap: the default output cap is 32768 but
# never more than a quarter of the context window. xhigh_output_cap: the
# raised default for a startup level of xhigh (49152, capped at a quarter of
# the context; empty when budget + answer room do not fit).
set -eu
eval "$(sed -n '/^DEFAULT_OUTPUT_CAP=/p; /^XHIGH_[A-Z_]*=/p; /^default_output_cap() {/,/^}$/p; /^xhigh_output_cap() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
fail=0
check() { local got; got="$(default_output_cap "$1")"; if [ "${got}" = "$2" ]; then echo "ok    context $1 -> ${got}"; else echo "FAIL  context $1 -> ${got} (want $2)"; fail=1; fi; }
check 196608 32768
check 131072 32768
check 32768  8192
check 8192   2048
check ""     32768
check abc    32768
xcheck() { local got; got="$(xhigh_output_cap "$1")"; if [ "${got}" = "$2" ]; then echo "ok    xhigh context $1 -> ${got:-<none>}"; else echo "FAIL  xhigh context $1 -> ${got:-<none>} (want ${2:-<none>})"; fail=1; fi; }
xcheck 262144 49152
xcheck 196608 49152
xcheck 163840 40960
xcheck 160000 ""
xcheck 131072 ""
xcheck ""     ""
exit "${fail}"
