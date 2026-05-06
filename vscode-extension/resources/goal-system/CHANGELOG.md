# Changelog

## 1.0.0

Initial public release.

- Adds persisted Active Goal state for GitHub Copilot CLI.
- Adds `goal_system_open`, `goal_system_status`, `goal_system_update`, and `goal_system_close`.
- Adds drift warnings and drift blocking when goal state is stale.
- Adds CLI hooks for session context, compaction snapshots, stop-time blocking, tool-failure recovery, and subagent boundaries.
- Adds a goal skill, global instruction snippet, installer, tests, docs, and runtime E2E fixture.
