#!/bin/bash
# Live test of the memory guard: interactive lets-code (pi TUI) in a private
# tmux server, prompt injected with send-keys, optional leftover memory hogs
# moved INTO the session scope before they allocate.
# The guard acts on the machine's free RAM; the real levels (5 % free) would
# need ~25 GiB filled, so the test uses levels RELATIVE to the RAM free at start
# (LETS_CODE_MEM_* env), and -- independent of the guard under test -- a hard
# MemoryMax on the session scope plus a watchdog (a guard-only memory test
# global-OOMed the host once, 2026-09-26).
#   tests/mem-guard-live.sh <task-dir> [hog-GiB[,GiB...]]   env: PROMPT, LIMIT_S
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); task=${1:?task dir}; hogs=${2:-0}
free_mib=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
lv="-e LETS_CODE_MEM_WARN=$((free_mib-2048))M -e LETS_CODE_MEM_CRITICAL=$((free_mib-4096))M -e LETS_CODE_MEM_STOP=$((free_mib-6144))M -e LETS_CODE_MEM_EMERGENCY=$((free_mib-9216))M -e LETS_CODE_MEM_IGNORE_SYSTEM_GUARD=1"
echo "free now ${free_mib} MiB -> warn<$((free_mib-2048))M critical<$((free_mib-4096))M stop<$((free_mib-6144))M emergency<$((free_mib-9216))M"
sock=lcmemtest; out=$(mktemp -d); LIMIT_S=${LIMIT_S:-420}
prompt="${PROMPT:-Run the test suite in this directory ONCE with: python3 -m unittest tests_chess   Do not modify, debug or rerun anything. Then tell me what happened and why, in 2-3 sentences, and end your reply with the word REPORT-END.}"
tmux -L $sock new-session -d -s t -x 200 -y 50 -c "$task" $lv "$here/../lets-code --thinking-level low"
scope=""
for i in $(seq 1 60); do
  sleep 1
  for p in $(pgrep -x pi); do
    c=$(sed -n 's/^0:://p' /proc/$p/cgroup 2>/dev/null)
    case "$c" in */lets-code-*.scope) [ "$(readlink /proc/$p/cwd)" = "$(realpath "$task")" ] && scope=/sys/fs/cgroup$c ;; esac
  done
  [ -n "$scope" ] && break
done
[ -n "$scope" ] || { echo "no lets-code scope found"; tmux -L $sock kill-server; exit 1; }
systemctl --user set-property --runtime "${scope##*/}" MemoryMax=$((free_mib-4096))M MemorySwapMax=0   # safety net only
echo "scope: ${scope##*/}  safety memory.max=$(cat $scope/memory.max)"
pids=""
for g in ${hogs//,/ }; do
  [ "$g" = 0 ] && continue
  # start in its own user scope (same delegated tree as the session scope), so
  # moving it across only needs write access that the user owns
  systemd-run --user --scope --quiet --collect python3 -c "import os,time
while not os.path.exists('$out/go'): time.sleep(0.2)
x=b'a'*int($g*(1<<30)); time.sleep(3600)" & pids="$pids $!"
done
sleep 1.5
for p in $pids; do echo $p > $scope/cgroup.procs || { echo "could not move hog $p into the scope"; kill $pids; tmux -L $sock kill-server; exit 1; }; done
touch $out/go
[ -n "$pids" ] && { sleep 8; echo "after hogs: memory.current=$(( $(cat $scope/memory.current) >> 20 )) MiB"; }
( sleep $((LIMIT_S+30)); echo "WATCHDOG: killing test"; kill -9 $pids 2>/dev/null; tmux -L $sock kill-server 2>/dev/null ) & W=$!
sleep 8
tmux -L $sock send-keys -t t -l "$prompt"; sleep 0.5; tmux -L $sock send-keys -t t Enter
for i in $(seq 1 $((LIMIT_S/5))); do
  sleep 5
  tmux -L $sock capture-pane -p -t t -S - > $out/pane.new 2>/dev/null && mv $out/pane.new $out/pane.log
  [ "$(grep -c REPORT-END $out/pane.log)" -ge 2 ] && break
done
ev=$(tr '\n' ' ' < $scope/memory.events 2>/dev/null); echo "=== scope memory.events: ${ev:-(scope gone)}"
echo "=== pi's reply"; grep -v '^\s*$' $out/pane.log | grep -B12 'REPORT-END' | tail -13
echo "=== lets-code / memory lines in pane"; grep -E "\[lets-code\]|Killed|KeyboardInterrupt|MemoryError|exit 13[07]|code 13[07]" $out/pane.log | cut -c1-200 | head -12
kill -9 $pids 2>/dev/null; kill $W 2>/dev/null; tmux -L $sock kill-server 2>/dev/null
cp $out/pane.log /tmp/lc-memtest-last-pane.log 2>/dev/null; rm -rf "$out"
