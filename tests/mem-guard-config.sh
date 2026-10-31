#!/usr/bin/env bash
# The memory guard and RAM watcher settings reach pi: the guard off and the
# watcher on by default, MEM_GUARD / MEM_WATCH from the config, env and flags
# over it, a bad value refused at launch, nothing exported with both off, and
# an outer session's markers (LETS_CODE_PI, LETS_CODE_RUN) dropped. Runs
# against a fake /v1/models server and a fake pi that records its env.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
lc="${here}/../lets-code"
[ "$(uname -s)" = Linux ] || { echo "skipped: the memory guard is Linux only"; exit 0; }
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-memcfg.XXXXXX")"
srv=""
trap '[ -z "${srv}" ] || kill "${srv}" 2>/dev/null; rm -rf "${d}"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }

cat > "${d}/server.py" <<'PY'
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/v1/models":
            self.send_error(404); return
        body = json.dumps({"data": [{"id": "served-a", "max_model_len": 65536}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        self.send_error(404)
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
python3 "${d}/server.py" > "${d}/port" &
srv=$!
for _ in $(seq 300); do [ -s "${d}/port" ] && break; sleep 0.1; done
[ -s "${d}/port" ] || { echo "FAIL  the fake server did not start within 30 s"; exit 1; }
url="http://127.0.0.1:$(cat "${d}/port")"

# a pi that records what the guard would read
mkdir -p "${d}/bin"
cat > "${d}/bin/pi" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--help" ]; then echo "  --print, -p   Non-interactive mode"; exit 0; fi
echo "session=${LETS_CODE_SESSION:-} guard=${LETS_CODE_MEM_GUARD:-} watch=${LETS_CODE_MEM_WATCH:-} pi=${LETS_CODE_PI:-} run=${LETS_CODE_RUN:-}" > "${PI_RECORD}"
SH
chmod +x "${d}/bin/pi"

export PATH="${d}/bin:${PATH}" XDG_CONFIG_HOME="${d}/config" PI_CODING_AGENT_DIR="${d}/agent" PI_OFFLINE=1 PI_RECORD="${d}/record"
unset LETS_CODE_MEM_GUARD LETS_CODE_MEM_WATCH LETS_CODE_PI LETS_CODE_RUN
mkdir -p "${d}/config/lets-code"
config() {
    cat > "${d}/config/lets-code/config" <<EOF
ENDPOINTS="${url}"
TOKEN="t"
REASONING="false"
VISION="false"
GIT_GUARD="false"
$*
EOF
}
launch() { rm -f "${d}/record"; (cd "${d}" && bash "${lc}" "$@" -p hi < /dev/null > "${d}/out" 2> "${d}/err") || true; cat "${d}/record" 2>/dev/null || echo "(pi not started)"; }

config ""
check "defaults: guard off, watcher on" "$(launch)" "session=1 guard=false watch=true pi= run="

config 'MEM_GUARD="true"'
check "config: MEM_GUARD=true" "$(launch)" "session=1 guard=true watch=true pi= run="

config 'MEM_GUARD="false"
MEM_WATCH="false"'
check "env over config" "$(LETS_CODE_MEM_GUARD=true launch)" "session=1 guard=true watch=false pi= run="
check "--mem-guard" "$(launch --mem-guard)" "session=1 guard=true watch=false pi= run="
check "both off: nothing exported" "$(launch)" "session= guard= watch= pi= run="

config 'MEM_GUARD="yes"
MEM_WATCH="on"'
check "yes/on are true" "$(launch)" "session=1 guard=true watch=true pi= run="
check "--no-mem-guard --no-mem-watch" "$(launch --no-mem-guard --no-mem-watch)" "session= guard= watch= pi= run="

config 'MEM_GUARD_PROCESS="20%"
MEM_GUARD_SESSION="45%"'
check "the old size keys are ignored" "$(launch)" "session=1 guard=false watch=true pi= run="
check "an outer session's markers are dropped" "$(LETS_CODE_PI=1:1 LETS_CODE_RUN=1:1 launch)" "session=1 guard=false watch=true pi= run="

config 'MEM_GUARD="lots"'
check "a bad value: pi is not started" "$(launch)" "(pi not started)"
check "a bad value: says which and why" "$(grep -c 'MEM_GUARD must be true or false' "${d}/err")" 1
exit "${fail}"
