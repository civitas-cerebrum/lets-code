#!/usr/bin/env bash
# Unit test for probe_template_effort: extracts the function from ./lets-code
# and runs it against a fake /tokenize server in four template behaviours.
set -eu
eval "$(sed -n '/^probe_template_effort() {/,/^}/p' "$(dirname "$0")/../lets-code")"
log_verbose() { :; }
PORT=$((20000 + RANDOM % 20000))
cat > /tmp/fake-tokenize.$$.py <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE = {"m": "qwen"}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        if self.path == "/mode":
            MODE["m"] = self.rfile.read(int(self.headers["Content-Length"])).decode(); return self.reply(200, {})
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        m = MODE["m"]
        if m == "none" or self.path != "/tokenize": return self.reply(404, {"detail": "Not Found"})
        eff = body["chat_template_kwargs"].get("reasoning_effort")
        if m == "qwen":   # low|medium|xhigh, default xhigh, "high" rendered as xhigh
            ok = {None: "xhigh", "low": "low", "medium": "medium", "high": "xhigh", "xhigh": "xhigh"}
            if eff not in ok: return self.reply(400, {"error": "Unexpected reasoning effort"})
            return self.reply(200, {"tokens": [len(ok[eff]), 7]})
        if m == "ignores": return self.reply(200, {"tokens": [1, 2, 3]})
        if m == "all":      # every value accepted and distinct, default medium
            return self.reply(200, {"tokens": [hash(eff or "medium") % 997]})
    def reply(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 /tmp/fake-tokenize.$$.py "$PORT" & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f /tmp/fake-tokenize.$$.py' EXIT
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
fail=0
check() {  # check <mode> <want-map> <want-note-substring>
    curl -s -X POST -d "$1" "http://127.0.0.1:$PORT/mode" >/dev/null
    TOKEN=t CA_FOUND="" probe_template_effort "http://127.0.0.1:$PORT" m
    if [ "${EFFORT_MAP}" = "$2" ] && case "${EFFORT_NOTE}" in *"$3"*) true ;; *) false ;; esac; then
        echo "ok    $1: ${EFFORT_MAP:-<none>} | ${EFFORT_NOTE}"
    else echo "FAIL  $1: map=${EFFORT_MAP} note=${EFFORT_NOTE} (want $2 / *$3*)"; fail=1; fi
}
check qwen    '{"minimal": "low", "low": "low", "medium": "medium", "high": "high"}' "default high|xhigh"
check ignores ''                                                                   "no effort control"
check none    ''                                                                   "no /tokenize"
check all     '{"minimal": "minimal", "low": "low", "medium": "medium", "high": "high"}' "accepts minimal|low|medium|high|xhigh|max"
TOKEN=t CA_FOUND="" probe_template_effort "http://127.0.0.1:1" m
if [ -z "${EFFORT_MAP}" ]; then echo "ok    unreachable: ${EFFORT_NOTE}"; else echo "FAIL  unreachable: ${EFFORT_MAP}"; fail=1; fi
exit "${fail}"
