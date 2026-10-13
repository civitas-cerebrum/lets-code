#!/usr/bin/env bash
# Test for the move into the one lets-code extension: lc_migrate_extensions()
# and lc_ext_module() from ./lets-code, on a scratch agent dir laid out the
# way earlier versions left it (one directory per feature, older
# lets-code-*.ts files, a sandbox with its npm runtime) next to the user's
# own extensions. No model, no pi.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(sed -n '/^# -* extension dirs$/,/^# -* themes$/p' "${here}/../lets-code")"
LOG_PREFIX="[lets-code]"; NOTES=""
log() { NOTES="${NOTES}$1
"; }

work="$(mktemp -d)"; trap 'rm -rf "${work}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 -> '$2' (want '$3')"; fail=1; fi; }
ours() { mkdir -p "$(dirname "$1")"; printf '// Written by lets-code (%s); regenerated on launch, edits are overwritten.\nexport default function () {}\n' "$2" > "$1"; }
fresh() { PI_AGENT_DIR="$1"; LC_EXT_ROOT=""; LC_ACTIVE=""; NOTES=""; }

# --- the per-feature layout, plus the user's own extensions
A="${work}/a"; X="${A}/extensions"
ours "${X}/footer/index.ts" footer
ours "${X}/agent-guard/index.ts" agent-guard
ours "${X}/grounding/index.ts" grounding; echo mine > "${X}/grounding/notes.txt"
ours "${X}/sandbox/index.ts" sandbox
mkdir -p "${X}/sandbox/node_modules/@anthropic-ai/sandbox-runtime"
echo '{"version":"0.0.79"}' > "${X}/sandbox/node_modules/@anthropic-ai/sandbox-runtime/package.json"
echo '{"name":"lets-code-sandbox"}' > "${X}/sandbox/package.json"
ours "${X}/lets-code-mandate/index.ts" mandate               # where the user had a mandate/ of their own
mkdir -p "${X}/mandate"; echo 'export default function () {}' > "${X}/mandate/index.ts"
ours "${X}/lets-code-memguard.ts" memory-guard                 # older single file
echo 'export default function () {}' > "${X}/lets-code-mine.ts"  # user file with a lets-code- name
echo 'export default function () {}' > "${X}/mine.ts"
mkdir -p "${X}/subagents"; echo 'export default function () {}' > "${X}/subagents/index.ts"
footer_src="$(cat "${X}/footer/index.ts")"
sandbox_ino="$(ls -i "${X}/sandbox/node_modules/@anthropic-ai/sandbox-runtime/package.json" | awk '{print $1}')"

fresh "${A}"
lc_migrate_extensions
t "index written" "$(head -c 23 "${X}/lets-code/index.ts")" "// Written by lets-code"
t "footer module moved" "$(cat "${X}/lets-code/footer.ts")" "${footer_src}"
t "agent guard module moved" "$([ -f "${X}/lets-code/agent-guard.ts" ] && echo y)" y
t "per-feature directories gone" "$(ls -d "${X}/footer" "${X}/agent-guard" "${X}/sandbox" "${X}/lets-code-mandate" 2>/dev/null | wc -l | tr -d ' ')" 0
t "collision directory's module moved" "$(head -n 1 "${X}/lets-code/mandate.ts" | grep -c mandate)" 1
t "sandbox runtime moved, not reinstalled" "$(ls -i "${X}/lets-code/sandbox/node_modules/@anthropic-ai/sandbox-runtime/package.json" | awk '{print $1}')" "${sandbox_ino}"
t "sandbox index alongside" "$([ -f "${X}/lets-code/sandbox/index.ts" ] && echo y)" y
t "older single file removed" "$([ -e "${X}/lets-code-memguard.ts" ] || echo gone)" gone
t "a directory with the user's files stays" "$(ls -A "${X}/grounding")" notes.txt
t "  its module moved" "$([ -f "${X}/lets-code/grounding.ts" ] && echo y)" y
t "  and the launch says so" "$(printf '%s' "${NOTES}" | grep -c "grounding holds files")" 1
t "user's mandate/ untouched" "$(cat "${X}/mandate/index.ts")" "export default function () {}"
t "user's subagents/ untouched" "$(cat "${X}/subagents/index.ts")" "export default function () {}"
t "user's files untouched" "$(ls "${X}/mine.ts" "${X}/lets-code-mine.ts" | wc -l | tr -d ' ')" 2
t "no feature recorded as on by the move" "${LC_ACTIVE}" ""

before="$(cd "${X}" && find . | sort)"
fresh "${A}"; lc_migrate_extensions
t "a second run changes nothing" "$(cd "${X}" && find . | sort)" "${before}"

# a module the new layout already has is kept over an old one
ours "${X}/footer/index.ts" "old footer"
echo "// Written by lets-code (new footer)" > "${X}/lets-code/footer.ts"
fresh "${A}"; lc_migrate_extensions
t "new module kept over an old one" "$(cat "${X}/lets-code/footer.ts")" "// Written by lets-code (new footer)"
t "  the old directory retired" "$([ -e "${X}/footer" ] || echo gone)" gone

# lc_ext_module: where a writer puts its module, and the record of it
fresh "${A}"
lc_ext_module footer
t "module file" "${LC_MOD_FILE#${X}/}" lets-code/footer.ts
lc_ext_module sandbox
t "sandbox module file" "${LC_MOD_FILE#${X}/}" lets-code/sandbox/index.ts
lc_ext_module footer
t "features recorded once each" "${LC_ACTIVE}" "footer sandbox"

# --- the user has an extension called lets-code
B="${work}/b"; Y="${B}/extensions"
mkdir -p "${Y}/lets-code"; echo 'export default function () {}' > "${Y}/lets-code/index.ts"
ours "${Y}/footer/index.ts" footer
fresh "${B}"; lc_migrate_extensions
t "user's lets-code untouched" "$(ls "${Y}/lets-code")" index.ts
t "  ours goes to lets-code-ext" "$([ -f "${Y}/lets-code-ext/index.ts" ] && [ -f "${Y}/lets-code-ext/footer.ts" ] && echo y)" y
t "  with a note" "$(printf '%s' "${NOTES}" | grep -c "is your own extension")" 1
lc_ext_module mandate
t "  writers follow" "${LC_MOD_FILE#${Y}/}" lets-code-ext/mandate.ts

# --- a fresh agent dir: a writer alone brings the index along
C="${work}/c"
fresh "${C}"; lc_ext_module subagents
t "index written with the first module" "$(head -c 23 "${C}/extensions/lets-code/index.ts")" "// Written by lets-code"

exit "${fail}"
