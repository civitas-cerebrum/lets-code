#!/usr/bin/env bash
# CI heartbeat: memory use and the three largest processes, every minute, so a
# job that dies leaves a trail of how memory went (Linux runners).
while sleep "${HEARTBEAT_S:-60}"; do
    echo "[heartbeat] $(date +%T) $(free -m | awk 'NR == 2 { print $3 " MB used, " $7 " MB available" }')"
    ps -eo rss=,args= --sort=-rss | head -3 | awk '{ printf "  %d MB %s\n", $1 / 1024, substr($0, index($0, $2), 120) }'
done
