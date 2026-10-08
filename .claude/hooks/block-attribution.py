#!/usr/bin/env python3
# PreToolUse hook (Bash): refuses a git commit or PR command whose text
# carries AI attribution lines. Exit 2 blocks the call; the message on
# stderr is shown to the model.
import json, re, sys
try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)
if not re.search(r"\bgit\b.*\bcommit\b|\bgh\b.*\bpr\b", cmd, re.S):
    sys.exit(0)
if re.search(r"Co-Authored-By:\s*Claude|Claude-Session:|Generated with \[Claude Code\]|https://claude\.ai/code/", cmd, re.I):
    sys.stderr.write("This repository does not accept AI attribution. Remove the Co-Authored-By / Claude-Session / Generated-with lines and retry.\n")
    sys.exit(2)
sys.exit(0)
