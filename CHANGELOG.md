# Changelog

## 0.1.0 (unreleased)

The first release. One bash script that points the pi coding agent at the
model on your own hardware:

- discovery at every launch: endpoint, model id, context window, thinking
  (with per-level budgets the server enforces) and vision, probed from the
  server; the output cap reserved in pi's compaction settings so a session
  never overflows
- guards: memory (Linux), git (a `pi/*` branch, refused irreversible
  commands, checkpoints before every tool call), agent (bash timeouts,
  cut-off recovery, test reminders, dynamic thinking), grounding
- modes and roles (`plan`, `auto`, `ask`, `orchestrator`, `yolo`) enforced
  on every tool call, with manifests per user and per project
- `/plan` (and `ctrl+alt+p`) without the mandate too; a finished plan asks
  to execute, refine or stay, and executing returns to the previous mode;
  Claude Code hooks see a runtime switch to plan as `permission_mode: plan`.
  A subagent started in plan mode runs read-only (`readonly`, or its own
  role if that writes nothing in the project), with the mandate off too
- with the mandate on, Claude Code hooks now get `permission_mode: "auto"`
  in the default mode (was `"default"`): the mode the mandate announces
- security: untrusted projects' `.pi/agents` and `.pi/mandate.json` were
  loaded, because pi's `isProjectTrusted` method was read as a boolean
- subagents in their own pi sessions, switchable from the footer (which,
  with the thinking level, follows the session on screen: each agent keeps
  its own level), with a 30-minute task budget by default
  (`LETS_CODE_SUBAGENT_TIMEOUT`; a cut task reports its last tool calls), and the
  experts behind one tool: tester (with `ui-tester` and `api-tester`),
  `expert-reviewer`, `design-reviewer`, `acceptance-judge`, `developer`,
  `software-factory`, `researcher`, `reverse-engineer`, `expert-builder`,
  `termux-device`
- the software factory: a ticket through plan, build, two reviews, tests,
  a judge and the suite in its own worktree, with checkpoints
- the Claude backend: Claude models on a Claude subscription through a
  local proxy sidecar, usable from another machine with a Claude Code token
- the Claude Code adapter: a project's `.claude/` hooks, commands, skills,
  agents, permission rules, MCP servers and workflows, read at each start
- presets for more backends, an OS sandbox, MCP import, a footer with
  tokens, speed and cost, a session tag for proxy logs, `update`
