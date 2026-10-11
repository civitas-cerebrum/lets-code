#!/usr/bin/env bash
# `lets-code update`: a copied script is replaced by the npm release (checked
# against the registry's sha512) or by main's file (--snapshot), stamped with
# its version; a symlink keeps pointing at it; a bad download, a checksum
# mismatch, a missing release and a git checkout leave everything as it was;
# an npm install is handed to npm. Runs against a fake registry and GitHub.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
src="${here}/../lets-code"
d="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-update.XXXXXX")"
srv=""
trap '[ -z "${srv}" ] || kill "${srv}" 2>/dev/null; rm -rf "${d}"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }

# what the fake servers hand out: this checkout's script, marked
mkdir -p "${d}/www/package"
sed 's/^LETS_CODE_VERSION=.*/LETS_CODE_VERSION="from-download"/' "${src}" > "${d}/www/package/lets-code"
echo "# marker: downloaded" >> "${d}/www/package/lets-code"
(cd "${d}/www" && tar -czf pkg.tgz package/lets-code)
sha="0123456789abcdef0123456789abcdef01234567"

cat > "${d}/server.py" <<'PY'
import base64, hashlib, http.server, json, os, sys
root = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        mode = open(os.path.join(root, "mode")).read().strip()
        host = "http://%s:%d" % self.server.server_address
        tgz = open(os.path.join(root, "pkg.tgz"), "rb").read()
        if self.path == "/@civitas-cerebrum%2flets-code/latest":
            if mode == "no-release": return self.send(404, b"{}")
            digest = hashlib.sha512(tgz if mode != "bad-sum" else b"other").digest()
            return self.send(200, json.dumps({"version": "9.9.9", "dist": {"tarball": host + "/pkg.tgz",
                "integrity": "sha512-" + base64.b64encode(digest).decode()}}).encode())
        if self.path == "/pkg.tgz": return self.send(200, tgz, "application/octet-stream")
        if self.path == "/repos/civitas-cerebrum/lets-code/commits/main":
            return self.send(200, json.dumps({"sha": open(os.path.join(root, "sha")).read().strip()}).encode())
        if self.path.startswith("/civitas-cerebrum/lets-code/") and self.path.endswith("/lets-code"):
            if mode == "garbage": return self.send(200, b"<html>not a script</html>", "text/html")
            return self.send(200, open(os.path.join(root, "package", "lets-code"), "rb").read(), "text/plain")
        self.send(404, b"{}")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
echo ok > "${d}/www/mode"; echo "${sha}" > "${d}/www/sha"
python3 "${d}/server.py" "${d}/www" > "${d}/port" &
srv=$!
for _ in $(seq 300); do [ -s "${d}/port" ] && break; sleep 0.1; done
[ -s "${d}/port" ] || { echo "FAIL  the fake server did not start within 30 s"; exit 1; }
url="http://127.0.0.1:$(cat "${d}/port")"
export LETS_CODE_UPDATE_REGISTRY="${url}" LETS_CODE_UPDATE_GITHUB_API="${url}" LETS_CODE_UPDATE_GITHUB_RAW="${url}"
mode() { echo "$1" > "${d}/www/mode"; }
fresh() { mkdir -p "${d}/bin"; cp "${src}" "${d}/bin/lets-code"; chmod 755 "${d}/bin/lets-code"; }
ver() { bash "${d}/bin/lets-code" --version; }

# release, into a copied script
fresh
check "starts as dev" "$(ver)" "lets-code dev"
bash "${d}/bin/lets-code" update > "${d}/out" 2>&1 || { cat "${d}/out"; echo "FAIL  update"; exit 1; }
check "release: replaced and stamped" "$(ver)" "lets-code 9.9.9"
check "release: downloaded file" "$(tail -n 1 "${d}/bin/lets-code")" "# marker: downloaded"
check "release: still executable" "$(test -x "${d}/bin/lets-code" && echo yes)" yes
check "release: nothing left behind" "$(ls -A "${d}/bin")" "lets-code"
check "release: second run is a no-op" "$(bash "${d}/bin/lets-code" update 2>&1 | grep -c 'already up to date')" 1

# snapshot, through a symlink
fresh; ln -s "${d}/bin/lets-code" "${d}/link"
bash "${d}/link" update --snapshot > "${d}/out" 2>&1 || { cat "${d}/out"; echo "FAIL  update --snapshot"; exit 1; }
check "snapshot: stamped with the commit" "$(ver)" "lets-code main-0123456"
check "snapshot: symlink kept" "$(test -L "${d}/link" && echo yes)" yes
check "snapshot: second run is a no-op" "$(bash "${d}/link" update --snapshot 2>&1 | grep -c 'already up to date')" 1
echo "fedcba9876543210fedcba9876543210fedcba98" > "${d}/www/sha"
bash "${d}/link" update --snapshot > /dev/null 2>&1
check "snapshot: a new commit updates" "$(ver)" "lets-code main-fedcba9"

# refusals leave the script alone
for m in bad-sum garbage no-release; do
    fresh; mode "${m}"
    case "${m}" in garbage) args="--snapshot" ;; *) args="" ;; esac
    bash "${d}/bin/lets-code" update ${args} > "${d}/out" 2>&1 && r=ran || r=refused
    check "${m}: refused" "${r}" refused
    check "${m}: script unchanged" "$(cmp -s "${src}" "${d}/bin/lets-code" && echo same)" same
done
check "no release: points at --snapshot" "$(grep -c -- '--snapshot' "${d}/out")" 1
mode ok

# a git checkout is left to git
mkdir -p "${d}/repo/.git"; cp "${src}" "${d}/repo/lets-code"; echo '{}' > "${d}/repo/package.json"
check "checkout: refused" "$(bash "${d}/repo/lets-code" update > /dev/null 2>&1 && echo ran || echo refused)" refused

# an npm install is handed to npm
mkdir -p "${d}/npm/lib/node_modules/@civitas-cerebrum/lets-code" "${d}/fakebin"
cp "${src}" "${d}/npm/lib/node_modules/@civitas-cerebrum/lets-code/lets-code"
printf '#!/bin/sh\necho "$*" > "%s/npm-args"\n' "${d}" > "${d}/fakebin/npm"; chmod +x "${d}/fakebin/npm"
PATH="${d}/fakebin:${PATH}" bash "${d}/npm/lib/node_modules/@civitas-cerebrum/lets-code/lets-code" update > /dev/null 2>&1
check "npm: release" "$(cat "${d}/npm-args")" "install -g @civitas-cerebrum/lets-code@latest"
PATH="${d}/fakebin:${PATH}" bash "${d}/npm/lib/node_modules/@civitas-cerebrum/lets-code/lets-code" update --snapshot > /dev/null 2>&1
check "npm: snapshot" "$(cat "${d}/npm-args")" "install -g github:civitas-cerebrum/lets-code"

check "unknown option refused" "$(bash "${src}" update --nope > /dev/null 2>&1 && echo ran || echo refused)" refused
exit "${fail}"
