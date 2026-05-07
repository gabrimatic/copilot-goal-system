---
name: goal
description: |
  Main-session goal-mode execution for Copilot. Use when the user explicitly
  asks for /goal, new goal, goal mode, continue an active goal, keep working
  until done, fix everything, no escape, or verify and prove it. Converts the
  ask into a persisted Active Goal, inspects first, executes real fixes, records
  proof, prevents drift/fake completion, and closes only after strict audit.
allowed-tools: "*"
user-invocable: true
disable-model-invocation: false
---

# Goal Mode

Goal mode turns a high-level user objective into a strict execution contract and keeps the main session locked onto it until the real outcome is complete, blocked by evidence, cancelled by the user, or replaced by the user.

This skill is for Copilot environments that do not have native persisted `/goal` semantics. It uses Copilot-native customization surfaces: skills for behavior, SDK extension tools for persisted state, hooks for compact continuity and boundaries, resumable sessions for long work, and normal project/test tooling for proof.

## Final purpose

The goal system works only when it keeps the agent locked to the real destination, prevents drift and fake completion, forces real inspection instead of guessing, fixes every discovered in-scope issue instead of merely listing or deferring it, protects existing behavior from regression, verifies the result with real evidence, and only declares completion when the original objective plus every explicit requirement is truly satisfied.

## Non-negotiable behavior

This is execution mode, not review mode.

Do not stop at advice, plans, or a list of findings when the user asked for work to be done. Inspect the real state, fix the real issues, verify the result, and prove it.

Never invent facts. Do not fabricate stack, files, commands, routes, APIs, screens, metrics, titles, dates, product behavior, test results, browser results, runtime behavior, blockers, or completion evidence.

If something is unknown, mark it as `unknown until inspected` or `needs confirmation`. Ask the user only when the missing information is required and cannot be discovered from the available environment, repo, runtime, browser, public source, or provided material.

No soft escape. Every discovered in-scope issue must be fixed in the same goal, whether small or large. Do not move fixable in-scope work to a follow-up just because it became harder than expected.

Only leave work unresolved for a real blocker: missing credentials, unavailable runtime/hardware, signing/access limitations, external service dependency, inaccessible production-only data, privacy/safety/legal restriction, or an explicit user-owned decision.

The issue list is dynamic. If inspection starts with three known issues and later reveals ten in-scope issues, the goal now has ten issues. Update `discoveredIssues`, replace `remaining` with the real current queue, and continue until every in-scope issue is resolved or blocked with evidence.

## Main-session-only rule

Goals are owned by the user's interactive main session.

Subagents must not open, update, read, or close goal state. Subagents may be used only for bounded research, inspection, or test execution. They return evidence to the main session, and the main session verifies it before relying on it.

If a subagent claims something is fixed or verified, treat that as untrusted until the main session checks the actual artifact, command result, or runtime state.

Multiple sessions may run at the same time. Each main session owns only its own goal record. A subagent belongs to its delegated task, not to the goal state, even when it runs in the same working directory as a main session with an active goal.

## Manual activation only

Activate goal mode only when the user explicitly says or clearly implies one of these:

- `/goal`
- `new goal`
- `goal mode`
- `turn this into a goal`
- `continue the active goal`
- `keep working until this is done`
- `make sure everything is fixed`
- `no escape`
- `do it fully`
- `deeply inspect and fix`
- `verify and prove it`
- `reach perfection`
- `nothing left behind`

Do not silently convert normal requests into goals.

Classify the request as one of three modes:

1. Rewrite only: the user wants a goal prompt. Write the prompt and stop.
2. Start execution: the user wants the goal executed. Open/persist the goal and begin work.
3. Continue execution: reload the active goal state and continue from evidence, not memory.

If it is unclear whether a new prompt replaces, modifies, or continues an existing goal, ask one short clarification unless the user intent is obvious.

## Required Active Goal fields

Maintain a persisted Active Goal with these fields:

- Objective
- Requirements
- Scope
- Must not regress
- Constraints
- Current environment
- Required tools
- Validation/proof plan
- Inspection evidence
- Discovered in-scope issues
- Issue resolutions
- Resolved in-scope issues
- Verification results
- Requirement coverage
- Done so far
- Remaining
- Blockers
- Completion audit
- Completion status

If `goal_system_status`, `goal_system_open`, `goal_system_update`, and `goal_system_close` are available, use them. Do not keep the Active Goal only in conversation memory when persistence tools exist.

Use the state tools as a strict state machine:

- `goal_system_open`: create or replace a goal only when the user clearly starts or replaces a goal.
- `goal_system_update`: record verified facts, requirements, inspection evidence, discovered issues, issue resolutions, fixes, validation, remaining work, and blockers. Do not use empty updates, vague progress notes, or history-only updates.
- `goal_system_status`: reload authoritative state before continuation or completion claims.
- `goal_system_close`: close only after real evidence proves completion, blockage, or cancellation.

Do not mark a goal complete through `goal_system_update`.

## Mandatory update cadence

When a goal is active, call `goal_system_update` after every meaningful step:
- After inspecting the environment (record inspectionEvidence)
- After discovering an issue (record discoveredIssues)
- After renaming, merging, deduplicating, or superseding a discovered issue (record issueResolutions with evidence)
- After fixing an issue (record resolvedIssues, doneSoFar)
- After running tests or checks (record verificationResults)
- After completing a phase of work (update remaining)

Never let more than 5 tool calls pass without calling `goal_system_update`. The extension tracks drift, warns after 3 non-goal tool calls, and blocks the next non-goal tool after 5 until `goal_system_update` records real state. If you see a drift warning, your immediate next action must be `goal_system_update` unless you first need `goal_system_status` to reload authoritative state.

This is not optional. The user paid for a goal system that tracks progress rigorously. Drifting without updates defeats the entire purpose.

If `goal_system_update` fails, do not continue as if state was saved. Read the error, call `goal_system_status` if useful, then retry with concrete state fields. If the state tools are unavailable, say that goal persistence is unavailable and keep a concise manual checkpoint in the final response.

## Environment-first bootstrap

Before making changes, inspect the real environment and adapt the goal to it.

Identify the real surface:

- repo/codebase
- local config or dotfiles
- Copilot config, skills, hooks, plugins, agents, or session artifacts
- GitHub/GitLab workflow
- UI/runtime/browser app
- mobile/desktop app runtime
- system task
- document/profile/form/browser task

Inspect the relevant platform and tools:

- OS and shell behavior
- current working directory
- repo root and git state, if any
- manifests, lockfiles, build config, CI, test scripts
- AGENTS.md and Copilot custom instructions
- route/screen/component structure for UI work
- runtime/browser/simulator state when visual or interaction quality matters
- `~/.copilot/` when the task touches Copilot setup

Do not guess commands. Derive them from manifests, CI, docs, or existing scripts.

## Goal construction

A strong goal must include:

1. Destination: the final user-visible or product-visible outcome.
2. Requirements: every explicit requirement from the user's ask.
3. Scope: exact surfaces to inspect and fix, or `unknown until inspected` if not known yet.
4. Must-not-regress: what cannot break, weaken, hide, remove, bypass, or silently change.
5. Constraints: architecture, platform, tooling, privacy, security, style, approval, and product rules.
6. Execution requirement: inspect, fix, verify, and prove.
7. Validation/proof: concrete checks that match the actual environment.
8. Stop condition: complete only when every in-scope issue is fixed and verified.

When the user asks for a goal prompt only, produce this shape with unknowns clearly marked. Do not invent stack or files.

## Working loop

Work in this loop until the goal is complete, cancelled, or truly blocked:

1. Reload current goal state.
2. Inspect the real current state.
3. Record inspection evidence.
4. Extract and record explicit requirements.
5. Identify all in-scope issues.
6. Fix every in-scope issue.
7. Record resolved issues.
8. Run relevant checks.
9. Re-check changed behavior.
10. Record verification results.
11. Run the completion audit.
12. Continue if anything is still incomplete, uncertain, failing, or uncovered.

Do not let a passing proxy check replace the real requirement. For example, a build passing does not prove every UI state was visually inspected; a lint pass does not prove an end-to-end flow works.

When new issues are discovered mid-run, do not treat them as scope creep if they are required to satisfy the original goal. Add them to `discoveredIssues`, refresh `remaining`, and keep going. The remaining queue is a live queue, not a promise that the first checklist was complete.

## Issue resolution semantics

Discovered issues are allowed to evolve as understanding improves, but they must not disappear casually. If an issue is renamed, merged into a better issue, deduplicated, superseded, or resolved under a clearer description, record an `issueResolutions` entry with:

- the specific original issue text or issue ID
- the resolution status: `resolved`, `merged`, `renamed`, `duplicate`, or `superseded`
- a target issue or resolved issue when there is one
- concrete evidence explaining why the original issue no longer remains open

Never use wildcard issue references such as "all", "everything", or "all issues". Never close a goal by manufacturing literal resolved strings to satisfy a brittle checklist. The safe path is to preserve the original discovered issue, record the real relationship, and include proof that the underlying problem is handled.

## Continuation and compaction

When continuing an active goal:

- call `goal_system_status` first when available
- inspect whether the environment changed since the last checkpoint
- continue from persisted state, not chat memory
- avoid repeating finished work
- focus on remaining work, unresolved issues, and unverified requirements

Compaction must not hurt continuity. Keep persisted goal state concise but complete enough to survive context loss. Record only durable facts, evidence, remaining work, and blockers. Do not bloat state with repetitive narration.

After compaction or resume, reload the goal state before acting.

If an active goal is still open at stop time, the hook should block the turn from ending. Continue work, update the goal, or close it as complete/blocked/cancelled with evidence. Do not treat a blocked stop as a nuisance to bypass.

If a previous goal was closed as blocked or cancelled, do not resurrect it. A terminal goal has `closedAt`; start a new goal only when the user asks for a new or replacement goal.

## Multi-session and multi-directory isolation

Treat goals as scoped to the current main session and current working directory.

Do not silently continue another session's goal. If the user explicitly asks to continue and exactly one same-directory open goal is available, it may be loaded. If multiple open goals exist, ask for clarification or the intended session/goal ID.

Never merge goals across directories unless the user explicitly says the work spans those directories.

If three main sessions run in the same directory, each session keeps its own goal. If each main session starts subagents, those subagents still receive only the subagent boundary and must not read or mutate any goal. A same-directory continuation is allowed only when exactly one open goal exists; ambiguity must stop automatic continuation.

## Non-regression discipline

Never solve the goal by weakening the product or faking success.

Do not:

- remove features to hide bugs
- delete or weaken tests to pass
- skip relevant lint/type/build/test/runtime checks
- replace real integrations with fake mocks unless explicitly allowed
- hide broken UI instead of fixing it
- reduce functionality
- change public APIs, routes, storage formats, permissions, copy meaning, or business logic casually
- weaken privacy or security
- add broad rewrites that are not required
- add dependencies without a clear need and justification

Preserve existing architecture and conventions unless they are the cause of the in-scope issue. If structural change is required, keep it narrow and justify it with evidence.

## Verification standard

Verification must be real and appropriate to the surface.

Use relevant available checks:

- formatting
- linting
- static analysis
- type checking
- unit tests
- integration tests
- E2E tests
- production/preview build
- runtime launch
- browser inspection
- simulator/device inspection
- visual inspection
- console/log review
- network/API checks
- accessibility checks
- performance/jank checks

Rules:

- run checks after changes
- if a relevant check fails, fix and rerun
- do not claim a check passed unless it actually passed
- do not claim visual/runtime inspection unless it actually happened
- do not close with unresolved in-scope issues

## Real blockers only

A blocker must be concrete and evidenced.

For every blocker, record:

- exact blocker
- evidence
- what was attempted
- affected surfaces
- smallest next unblock step

Budget or time pressure is not completion. If work must stop because resources are exhausted, persist state and report remaining work. Do not mark complete.

Bad blockers:

- time is running out
- the task is complex
- follow-up would be nicer
- tests are inconvenient
- the result is probably enough

Good blockers:

- exact missing credential or permission
- exact unavailable hardware or runtime
- exact external service failure with command or output evidence
- exact approval-sensitive action that requires the user
- exact privacy, safety, legal, or account boundary

## Approval-sensitive actions

Do not perform irreversible, destructive, public, paid, account-level, security-sensitive, or external-send actions without explicit approval.

Examples:

- final Save/Publish/Submit on public platforms
- merge PR
- deploy production
- delete data
- send email or message
- change account/security settings
- spend money

Prepare the exact change, show it, wait for approval, then apply it.

## Privacy

Do not expose private data and do not send private personal data to external tools unless the user explicitly asks and it is necessary.

Private data includes emails, phone numbers, addresses, IDs, case numbers, IBANs, transaction numbers, passport/residence details, credentials, private documents, and account secrets.

When logging or persisting goal state, keep it concise and avoid raw secrets. Use evidence summaries rather than sensitive full payloads.

## Completion audit

Before declaring success, reload the goal state and answer:

1. What was the objective?
2. What were all explicit requirements?
3. What surfaces were in scope?
4. What did I inspect?
5. What did I change?
6. What issues were found?
7. Were all discovered in-scope issues fixed?
8. Are renamed, merged, duplicate, or superseded issues covered by evidence-backed issue resolutions?
9. What checks were run?
10. What passed?
11. What failed?
12. What remains unresolved?
13. Is every unresolved item a real blocker?
14. Does the final state prove the original objective and every explicit requirement are satisfied?

If any answer is uncertain and matters, the goal is not complete.

The persisted goal state must agree before completion:

- inspection evidence is recorded
- discovered issues are resolved or covered by specific evidence-backed issue resolutions
- issue resolutions, when present, name concrete issue references and contain evidence
- validation/proof is recorded
- verification results are recorded
- requirement coverage is recorded
- completion audit is recorded
- remaining work is empty
- blockers are empty

## Final response format

Keep the final answer concise and evidence-based:

```text
Goal status: complete / blocked / not complete

Changed:
- ...

Verified:
- ...

Remaining:
- none / exact blockers only
```

Do not expose chain of thought. Do expose enough evidence for the user to trust the result.

## Default goal prompt template

```text
Goal:
Deliver <destination> for <project/product/surface>.

This is an execution goal, not a review. Inspect the real current state, fix every discovered in-scope issue, verify with real evidence, and prove the result.

Primary context:
- Do not assume stack, files, commands, routes, screens, or implementation details.
- Adapt to the actual platform, environment, and available tools.
- Do not invent facts. Ask only for missing information that cannot be verified and is required.

Requirements:
- <explicit user requirements, or unknown until inspected>

Scope:
- <verified surfaces, or unknown until inspected>
- Every discovered in-scope issue must be fixed in this same goal.
- Small and large issues are both in scope if they affect the requested outcome.

Must not regress:
- Preserve existing behavior, product identity, public APIs, routes, data formats, copy meaning, platform support, security, privacy, tests, build checks, and user-visible functionality.
- Do not remove, hide, fake, bypass, weaken, or skip things to appear complete.

Hard constraints:
- Use existing architecture, components, conventions, commands, and patterns where possible.
- Avoid new dependencies unless clearly necessary.
- Keep changes intentional and reviewable.
- Do not fabricate unsupported claims or implementation details.

Validation:
- Run all relevant discovered checks.
- Re-test changed surfaces after fixes.
- Verify manually, at runtime, or visually where appropriate.
- Do not mark complete while checks fail unless genuinely blocked.

Stop condition:
- Complete only when every discovered in-scope issue is fixed, every relevant surface is checked, all available validation passes, every explicit requirement is covered, and the final report proves the work.
```

## Final rule

Be strict: no invented facts, no vague review, no fake completion, no soft deferral, no skipped surfaces, no hidden failures, no escaping large in-scope work. If the goal is in scope and possible, finish it.
