#!/usr/bin/env bash
# The pastel themes lets-code writes into ~/.pi/agent/themes: each is valid
# JSON, named after its file, defines every color role of pi's dark theme
# (when pi is installed), and an unchanged theme is not rewritten.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
agent="$(mktemp -d "${TMPDIR:-/tmp}/lets-code-themes.XXXXXX")"
trap 'rm -rf "${agent}"' EXIT
python3 - "${here}/../lets-code" > "${agent}/writer.sh" <<'PYX'
import sys
s = open(sys.argv[1]).read()
i = s.find("\npi_write_themes() {")
k = s.find("\n}\n", s.rfind("\nJSON\n", i, s.find("\n}\n\n", i) + 4))
sys.stdout.write(s[i:k + 3])
PYX
PI_AGENT_DIR="${agent}"
. "${agent}/writer.sh"
pi_write_themes

dark=""
if command -v pi >/dev/null 2>&1; then
    # pi resolves to .../pi-coding-agent/dist/bundle/cli.js; its themes sit in dist/
    d="$(dirname "$(readlink -f "$(command -v pi)")")"
    for up in . .. ../..; do
        if [ -f "${d}/${up}/modes/interactive/theme/dark.json" ]; then dark="${d}/${up}/modes/interactive/theme/dark.json"; break; fi
    done
fi
python3 - "${agent}/themes" "${dark}" <<'PY'
import json, os, sys
d, dark = sys.argv[1], sys.argv[2]
names = sorted(os.listdir(d))
assert names == ["lets-code-chalk.json", "lets-code-pastel.json", "lets-code-soft.json"], names
want = set(json.load(open(dark))["colors"]) if dark else None
for n in names:
    t = json.load(open(os.path.join(d, n)))
    assert t["name"] + ".json" == n, n
    assert t["appearance"] == "dark", n
    if want is not None:
        assert set(t["colors"]) == want, (n, want ^ set(t["colors"]))
print("themes ok" + ("" if want is not None else " (pi not installed: role check skipped)"))
PY

before="$(stat -c %Y "${agent}/themes/lets-code-pastel.json" 2>/dev/null || stat -f %m "${agent}/themes/lets-code-pastel.json")"
touch -d '2001-01-01' "${agent}/themes/lets-code-pastel.json" 2>/dev/null || touch -t 200101010000 "${agent}/themes/lets-code-pastel.json"
pi_write_themes
after="$(stat -c %Y "${agent}/themes/lets-code-pastel.json" 2>/dev/null || stat -f %m "${agent}/themes/lets-code-pastel.json")"
[ "${after}" != "${before}" ] || { echo "unchanged theme was rewritten"; exit 1; }
[ -z "$(ls -A "${agent}/themes" | grep '^\.')" ] || { echo "temp files left behind"; exit 1; }
