#!/usr/bin/env bash
# Unit test for claude_code_scan: the launch line's summary of what the
# Claude Code adapter finds, and the settings env it exports (the user's
# always, the project's only in a trusted folder: Claude Code's record for
# the folder or a parent, pi's trust.json, or lets-code's remembered answer).
set -eu
eval "$(sed -n '/^CC_SUMMARY=/p; /^claude_code_scan() {/,/^}$/p' "$(dirname "$0")/../lets-code")"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got '$2', want '$3'"; fail=1; fi; }
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/cc-scan.XXXXXX")" && pwd -P)"
trap 'rm -rf "${work}"' EXIT
export HOME="${work}/home"; unset CLAUDE_CONFIG_DIR
PI_AGENT_DIR="${HOME}/.pi/agent"; mkdir -p "${PI_AGENT_DIR}" "${HOME}/.claude/skills/one" "${HOME}/.claude/commands"
proj="${work}/repo/app"; mkdir -p "${work}/repo/.git" "${proj}/.claude/commands/ops" "${proj}/.claude/agents" "${proj}/.claude/workflows"
printf -- '---\ndescription: s\n---\nx\n' > "${HOME}/.claude/skills/one/SKILL.md"
echo hi > "${HOME}/.claude/commands/hello.md"
echo deploy > "${proj}/.claude/commands/ops/deploy.md"
echo a > "${proj}/.claude/agents/helper.md"
echo "export const meta = { name: 'w' };" > "${proj}/.claude/workflows/w.js"
printf '{"env":{"USER_VAR":"u v","LETS_CODE_X":"no"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}' > "${HOME}/.claude/settings.json"
printf '{"env":{"PROJ_VAR":"p"},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"a"},{"type":"prompt","prompt":"b"}]}]}}' > "${proj}/.claude/settings.json"

cd "${proj}"
unset USER_VAR PROJ_VAR LETS_CODE_X LETS_CODE_CLAUDE_ENV
claude_code_scan
check "untrusted: user parts counted, project parts wait" "${CC_SUMMARY}" "claude code: 2 commands, 1 skill, 1 hook (project hooks, MCP and env wait for trust)"
check "untrusted: the user's env exported" "${USER_VAR:-}" "u v"
check "untrusted: no project env" "${PROJ_VAR:-}" ""
check "LETS_CODE_* is never set from settings" "${LETS_CODE_X:-}" ""
check "the extension is told what was applied" "${LETS_CODE_CLAUDE_ENV:-}" "user"

printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}' "${work}/repo" > "${HOME}/.claude.json"
claude_code_scan
check "trusted in Claude Code (a parent): everything" "${CC_SUMMARY}" "claude code: 2 commands, 1 skill, 1 agent, 2 hooks, 1 workflow"
check "trusted: project env" "${PROJ_VAR:-}" "p"
check "trusted: LETS_CODE_CLAUDE_ENV=all" "${LETS_CODE_CLAUDE_ENV:-}" "all"

rm "${HOME}/.claude.json"; unset PROJ_VAR
printf '{"other":1,"claudeCodeTrust":{"%s":true}}' "${proj}" > "${PI_AGENT_DIR}/lets-code-state.json"
claude_code_scan
check "trusted by lets-code's remembered answer" "${PROJ_VAR:-}" "p"

cd "${work}"; rm -rf "${HOME}/.claude" "${PI_AGENT_DIR}/lets-code-state.json"
claude_code_scan
check "nothing Claude-ish: no summary" "${CC_SUMMARY}" ""
exit "${fail}"
