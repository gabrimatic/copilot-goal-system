# Requirements

Copilot Goal System keeps a long-running agent locked onto a real destination.

It is successful only when it prevents drift, survives compaction, keeps subagents out of goal ownership, records durable evidence, and refuses fake completion.

## Required properties

- Manual activation only: normal requests must not silently become goals.
- Main-session ownership: subagents cannot open, read, update, or close goals.
- Durable state: active goals are persisted by session, working directory, and compact snapshot.
- Isolation: same-directory goals in different sessions must not silently merge.
- Continuation: a single unambiguous same-directory open goal can be loaded only when the user asks to continue.
- Drift control: the main session must update state after meaningful work and is blocked after too much stale progress.
- Stop control: an open goal blocks agent stop until it is continued or closed with evidence.
- Completion control: complete goals require inspection evidence, validation proof, verification results, requirement coverage, no remaining work, no blockers, resolved or evidence-covered discovered issues, and a completion audit.
- Privacy: source prompts and tool summaries are redacted before persistence.

## State contract

Durable evidence fields append by default:

- requirements
- scope
- mustNotRegress
- constraints
- currentEnvironment
- requiredTools
- validationProof
- verificationResults
- requirementCoverage
- inspectionEvidence
- discoveredIssues
- issueResolutions
- resolvedIssues
- doneSoFar
- completionAudit

Mutable queues replace by explicit update:

- remaining
- blockers

This split prevents partial updates from erasing proof while still allowing the model to intentionally clear outstanding work.

`issueResolutions` is for issue evolution, not shortcut completion. Entries must name the original discovered issue, use one of `resolved`, `merged`, `renamed`, `duplicate`, or `superseded`, and include evidence for why the original issue no longer remains open.

## Completion gate

`goal_system_close` may mark a goal complete only when all of these are true:

- objective is known
- doneSoFar is recorded
- validationProof is recorded
- verificationResults are recorded
- inspectionEvidence is recorded, or tool history proves inspection
- requirementCoverage covers each explicit requirement
- completionAudit is recorded
- remaining is empty
- blockers is empty
- every discovered issue is listed in resolvedIssues or covered by a specific evidence-backed issue resolution
- there is action or verification evidence beyond claims

Blocked and cancelled goals may close without satisfying completion proof, but they must carry exact blocker or cancellation evidence in the summary and persisted fields.
