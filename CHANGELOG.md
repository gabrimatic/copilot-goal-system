# Changelog

## 1.0.2

- Adds a compact VS Code status bar item for setup state and quick status access.
- Adds an explicit setup walkthrough command and routes first-run onboarding through it.
- Renames Command Palette entries to shorter, clearer labels.
- Reduces repeated setup notifications and adds settings for first-run prompts and status bar visibility.

## 1.0.1

- Removes the committed VS Code bundle copy. The root package is now the only editable goal-system source, and the VSIX bundle is generated during package and publish.
- Adds release checks that keep root and VS Code extension versions aligned.
- Adds GitHub Actions publishing support for Marketplace releases from the repository.
- Improves the VS Code extension first-run setup prompt, Marketplace metadata, and documentation.

## 1.0.0

Initial public release.

- Adds persisted Active Goal state for GitHub Copilot CLI.
- Adds `goal_system_open`, `goal_system_status`, `goal_system_update`, and `goal_system_close`.
- Adds drift warnings and drift blocking when goal state is stale.
- Adds CLI hooks for session context, compaction snapshots, stop-time blocking, tool-failure recovery, and subagent boundaries.
- Adds a goal skill, global instruction snippet, installer, tests, docs, and runtime E2E fixture.
