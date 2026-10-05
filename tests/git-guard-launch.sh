#!/usr/bin/env bash
# Test for the shell side of the git guard: git_guard_plan() from ./lets-code,
# run in throwaway repos. No model, no pi.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(sed -n '/^git_guard_plan() {/,/^}/p' "${here}/../lets-code")"
log_error() { echo "  (log_error) $*" >&2; }
GIT_GUARD="${GIT_GUARD:-true}"

work="$(mktemp -d)"; trap 'rm -rf "${work}"' EXIT
fail=0
t() { if [ "$2" = "$3" ]; then echo "ok    $1 -> $2"; else echo "FAIL  $1 -> '$2' (want '$3')"; fail=1; fi; }
mkrepo() { git init -q -b "$2" "$1"; git -C "$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init; }
plan() { ( cd "$1" && GIT_GUARD="${GIT_GUARD}" && git_guard_plan && echo "${GG_MODE}|${GG_BRANCH:-}|${GG_NOTE}" ); }

mkrepo "${work}/main" main
echo dirty > "${work}/main/wip.txt"
out="$(plan "${work}/main")"
t "main + dirty file: mode" "${out%%|*}" on
t "main + dirty file: branch prefix" "$(git -C "${work}/main" branch --show-current | cut -c1-3)" pi/
t "main + dirty file: file carried along" "$(cat "${work}/main/wip.txt")" dirty
t "main + dirty file: main untouched" "$(git -C "${work}/main" rev-list --count main)" 1

mkrepo "${work}/pi" pi/keep
out="$(plan "${work}/pi")"
t "already on pi/*: branch kept" "${out}" "on|pi/keep|"

mkrepo "${work}/collide" main
name="pi/$(date +%Y%m%d-%H%M)"
git -C "${work}/collide" branch "${name}"
echo other > "${work}/collide/wip.txt"
git -C "${work}/collide" switch -q "${name}" && echo committed > "${work}/collide/wip.txt" && git -C "${work}/collide" add wip.txt && git -C "${work}/collide" -c user.name=t -c user.email=t@t commit -q -m c && git -C "${work}/collide" switch -q main
echo dirty > "${work}/collide/wip.txt"    # conflicts with the existing pi branch's wip.txt
out="$(plan "${work}/collide")"
t "name collision + conflicting dirty file: mode" "${out%%|*}" on
t "name collision: a fresh pi/* branch" "$(git -C "${work}/collide" branch --show-current | sed 's#^pi/[0-9]*-[0-9]*#pi/TS#')" "pi/TS-2"
t "name collision: dirty file kept" "$(cat "${work}/collide/wip.txt")" dirty

mkrepo "${work}/merge" main
git -C "${work}/merge" switch -q -c other && echo a > "${work}/merge/f" && git -C "${work}/merge" add f && git -C "${work}/merge" -c user.name=t -c user.email=t@t commit -q -m a
git -C "${work}/merge" switch -q main && echo b > "${work}/merge/f" && git -C "${work}/merge" add f && git -C "${work}/merge" -c user.name=t -c user.email=t@t commit -q -m b
git -C "${work}/merge" -c user.name=t -c user.email=t@t merge -q other >/dev/null 2>&1 || true   # conflict: merge in progress
t "merge test setup: conflict exists" "$([ -f "${work}/merge/.git/MERGE_HEAD" ] && echo yes)" yes
out="$(plan "${work}/merge")"
t "merge in progress: guard on, no switch" "${out%%|*}|$(git -C "${work}/merge" branch --show-current)" "on|main"
t "merge in progress: MERGE_HEAD kept" "$([ -f "${work}/merge/.git/MERGE_HEAD" ] && echo yes)" yes

git init -q --bare "${work}/bare.git"
out="$(plan "${work}/bare.git")"
t "bare repo: off" "${out}" "off||not a git repo"

mkdir "${work}/plain"
out="$(plan "${work}/plain")"
t "not a repo: off" "${out}" "off||not a git repo"

mkrepo "${work}/off" main
out="$(GIT_GUARD=false plan "${work}/off")"
t "GIT_GUARD=false: off, branch untouched" "${out}|$(git -C "${work}/off" branch --show-current)" "off||disabled|main"

exit "${fail}"
