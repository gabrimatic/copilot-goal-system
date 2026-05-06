# Architecture

Copilot Goal System is a small state machine around GitHub Copilot CLI.

It combines three Copilot surfaces:

- **Skill:** teaches the model the goal-mode behavior contract.
- **SDK extension:** owns tools, persisted state, drift enforcement, and completion gates.
- **CLI hooks:** restore context and control lifecycle edges that the model tends to forget.

## Data flow

```text
User starts /goal
  -> userPromptSubmitted hook injects any existing goal context
  -> goal skill tells Copilot to use goal_system_* tools
  -> SDK extension opens or updates persisted goal state
  -> post-tool hooks track tool history and drift
  -> pre-tool hook denies stale non-goal tool calls after the threshold
  -> agentStop hook blocks premature turn completion
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

The duplicated writes are intentional. They let the system survive session resume, compaction, and same-directory continuation while refusing ambiguous multiple-goal states.

## Isolation model

The session id and cwd hash are both part of the lookup model. Three main sessions can run in the same directory and each will read only its own session goal during normal operation.

Same-directory continuation is intentionally conservative:

- zero open goals: do not pretend a goal exists
- one open goal: allow explicit continuation from that persisted record
- two or more open goals: refuse automatic continuation and ask for the intended session or goal id

Subagents do not get goal ownership. Lifecycle hooks give them a boundary message, SDK goal tools reject subagent-looking invocations, and post-tool history ignores subagent tool use. A main session may record subagent output only after checking the real evidence.

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

## Drift enforcement

The extension tracks non-goal tool calls while a goal is open.

| Count since update | Behavior |
|--------------------|----------|
| 0-2 | No warning. |
| 3-4 | Prompt-level warning. |
| 5+ | `onPreToolUse` denies the next non-goal tool call. |

`goal_system_status`, `goal_system_open`, `goal_system_update`, and `goal_system_close` do not count toward drift.

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
- no unresolved discovered issues
- action or verification evidence beyond claims

Blocked and cancelled goals can close without completion proof, but the state should record the exact blocker or cancellation reason.

## Subagent boundary

Subagents are useful for bounded inspection or test runs, but they do not own the goal.

The system protects this in two places:

- CLI `subagentStart` hook injects a boundary message without full goal state.
- SDK goal tools return failure when invocation metadata looks like a subagent.

The main session must verify subagent output before recording it as goal evidence.

## Privacy

Prompt source is stored as a hash plus redacted preview. Tool history is redacted and truncated. Goal state should contain evidence summaries, not raw secrets, private documents, or full prompt payloads.
