#!/usr/bin/env bash
# Test for the shell side of the Claude backend: whole launches of ./lets-code
# in a scratch HOME, with a fake `pi` (records its arguments and exits) and a
# fake `claude` on PATH. Checks what each way of choosing Claude launches
# (--claude, a saved claude preset, BACKEND=claude, Claude saved as pi's
# default), what lands in pi's models.json, and the claude module's files.
# No model, no network.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
lc="${here}/../lets-code"
work="$(mktemp -d)"; trap 'kill "${srv:-}" 2>/dev/null; rm -rf "${work}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1 -> $2"; else echo "FAIL  $1 -> '$2' (want '$3')"; fail=1; fi; }

mkdir -p "${work}/bin" "${work}/proj"
cat > "${work}/bin/pi" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = --version ] && { echo 1.0.0; exit 0; }
{ printf '%s\n' "$*"; printf 'claude-provider=%s\n' "${LETS_CODE_CLAUDE_PROVIDER:-}"; printf 'claude-url=%s token=%s\n' "${LETS_CODE_CLAUDE_URL:-}" "${LETS_CODE_CLAUDE_TOKEN:-}"; } > "${LC_TEST_OUT}"
EOF
cat > "${work}/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo '{"loggedIn": true}'
EOF
chmod +x "${work}/bin/pi" "${work}/bin/claude"
# a PATH without claude: the fake pi, python3 and curl only
noclaude="${work}/noclaude"; mkdir -p "${noclaude}"; cp "${work}/bin/pi" "${noclaude}/pi"
ln -s "$(command -v python3)" "${noclaude}/python3"; ln -s "$(command -v curl)" "${noclaude}/curl"

# launch <home> [lets-code args...]: one launch, output in <home>/out, status in <home>/rc
launch() {
    local h="$1"; shift
    mkdir -p "${h}"
    ( cd "${work}/proj" && HOME="${h}" PATH="${LC_PATH:-${work}/bin:${PATH}}" LC_TEST_OUT="${h}/pi-args" PI_OFFLINE=1 \
        LETS_CODE_MEM_GUARD=false LETS_CODE_GIT_GUARD=false LETS_CODE_SUBAGENTS=false NO_COLOR=1 \
        bash "${lc}" "$@" -p hi > "${h}/out" 2>&1 < /dev/null; echo $? > "${h}/rc" )
}
args() { head -n 1 "$1/pi-args" 2>/dev/null; }
models() { python3 -c 'import json, sys
d = json.load(open(sys.argv[1] + "/.pi/agent/models.json"))["providers"].get(sys.argv[2]) or {}
print(" ".join(m["id"] for m in d.get("models", [])))' "$1" "$2" 2>/dev/null; }

# --claude, nothing configured
h="${work}/h1"; launch "${h}" --claude
t "--claude: exit status" "$(cat "${h}/rc")" 0
t "--claude: pi gets the Claude provider and Haiku" "$(args "${h}")" "--provider lets-code-claude --model claude-haiku -p hi"
t "--claude: models in /model" "$(models "${h}" lets-code-claude)" "claude-haiku claude-sonnet claude-opus claude-fable"
t "--claude: the module is on" "$(sed -n 2p "${h}/pi-args")" "claude-provider=lets-code-claude"
t "--claude: module files" "$(cd "${h}/.pi/agent/extensions/lets-code/claude" 2>/dev/null && ls | tr '\n' ' ')" "bridge.mjs index.ts server.mjs "
t "--claude: Claude Code's thinking levels" "$(python3 -c 'import json, sys
m = json.load(open(sys.argv[1]))["providers"]["lets-code-claude"]["models"][0]
print(json.dumps(m["thinkingLevelMap"], sort_keys=True), m["reasoning"], m["contextWindow"], m["maxTokens"])' "${h}/.pi/agent/models.json")" \
    '{"high": "high", "low": "low", "max": "max", "medium": "medium", "minimal": null, "off": "none", "xhigh": "xhigh"} True 200000 32000'
t "--claude: proxy endpoint" "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["providers"]["lets-code-claude"]["baseUrl"])' "${h}/.pi/agent/models.json")" "http://127.0.0.1:8795/v1"
t "--claude: banner" "$(grep -o 'claude-haiku @ Claude Code  (preset claude)' "${h}/out")" "claude-haiku @ Claude Code  (preset claude)"

# --claude --model, and a saved claude preset adding a model
h="${work}/h2"; launch "${h}" --claude --model claude-opus
t "--claude --model claude-opus" "$(args "${h}")" "--provider lets-code-claude --model claude-opus -p hi"
h="${work}/h3"; mkdir -p "${h}/.config/lets-code/presets"; echo 'MODEL="claude-sonnet"' > "${h}/.config/lets-code/presets/claude"
launch "${h}" --claude
t "saved claude preset: its model" "$(args "${h}")" "--provider lets-code-claude --model claude-sonnet -p hi"

# BACKEND=claude in the config (setup's second choice), with CLAUDE_MODELS
h="${work}/h4"; mkdir -p "${h}/.config/lets-code"
printf 'BACKEND="claude"\nCLAUDE_MODELS="haiku claude-opus-5-5"\nENDPOINTS=""\n' > "${h}/.config/lets-code/config"
launch "${h}"
t "BACKEND=claude: launches Claude" "$(args "${h}")" "--provider lets-code-claude --model claude-haiku -p hi"
t "CLAUDE_MODELS: aliases and full names" "$(models "${h}" lets-code-claude)" "claude-haiku claude-opus-5-5"

# Claude saved as pi's default (Ctrl+S in /model) beats a configured server,
# which is never probed (nothing listens on it)
h="${work}/h5"; mkdir -p "${h}/.config/lets-code" "${h}/.pi/agent"
printf 'ENDPOINTS="http://127.0.0.1:9"\n' > "${h}/.config/lets-code/config"
printf '{"defaultProvider": "lets-code-claude", "defaultModel": "claude-fable"}\n' > "${h}/.pi/agent/settings.json"
launch "${h}"
t "pi default on Claude: launches it" "$(args "${h}")" "--provider lets-code-claude --model claude-fable -p hi"
launch "${h}" --model claude-sonnet
t "pi default on Claude, --model wins" "$(args "${h}")" "--provider lets-code-claude --model claude-sonnet -p hi"
launch "${h}" --url http://127.0.0.1:9
t "pi default on Claude, --url picks the server" "$(grep -c 'not reachable' "${h}/out")" 1

# a server launch registers the Claude models too (Claude Code installed)
cat > "${work}/srv.py" <<'EOF'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"data": [{"id": "srv-model", "max_model_len": 65536}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H); print(s.server_port, flush=True); s.serve_forever()
EOF
python3 "${work}/srv.py" > "${work}/port" & srv=$!
for _ in $(seq 50); do [ -s "${work}/port" ] && break; sleep 0.1; done
h="${work}/h6"; mkdir -p "${h}/.config/lets-code"
printf 'ENDPOINTS="http://127.0.0.1:%s"\nREASONING="false"\nVISION="false"\n' "$(cat "${work}/port")" > "${h}/.config/lets-code/config"
launch "${h}"
t "server launch: pi gets the server" "$(args "${h}")" "--provider lets-code --model srv-model -p hi"
t "server launch: Claude models in /model too" "$(models "${h}" lets-code-claude)" "claude-haiku claude-sonnet claude-opus claude-fable"
t "server launch: the module is on" "$(sed -n 2p "${h}/pi-args")" "claude-provider=lets-code-claude"
h="${work}/h7"; mkdir -p "${h}/.config/lets-code"; cp "${work}/h6/.config/lets-code/config" "${h}/.config/lets-code/config"
LC_PATH="${noclaude}:/usr/bin:/bin" launch "${h}"
t "server launch without Claude Code: no Claude models" "$(models "${h}" lets-code-claude)|$(sed -n 2p "${h}/pi-args")" "|claude-provider="

# --claude without Claude Code
LC_PATH="${noclaude}:/usr/bin:/bin" launch "${work}/h8" --claude
t "--claude without Claude Code: refused" "$(cat "${work}/h8/rc")|$(grep -c 'needs Claude Code' "${work}/h8/out")" "1|1"

# CLAUDE_URL: another machine's proxy (a stand-in that wants this Claude
# Code token), from a machine without Claude Code
tok="sk-ant-oat01-testtokentesttokentesttoken"
cat > "${work}/remote.py" <<'EOF'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.headers.get("Authorization") == "Bearer sk-ant-oat01-testtokentesttokentesttoken"
        self.send_response(200 if ok else 401); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"ok":true}' if ok else b'{"error":{"message":"bad key"}}')
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H); print(s.server_port, flush=True); s.serve_forever()
EOF
python3 "${work}/remote.py" > "${work}/rport" & rsrv=$!
for _ in $(seq 50); do [ -s "${work}/rport" ] && break; sleep 0.1; done
rurl="http://127.0.0.1:$(cat "${work}/rport")"
h="${work}/h9"; mkdir -p "${h}/.config/lets-code"
# the address without its scheme, as typed in setup: http:// added for an IP
printf 'BACKEND="claude"\nCLAUDE_URL="%s/"\nCLAUDE_TOKEN="%s"\n' "${rurl#http://}" "${tok}" > "${h}/.config/lets-code/config"
LC_PATH="${noclaude}:/usr/bin:/bin" launch "${h}"
t "CLAUDE_URL: launches Claude without Claude Code here" "$(cat "${h}/rc")|$(args "${h}")" "0|--provider lets-code-claude --model claude-haiku -p hi"
t "CLAUDE_URL: provider points there, key from the environment" "$(python3 -c 'import json, sys; p = json.load(open(sys.argv[1]))["providers"]["lets-code-claude"]; print(p["baseUrl"], p["apiKey"])' "${h}/.pi/agent/models.json")" "${rurl}/v1 \$LETS_CODE_CLAUDE_TOKEN"
t "CLAUDE_URL: the module gets URL and token" "$(sed -n 3p "${h}/pi-args")" "claude-url=${rurl} token=${tok}"
t "CLAUDE_URL: banner" "$(grep -o "claude-haiku @ Claude Code via 127.0.0.1:[0-9]*" "${h}/out" | sed 's/:[0-9]*$//')" "claude-haiku @ Claude Code via 127.0.0.1"
printf 'BACKEND="claude"\nCLAUDE_URL="%s"\nCLAUDE_TOKEN="sk-ant-oat01-notthetokenitwantsatall"\n' "${rurl}" > "${h}/.config/lets-code/config"
LC_PATH="${noclaude}:/usr/bin:/bin" launch "${h}"
t "CLAUDE_URL, wrong token: refused, pointing at claude setup-token" "$(cat "${h}/rc")|$(grep -c "run 'claude setup-token'" "${h}/out")" "1|1"
kill "${rsrv}" 2>/dev/null
printf 'BACKEND="claude"\nCLAUDE_URL="%s"\nCLAUDE_TOKEN="%s"\n' "${rurl}" "${tok}" > "${h}/.config/lets-code/config"
LC_PATH="${noclaude}:/usr/bin:/bin" launch "${h}"
t "CLAUDE_URL, nothing there: refused" "$(cat "${h}/rc")|$(grep -c 'not reachable' "${h}/out")" "1|1"

# CLAUDE_TOKEN on the local proxy: sent with every request; one that is not
# a Claude Code token is refused at launch
h="${work}/h11"; mkdir -p "${h}/.config/lets-code"
printf 'BACKEND="claude"\nCLAUDE_TOKEN="%s"\n' "${tok}" > "${h}/.config/lets-code/config"
launch "${h}"
t "local + CLAUDE_TOKEN: the token goes with each request" "$(python3 -c 'import json, sys; p = json.load(open(sys.argv[1]))["providers"]["lets-code-claude"]; print(p["baseUrl"], p["apiKey"])' "${h}/.pi/agent/models.json")|$(sed -n 3p "${h}/pi-args")" "http://127.0.0.1:8795/v1 \$LETS_CODE_CLAUDE_TOKEN|claude-url= token=${tok}"
printf 'BACKEND="claude"\nCLAUDE_TOKEN="sk-ant-api03-xyz"\n' > "${h}/.config/lets-code/config"
launch "${h}"
t "CLAUDE_TOKEN that is not a Claude Code token: refused" "$(cat "${h}/rc")|$(grep -c 'not a Claude Code token' "${h}/out")" "1|1"

# lets-code claude-remote: proxy started, what to set printed; requests
# through a reverse proxy need a Claude Code token
h="${work}/h10"; mkdir -p "${h}"
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
( cd "${work}/proj" && HOME="${h}" PATH="${work}/bin:${PATH}" LETS_CODE_CLAUDE_PORT="${port}" bash "${lc}" claude-remote > "${h}/out" 2>&1 < /dev/null; echo $? > "${h}/rc" )
t "claude-remote: exit status" "$(cat "${h}/rc")" 0
t "claude-remote: says how to get the token" "$(grep -c "claude setup-token" "${h}/out")|$(grep -c 'CLAUDE_URL=' "${h}/out")" "1|1"
via() { curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 10.6.0.2" ${1:+-H "Authorization: Bearer $1"} "http://127.0.0.1:${port}/health"; }
t "claude-remote: proxy up; a reverse-proxied request needs a token" "$(via "${tok}")|$(via)|$(via nope)" "200|401|401"
kill "$(curl -s "http://127.0.0.1:${port}/health" | python3 -c 'import json, sys; print(json.load(sys.stdin)["pid"])')" 2>/dev/null

exit "${fail}"
