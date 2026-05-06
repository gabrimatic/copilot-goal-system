# Runtime E2E Review

Use this checklist after installing into your real `~/.copilot` profile.

## Runtime checks

- `/env` shows the goal-system extension or plugin surface.
- `/skills info goal` shows the goal skill.
- Starting `/goal <real task>` creates a persisted goal instead of only acknowledging the skill.
- `goal_system_status` shows the same goal ID after a new prompt in the same session.
- A subagent receives main-session-only boundary text and cannot use goal tools.
- After five non-goal tool calls without `goal_system_update`, a sixth non-goal tool is denied.
- Trying to stop with an open goal is blocked by the hook.
- `goal_system_close` refuses `complete` when required evidence is missing.
- `goal_system_close` accepts `complete` only after inspection, resolution, verification, coverage, no remaining work, no blockers, and completion audit are recorded.

## Fixture prompt

Run this inside Copilot after install:

```text
@tests/prompts/goal-system-reliability-e2e.md
```

The fixture project has a real failing test. The live session should inspect it, run the test, fix it, rerun it, update the persisted goal, and close only after proof exists.

## Known limits

Local tests cannot prove a specific Copilot CLI build invokes every SDK hook. Verify `/env`, hook registration, and one real `/goal` session after installing.
