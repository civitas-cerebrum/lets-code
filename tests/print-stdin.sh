#!/usr/bin/env bash
# End to end: print and JSON mode never hang on an open stdin pipe that no
# one writes (pi reads piped stdin to its end before the prompt goes out);
# piped input still reaches pi, RPC mode keeps its stdin, and stdout in
# print and JSON mode is pi's alone (the banner goes to stderr). Runs
# against a fake /v1/models server and a fake pi that reads its stdin.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
lc="${here}/../lets-code"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-stdin.XXXXXX")"
srv=""; holder=""
trap '[ -z "${srv}" ] || kill "${srv}" 2>/dev/null; [ -z "${holder}" ] || kill "${holder}" 2>/dev/null; rm -rf "${d}"' EXIT
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

# a pi that, like pi, reads piped stdin to its end in print mode (RPC: not here)
mkdir -p "${d}/bin"
cat > "${d}/bin/pi" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--help" ]; then echo "  --print, -p   Non-interactive mode"; exit 0; fi
case " $* " in *" --mode rpc "*) echo "stdin=(rpc)" > "${PI_RECORD}"; echo PI-OUT; exit 0 ;; esac
in="$(cat)"
echo "stdin=${in}" > "${PI_RECORD}"
echo PI-OUT
SH
chmod +x "${d}/bin/pi"

export PATH="${d}/bin:${PATH}" XDG_CONFIG_HOME="${d}/config" PI_CODING_AGENT_DIR="${d}/agent" PI_OFFLINE=1 PI_RECORD="${d}/record" LETS_CODE_STDIN_WAIT=1
mkdir -p "${d}/config/lets-code"
cat > "${d}/config/lets-code/config" <<EOF
ENDPOINTS="${url}"
TOKEN="t"
REASONING="false"
VISION="false"
MEM_GUARD="false"
GIT_GUARD="false"
EOF
cd "${d}"
# an open pipe no one writes: a fifo whose writer only holds it open
open_pipe() { rm -f "${d}/fifo"; mkfifo "${d}/fifo"; sleep 60 > "${d}/fifo" & holder=$!; }
done_pipe() { kill "${holder}" 2>/dev/null || true; wait "${holder}" 2>/dev/null || true; holder=""; }
secs() { python3 -c 'import time; print(time.time())'; }

open_pipe
t0=$(secs); bash "${lc}" -p hi < "${d}/fifo" > "${d}/out" 2> "${d}/err" || true; t1=$(secs)
done_pipe
check "-p on an open, idle pipe: starts after the wait, not hung" "$(python3 -c "print($t1 - $t0 < 20)")" True
check "-p on an open, idle pipe: pi gets a closed stdin" "$(cat "${d}/record")" "stdin="
check "-p on an open, idle pipe: says so on stderr" "$(grep -c 'stdin is an open pipe' "${d}/err")" 1

open_pipe
t0=$(secs); bash "${lc}" --mode json -p hi < "${d}/fifo" > "${d}/out" 2> "${d}/err" || true; t1=$(secs)
done_pipe
check "--mode json on an open, idle pipe: not hung" "$(python3 -c "print($t1 - $t0 < 20)"; cat "${d}/record")" "True
stdin="
check "--mode json: stdout is pi's alone (no banner)" "$(cat "${d}/out")" "PI-OUT"

echo "piped text" | bash "${lc}" -p hi > "${d}/out" 2> "${d}/err"
check "piped input still reaches pi" "$(cat "${d}/record")" "stdin=piped text"
check "piped input: no note" "$(grep -c 'stdin is an open pipe' "${d}/err" || true)" 0

bash "${lc}" -p hi < /dev/null > "${d}/out" 2> "${d}/err"
check "</dev/null: no wait, no note" "$(grep -c 'stdin is an open pipe' "${d}/err" || true)" 0

open_pipe
bash "${lc}" --mode rpc < "${d}/fifo" > "${d}/out" 2> "${d}/err" || true
done_pipe
check "--mode rpc keeps its stdin (no note)" "$(cat "${d}/record"; grep -c 'stdin is an open pipe' "${d}/err" || true)" "stdin=(rpc)
0"
exit "${fail}"
