#!/usr/bin/env bash
# Unit test for ensure_pi_tools: extracts the function from ./lets-code and
# runs it against a fake pi package whose tools-manager "downloads" by
# touching files, with PATH stripped of fd/fdfind/rg.
set -eu
eval "$(sed -n '/^ensure_pi_tools() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
command -v node >/dev/null || { echo "node needed"; exit 1; }
LOG_PREFIX="[lets-code]"; log() { echo "${LOG_PREFIX} ${1}"; }

work="$(mktemp -d "${TMPDIR:-/tmp}/pi-tools-test.XXXXXX")"
trap 'rm -rf "${work}"' EXIT
pkg="${work}/node_modules/pi-pkg"
mkdir -p "${pkg}/dist/bundle" "${pkg}/dist/utils" "${work}/path" "${work}/agent"
printf '#!/bin/sh\necho fake-pi\n' > "${pkg}/dist/bundle/cli.js"; chmod +x "${pkg}/dist/bundle/cli.js"
ln -s "${pkg}/dist/bundle/cli.js" "${work}/path/pi"        # pi on PATH is a symlink, like npm's
cat > "${pkg}/dist/utils/tools-manager.js" <<'JS'
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
export async function ensureTool(tool, onStatus) {
    const bin = join(process.env.PI_CODING_AGENT_DIR, "bin");
    if (process.env.FAKE_FAIL === tool) { onStatus?.({ type: "warning", message: `Failed to download ${tool}: boom` }); return undefined; }
    onStatus?.({ type: "info", message: `${tool} not found. Downloading...` });
    mkdirSync(bin, { recursive: true });
    const p = join(bin, tool); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755);
    return p;
}
JS
# a minimal PATH: node, the fake pi and the commands this test itself needs —
# never fd/fdfind/rg, whatever the machine has installed
for c in node grep rm tail sed chmod ln mkdir cat; do ln -s "$(command -v "${c}")" "${work}/path/${c}"; done
export PATH="${work}/path"
PI_AGENT_DIR="${work}/agent"

fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> $2 (want $3)"; fail=1; fi; }

out="$(ensure_pi_tools 2>&1)"
t "fetches both when missing"      "$(echo "${out}" | grep -c 'fetching.*(fd rg)')" 1
t "fd created in agent bin"        "$([ -x "${PI_AGENT_DIR}/bin/fd" ] && echo yes)" yes
t "rg created in agent bin"        "$([ -x "${PI_AGENT_DIR}/bin/rg" ] && echo yes)" yes
t "reports each path"              "$(echo "${out}" | grep -c '^\[lets-code\] \(fd\|ripgrep\): ')" 2

out="$(ensure_pi_tools 2>&1)"
t "silent once present"            "${out}" ""

rm -f "${PI_AGENT_DIR}/bin/rg"
printf '#!/bin/sh\n' > "${work}/path/fdfind"; chmod +x "${work}/path/fdfind"; rm -f "${PI_AGENT_DIR}/bin/fd"
out="$(ensure_pi_tools 2>&1)"
t "fdfind on PATH counts as fd"    "$(echo "${out}" | grep -c 'helpers (rg)')" 1
t "fd not re-fetched"              "$([ -e "${PI_AGENT_DIR}/bin/fd" ] && echo yes || echo no)" no
rm -f "${work}/path/fdfind"

rm -rf "${PI_AGENT_DIR}/bin"
out="$(PI_OFFLINE=1 ensure_pi_tools 2>&1)"
t "PI_OFFLINE skips"               "${out}" ""
t "nothing fetched offline"        "$([ -e "${PI_AGENT_DIR}/bin" ] && echo yes || echo no)" no

out="$(FAKE_FAIL=rg ensure_pi_tools 2>&1; echo "rc=$?")"
t "download failure is not fatal"  "$(echo "${out}" | tail -1)" "rc=0"
t "failure is reported"            "$(echo "${out}" | grep -c 'Failed to download rg')" 1
t "retry hint printed"             "$(echo "${out}" | grep -c 'could not fetch')" 1

rm -rf "${PI_AGENT_DIR}/bin" "${pkg}/dist/utils/tools-manager.js"
out="$(ensure_pi_tools 2>&1; echo "rc=$?")"
t "unknown pi layout: note, rc 0"  "$(echo "${out}" | grep -c 'pi will download')|$(echo "${out}" | tail -1)" "1|rc=0"
exit "${fail}"
