# Architecture

Copilot Goal System is a local state machine with host-specific adapters.

Shared core:

- `lib/goal-core.mjs` stores goals, validates completion, formats summaries, redacts sensitive text, and tracks persisted tool history.

Adapters:

- **Copilot CLI stable adapter:** skill, Copilot SDK tools, and CLI hooks.
- **VS Code Chat preview adapter:** custom agent, MCP tools, and VS Code agent hooks.

## Data flow

```text
Prompt starts /goal
  -> adapter injects sessionId/cwd and any existing goal context
  -> explicit activation creates a persisted draft goal before substantive work begins
  -> skill or custom agent tells Copilot to use goal_system_* tools
  -> SDK or MCP tool opens or updates persisted goal state
  -> post-tool hooks track tool history and drift
  -> pre-tool hooks deny stale non-goal tool calls after the threshold
  -> stop hooks block premature turn completion
  -> goal_system_close enforces proof before complete
```

## State locations

State is written to three places:

| Path | Purpose |
|------|---------|
| `~/.copilot/session-state/goal-system/by-session/<session>.json` | Same-session lookup. |
| `~/.copilot/session-state/<session>/goal-state.json` | Session-local workspace state. |
| `~/.copilot/session-state/goal-system/by-cwd-session/<cwd-hash>--<session>.json` | Same-directory continuation and ambiguity detection. |
| `~/.copilot/session-state/goal-system/compact/<session>.txt` | Compact prompt snapshot written before compaction. |
| `~/.copilot/session-state/goal-system/compact/<session>.txt.json` | Machine-readable compact snapshot metadata. |

The duplicated writes are intentional. They let the system survive session resume, compaction, and same-directory continuation while refusing ambiguous multiple-goal states.

## Isolation model

The session id and cwd hash are both part of the lookup model. Three main sessions can run in the same directory and each will read only its own session goal during normal operation.

Same-directory continuation is conservative:

- zero open goals: do not pretend a goal exists
- one open goal: allow explicit continuation from that persisted record
- duplicate records for the same resumed goal id: treat them as one goal and pick the newest copy
- two or more open goals: refuse automatic continuation and ask for the intended session or goal id

Subagents do not get goal ownership. Lifecycle hooks give them a boundary message, SDK goal tools reject subagent-looking invocations, VS Code Chat hooks do not expose goal state to subagents, and post-tool history ignores subagent tool use. A main session may record subagent output only after checking the real evidence.

## Goal record

```json
{
  "version": 3,
  "id": "...",
  "sessionId": "...",
  "cwd": "...",
  "objective": "...",
  "requirements": [],
  "scope": [],
  "mustNotRegress": [],
  "constraints": [],
  "currentEnvironment": [],
  "requiredTools": [],
  "validationProof": [],
  "verificationResults": [],
  "requirementCoverage": [],
  "inspectionEvidence": [],
  "discoveredIssues": [],
  "issueResolutions": [],
  "resolvedIssues": [],
  "doneSoFar": [],
  "remaining": [],
  "blockers": [],
  "completionAudit": [],
  "completionStatus": "active",
  "closedAt": null
}
```

Durable evidence fields append by default. `remaining` and `blockers` replace by explicit update so the main session can clear queues on purpose.

`discoveredIssues` is additive because horizon tasks reveal work over time. If an inspection expands the task from three issues to ten, the full ten stay in the durable issue set. `remaining` is replaceable because it represents the current live queue, not a permanent history log.

`issueResolutions` records safe issue evolution. A discovered issue can be marked `resolved`, `merged`, `renamed`, `duplicate`, or `superseded` only when the entry names the original issue and includes evidence. Wildcard references such as "all issues" are rejected, so Copilot cannot bypass the completion gate by manufacturing literal resolved strings.

## Status model

| Status | Open? | Meaning |
|--------|-------|---------|
| `draft` | Yes | Created from an activation prompt, still needs real inspection. |
| `active` | Yes | Normal execution state. |
| `blocked` without `closedAt` | Yes | Temporarily blocked, but still resumable. |
| `blocked` with `closedAt` | No | Terminal blocker recorded. |
| `complete` with `closedAt` | No | Completed with proof. |
| `cancelled` with `closedAt` | No | Cancelled by user or explicit replacement flow. |

`closedAt` prevents terminal blocked goals from resurrecting as open goals.

## Adapters

### Copilot CLI

The CLI adapter uses:

- `skills/goal/SKILL.md`
- `extension.mjs`
- `hooks/goal-context.sh`
- `~/.copilot/settings.json`

The SDK extension exposes `goal_system_*` tools and owns in-session drift counters. The shell hook restores goal context, writes compact snapshots, blocks `agentStop`, and keeps subagents outside goal ownership.

### VS Code Copilot Chat

The VS Code Chat adapter uses:

- `adapters/vscode-chat/agents/goal-system.agent.md`
- `adapters/vscode-chat/hooks/goal-system.json`
- `adapters/vscode-chat/hook-runner.mjs`
- `adapters/vscode-chat/mcp-server.mjs`

VS Code hooks inject `sessionId` and `cwd` into the chat context. MCP tools require those values so multiple sessions in one workspace stay isolated. Persisted tool history drives drift enforcement across VS Code hook invocations.
`UserPromptSubmit` also gives VS Code Chat the same activation and continuation bridge as the CLI path: `/goal` creates a persisted draft goal immediately, and an explicit continue prompt can hydrate one unambiguous same-directory goal into the current session.

## Drift enforcement

Adapters track non-goal tool calls while a goal is open.

| Count since update | Behavior |
|--------------------|----------|
| 0-2 | No warning. |
| 3-4 | Prompt-level warning. |
| 5+ | `onPreToolUse` denies the next non-goal tool call. |

`goal_system_status`, `goal_system_open`, `goal_system_update`, and `goal_system_close` do not count toward drift, including MCP-prefixed tool names in VS Code.

Stop hooks use the same continuation contract in CLI and VS Code Chat: if the current main session still has an open goal, the hook blocks stop and tells the model to reload status, continue the next concrete remaining item, update persisted state, and close only with evidence. Alternate stop payloads such as `finishReason`, `completionReason`, and `terminationReason` are treated as stop attempts.

## Completion gate

`goal_system_close` refuses `complete` unless the goal contains:

- objective
- doneSoFar
- validationProof
- verificationResults
- inspectionEvidence or inspection tool history
- requirementCoverage for every explicit requirement
- completionAudit
- empty remaining
- empty blockers
- no unresolved discovered issues, except those covered by specific evidence-backed issue resolutions
- action or verification evidence beyond claims

Blocked and cancelled goals can close without completion proof, but the state should record the exact blocker or cancellation reason.

## Subagent boundary

Subagents are useful for bounded inspection or test runs, but they do not own the goal.

The system protects this in two places:

- CLI `subagentStart` hook injects a boundary message without full goal state.
- VS Code `SubagentStart` hook injects the same boundary message without full goal state.
- SDK goal tools return failure when invocation metadata looks like a subagent.
- VS Code MCP goal tools require the main session `sessionId` and `cwd` from hook context.

The main session must verify subagent output before recording it as goal evidence.

## Privacy

Prompt source is stored as a hash plus redacted preview. Tool history is redacted and truncated. Goal state should contain evidence summaries, not raw secrets, private documents, or full prompt payloads.
