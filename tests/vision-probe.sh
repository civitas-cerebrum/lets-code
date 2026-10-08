#!/usr/bin/env bash
# Unit test for probe_vision: extracts the function from ./lets-code and runs
# it against a throwaway HTTP server that answers like the servers we know
# (vLLM text-only 400, Ollama dropping the image, a real vision model, ...).
set -eu
eval "$(sed -n '/^tls_args_for() {/,/^}$/p; /^probe_vision() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
command -v python3 >/dev/null || { echo "python3 needed"; exit 1; }

srv="${TMPDIR:-/tmp}/.vision-probe-test.$$"
mkdir -p "${srv}"
cat > "${srv}/server.py" <<'PY'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
mode_file = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); req = json.loads(self.rfile.read(n))
        with open(os.path.join(mode_file, "mode")) as f: mode = f.read().strip()
        with open(os.path.join(mode_file, "last.json"), "w") as f: json.dump(req, f)
        def reply(code, body):
            data = json.dumps(body).encode(); self.send_response(code)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        def chat(content, reasoning=None):
            m = {"role": "assistant", "content": content}
            if reasoning is not None: m["reasoning_content"] = reasoning
            return {"choices": [{"message": m, "finish_reason": "stop"}], "usage": {"completion_tokens": 3}}
        if mode == "vision":          reply(200, chat("Red."))
        elif mode == "vision-thinks": reply(200, chat("", "The user shows a red square so the answer is red"))
        elif mode == "vllm-text":     reply(400, {"error": {"message": "Model does not support image input", "type": "BadRequestError"}})
        elif mode == "llamacpp-text": reply(500, {"error": {"code": 500, "message": "image input is not supported - hint: if this is a multimodal model, use the mmproj option", "type": "server_error"}})
        elif mode == "ollama-text":   reply(200, chat("I'm sorry, but I can't see images. Could you describe it?"))
        elif mode == "vague":         reply(200, chat("Blue."))
        elif mode == "bad-token":     reply(401, {"error": {"message": "Unauthorized"}})
        elif mode == "garbage":
            self.send_response(200); self.end_headers(); self.wfile.write(b"not json")
        else: reply(503, {})
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
port=$(( 20000 + RANDOM % 20000 ))
python3 "${srv}/server.py" "${port}" "${srv}" & spid=$!
trap 'kill ${spid} 2>/dev/null; rm -rf "${srv}"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "http://127.0.0.1:${port}/" 2>/dev/null && break; sleep 0.2; done

TOKEN="t"
fail=0
check() {  # check <mode> <want>
    echo "$1" > "${srv}/mode"
    VISION_DETECTED=""
    probe_vision "http://127.0.0.1:${port}" "m"
    if [ "${VISION_DETECTED}" = "$2" ]; then echo "ok    $1 -> ${VISION_DETECTED}"; else echo "FAIL  $1 -> ${VISION_DETECTED} (want $2)"; fail=1; fi
}
check vision        true
check vision-thinks true
check vllm-text     false
check llamacpp-text false
check ollama-text   false
check vague         unknown
check bad-token     unknown
check garbage       unknown
check down          unknown

# the request itself: a chat completion with a data-URL PNG image part and thinking off
python3 - "${srv}/last.json" <<'PY' || fail=1
import json, sys, base64
req = json.load(open(sys.argv[1]))
parts = req["messages"][0]["content"]
img = [p for p in parts if p["type"] == "image_url"][0]["image_url"]["url"]
assert img.startswith("data:image/png;base64,"), img[:40]
png = base64.b64decode(img.split(",", 1)[1])
assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 2048, len(png)
assert req["chat_template_kwargs"] == {"enable_thinking": False}
assert req["model"] == "m" and req["max_tokens"] <= 256
print("ok    request shape (png data url, thinking off)")
PY

# unreachable server -> unknown, and quickly
VISION_DETECTED=""; probe_vision "http://127.0.0.1:1" "m"
if [ "${VISION_DETECTED}" = unknown ]; then echo "ok    unreachable -> unknown"; else echo "FAIL  unreachable -> ${VISION_DETECTED}"; fail=1; fi
exit "${fail}"
