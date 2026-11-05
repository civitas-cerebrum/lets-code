# Changelog

## 0.1.0 (unreleased)

The first release. One bash script that points the pi coding agent at the
model on your own hardware:

- discovery at every launch: endpoint, model id, context window, thinking
  (with per-level budgets the server enforces) and vision, probed from the
  server; the output cap reserved in pi's compaction settings so a session
  never overflows
- Windows: runs in Git Bash (as pi does) from PowerShell, cmd, Windows
  Terminal or Git Bash, installed with `npm install -g
  --allow-scripts=@civitas-cerebrum/lets-code @civitas-cerebrum/lets-code`;
  every feature but the sandbox (macOS and Linux only), with a lighter
  memory guard; the test suite runs on windows-latest in CI
- guards: memory (off by default; a RAM watcher asks at 85 % use, a headless
  session declines), git (off by default, `/git-guard on`: a `pi/*` branch, refused irreversible
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
- core memory: per project and global, searched on demand with the
  `memory` tool and `/memories`; it keeps what is significant later
  (decisions, non-obvious facts, preferences, where things live, a goal
  reached or work wrapped up), never the steps on the way. lets-code no
  longer adds an entry for every subagent, expert run or session that ended,
  only for a factory run that ends done; a subagent's `remember` refuses a
  `work` entry (its task is a step of the parent's); the step entries
  lets-code wrote before move to the archive the next time the store is
  opened
- presets for more backends, an OS sandbox, MCP import, a footer with
  tokens, speed and cost, a session tag for proxy logs, `update`
- sessions and messages (#79): a `message` tool, `/sessions`, `lets-code
  sessions` and `lets-code message` for one session on the machine to tell
  another something: by pid, session id or name, `repo` for every session
  in the repository, `parent` and `children` between an orchestrator and
  its subagents; shown after the receiver's current turn, never in the
  middle of it, with delivered / queued / undeliverable back to the sender;
  no unattended turn unless `LETS_CODE_SESSIONS_AUTOTURN=1`. `lets-code
  sessions` and `lets-code message` are now subcommands: a first word of
  `sessions` or `message` no longer passes to pi as a prompt (use
  `lets-code -p "..."` for one)
- runs on pi 1.4.0 (the latest; checked by hand: subagent sessions switch
  from an idle main session, in place while it works, between subagents
  and back); pi 0.85+ still works, as before
- outside runs: agents another extension starts inside a session (a QA
  package's `pi -p` orchestrator and experts) are now the session's outside
  children (lineage through `LETS_CODE_OWNER_PID`; a lets-code launch starts
  a fresh one): listed under it, shown in the subagent view (alt+s,
  `/subagents`) live from their own session files, read-only and in place
  (their files are never opened as a session or written to), stoppable with
  `x`, and in `subagent({action: "status"})` with their pid. Before, such a
  session's view stayed empty while they worked
- Claude Code hooks see lets-code's agents as Claude Code's subagents: a
  subagent's and an outside child's hooks get the main session's
  `session_id` and `transcript_path`, `agent_id` (the run) and `agent_type`;
  SubagentStart / SubagentStop (with `agent_transcript_path`) replace
  SessionStart, Stop and SessionEnd there, and its task is no
  UserPromptSubmit (an outside child used to fire all of those as a second
  main session); the `expert` tool is `Agent` (and `Task`) to matchers
  when it starts one
- Claude Code sessions, machine-wide: `message` (`action: "list"`), `/sessions`
  and `lets-code sessions` list them; `action: "inspect"` shows a session's
  state and latest messages (lets-code's sessions too); a message reaches
  one (`claude:<pid|name>`) through `lets-code claude-hook install`, a hook
  on Claude Code's documented contract (PostToolUse context, a Stop block,
  an asyncRewake watcher for an idle session), with replies through
  `lets-code message`, signed as that Claude Code session. Before, a
  message to a Claude Code session was always undeliverable
- `/extensions`: lets-code's optional extensions in a menu, each turned on
  or off there (or `/extensions <name> on|off`) and kept for later
  sessions; the first is Claude Code messages (`claude-hook`)
- launch: no more `Extension ".../lets-code/index.ts" project_trust error:
  Cannot read properties of undefined (reading 'trusted')` in a project with
  pi resources of its own (a `.pi/settings.json` package). pi 1.0 asks
  extensions to vote on trust (`project_trust` must return `{trusted}`)
  before it decides; the mandate's handler was a reload that returned
  nothing, and ran before trust was known. It is gone: the mandate reloads
  at `session_start`, with the decided trust
- no typing into another session's terminal: a bash command that writes to
  a terminal device (`/dev/ttys*`, `/dev/pts/*`) or injects input (TIOCSTI,
  AppleScript keystrokes), and the write and edit tools on one, are refused
  with a pointer to the `message` tool. A model whose message to a Claude
  Code session was undeliverable wrote it into that session's tty, which put
  the text in the user's input box; it never reached Claude. An
  undeliverable message now says not to reach the session another way
- a message delivered to a Claude Code session also shows the user a line
  there (the hook's `systemMessage`), as Claude Code's own messages do; the
  model gets the whole message as context
- a message that reaches a busy session says so at once (a notice: "...
  (shown when this turn ends)"); it used to appear only when the turn
  ended, so a reply that had been delivered looked lost meanwhile
