#!/usr/bin/env bash
# End to end: `lets-code setup preset` onboards a second backend under a name,
# `lets-code --<name>` launches pi against it as its own provider, a launch
# without it still uses the main config, and bad names are refused. Runs
# against a fake /v1/models server and a fake pi that records its call.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
lc="${here}/../lets-code"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-presets.XXXXXX")"
srv=""
trap '[ -z "${srv}" ] || kill "${srv}" 2>/dev/null; rm -rf "${d}"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }

# a server with one vLLM-style model and one gateway-style model; no chat
# endpoint, so the thinking and vision probes are inconclusive
cat > "${d}/server.py" <<'PY'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/v1/models":
            self.send_error(404); return
        body = json.dumps({"data": [{"id": "served-a", "max_model_len": 65536},
                                    {"id": "vendor/big", "context_length": 200000}]}).encode()
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
# (a slow CI runner can take seconds to start python)
for _ in $(seq 300); do [ -s "${d}/port" ] && break; sleep 0.1; done
[ -s "${d}/port" ] || { echo "FAIL  the fake server did not start within 30 s"; exit 1; }
url="http://127.0.0.1:$(cat "${d}/port")"

# a pi that records its arguments and the environment lets-code hands it
mkdir -p "${d}/bin"
cat > "${d}/bin/pi" <<'SH'
#!/bin/sh
if [ "${1:-}" = "--help" ]; then echo "  --print, -p   Non-interactive mode"; exit 0; fi
{ echo "args=$*"; echo "token=${LETS_CODE_TOKEN}"; echo "provider=${LETS_CODE_PROVIDER}"; } > "${PI_RECORD}"
SH
chmod +x "${d}/bin/pi"

export PATH="${d}/bin:${PATH}" XDG_CONFIG_HOME="${d}/config" PI_CODING_AGENT_DIR="${d}/agent" PI_OFFLINE=1 PI_RECORD="${d}/record"
mkdir -p "${d}/config/lets-code"
cat > "${d}/config/lets-code/config" <<EOF
ENDPOINTS="${url}"
TOKEN="main-token"
REASONING="false"
VISION="false"
MEM_GUARD="false"
GIT_GUARD="false"
EOF
cd "${d}"

# onboarding: name, endpoints, token, model, probe now, image question
printf 'qwen\n%s\npreset-token\nvendor/big\n\nn\n' "${url}" | bash "${lc}" setup preset > "${d}/setup.log" 2>&1 \
    || { cat "${d}/setup.log"; echo "FAIL  setup preset exited non-zero"; exit 1; }
p="${d}/config/lets-code/presets/qwen"
check "preset file written" "$(test -f "${p}" && echo yes)" yes
check "preset file mode 600" "$(stat -c %a "${p}" 2>/dev/null || stat -f %Lp "${p}")" 600
check "preset model" "$(. "${p}"; echo "${MODEL}")" vendor/big
check "preset token" "$(. "${p}"; echo "${TOKEN}")" preset-token
check "preset vision pinned from the answer" "$(. "${p}"; echo "${VISION}")" false
check "setup used the pinned model's context" "$(grep -c 'context: 200000' "${d}/setup.log")" 1

# the name given on the command line, refused names
check "name on the command line" "$(printf '%s\nt\n\nn\n' "${url}" | bash "${lc}" setup --preset other >/dev/null 2>&1; test -f "${d}/config/lets-code/presets/other" && echo yes)" yes
check "lets-code option refused as a name" "$(echo | bash "${lc}" setup preset vision >/dev/null 2>&1 && echo ran || echo refused)" refused
check "pi option refused as a name" "$(echo | bash "${lc}" setup preset print >/dev/null 2>&1 && echo ran || echo refused)" refused
check "bad characters refused" "$(echo | bash "${lc}" setup preset ../x >/dev/null 2>&1 && echo ran || echo refused)" refused

# launch with the preset
bash "${lc}" --qwen -p hi > "${d}/launch.log" 2>&1 || { cat "${d}/launch.log"; echo "FAIL  launch --qwen"; exit 1; }
check "--qwen: pi gets the preset provider and model" "$(sed -n 's/^args=//p' "${d}/record")" "--provider lets-code-qwen --model vendor/big -p hi"
check "--qwen: preset token" "$(sed -n 's/^token=//p' "${d}/record")" preset-token
check "--qwen: provider exported for subagents" "$(sed -n 's/^provider=//p' "${d}/record")" lets-code-qwen
m="${d}/agent/models.json"
check "--qwen: registered with its own context" "$(python3 -c "import json;print(json.load(open('$m'))['providers']['lets-code-qwen']['models'][0]['contextWindow'])")" 200000
check "--preset <name> works too" "$(bash "${lc}" --preset qwen -p hi >/dev/null 2>&1; sed -n 's/^provider=//p' "${d}/record")" lets-code-qwen

# launch without a preset: the main config, untouched by the preset
bash "${lc}" -p hi > "${d}/launch.log" 2>&1 || { cat "${d}/launch.log"; echo "FAIL  plain launch"; exit 1; }
check "plain: main provider and first model" "$(sed -n 's/^args=//p' "${d}/record")" "--provider lets-code --model served-a -p hi"
check "plain: main token" "$(sed -n 's/^token=//p' "${d}/record")" main-token
check "both providers kept in models.json" "$(python3 -c "import json;print(sorted(json.load(open('$m'))['providers']))")" "['lets-code', 'lets-code-qwen']"

# errors and listing
check "unknown --preset name fails" "$(bash "${lc}" --preset nope -p hi >/dev/null 2>&1 && echo ran || echo failed)" failed
check "two presets in one launch fail" "$(bash "${lc}" --qwen --other -p hi >/dev/null 2>&1 && echo ran || echo failed)" failed
check "after -- a preset name is passed to pi" "$(bash "${lc}" -p hi -- --qwen >/dev/null 2>&1; sed -n 's/^args=//p' "${d}/record")" "--provider lets-code --model served-a -p hi -- --qwen"
check "presets lists both" "$(bash "${lc}" presets | grep -c -- '--qwen\|--other')" 2
check "presets never prints a token" "$(bash "${lc}" presets | grep -c 'preset-token')" 0
exit "${fail}"
