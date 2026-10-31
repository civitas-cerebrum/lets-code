#!/usr/bin/env bash
# The compaction reserve lets-code writes into pi's settings: the output cap
# plus a margin for pi's low estimate of the context (context/6, at most 16k).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-reserve.XXXXXX")"
trap 'rm -rf "${d}"' EXIT
python3 - "${here}/../lets-code" > "${d}/fn.sh" <<'PYX'
import sys
s = open(sys.argv[1]).read()
i = s.find("\npi_write_configs() {")
sys.stdout.write(s[i:s.find("\n}\n", i) + 3])
PYX
log() { :; }
log_verbose() { :; }
. "${d}/fn.sh"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
reserve() {  # reserve <context> <cap>
    PI_AGENT_DIR="${d}/$1-$2"; mkdir -p "${PI_AGENT_DIR}"
    CLAUDE_URL="" pi_write_configs http://127.0.0.1:1/v1 openai-completions m "$1" "$2" false false medium >/dev/null 2>&1 || true
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compaction"]["modelOverrides"]["lets-code/m"]["reserveTokens"])' "${PI_AGENT_DIR}/settings.json" 2>/dev/null || echo none
}
check "32k window, 8k cap: the cap plus a sixth of the window" "$(reserve 32768 8192)" 13653
check "128k window, 32k cap: the margin at most 16k" "$(reserve 131072 32768)" 49152
check "1M window: the margin still 16k" "$(reserve 1000000 32000)" 48384
check "8k window, 2k cap: a sixth" "$(reserve 8192 2048)" 3413
r=$(reserve 32768 8192)
check "the reserve stays below the window" "$(( r < 32768 ))" 1
exit "${fail}"
