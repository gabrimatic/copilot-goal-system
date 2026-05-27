# Changelog

## 1.1.20

- Reframes goalctl and installed goal-system files as control-plane APIs so agents use status/update/close commands instead of reading implementation files.
- Requires ordinary goal completion evidence to come from the user-requested target; installed goal-system control-plane reads no longer count as task inspection evidence.
- Updates CLI and VS Code hook prompts to steer inspection toward the target workspace, runtime, or artifact.

## 1.1.19

- Makes goal audit writes deterministic so `goalctl close` records the close event before the CLI process exits.
- Adds regression coverage for immediate close-audit durability after an evidence-backed completion.

## 1.1.18

- Removes the remaining legacy server cleanup path from install, doctor, status, docs, and tests so current runtime setup is local commands, direct tools, and lifecycle hooks only.
- Adds CLI pre-tool and post-tool lifecycle hooks that record tool drift, warn Copilot to checkpoint goal state, and keep investigation recoverable instead of blocking useful work by default.
- Keeps hard enforcement at the places that matter: open goals block premature stop, and completion still refuses vague proof, unresolved issues, blockers, or remaining work.

## 1.1.17

- Removes the goal-system legacy server process and external server SDK dependency from runtime, packaging, install, doctor, and status paths.
- Adds `bin/goalctl.mjs` as the local command fallback for status, open, update, and close operations.
- Installs VS Code language model tools directly through the extension and keeps VS Code Chat on hooks plus the local command fallback.
- Stops creating legacy server config for old Copilot CLI and VS Code profiles.

## 1.1.16

- Recovers malformed or non-object Copilot and VS Code target config files during install/update by preserving the original as an `*.invalid-backup-*` file, recreating a clean JSON object, and continuing setup.
- Preserves existing config file permissions when writing backups or replacing target JSON/JSONC files, with new config files defaulting to owner-only permissions.
- Adds regression coverage for corrupt Copilot CLI settings, corrupt legacy server config, corrupt VS Code target config, and parseable non-object settings so reinstall cannot loop on the same broken local file.
- Documents the config recovery behavior for CLI and Marketplace installs.

## 1.1.15

- Fixes Linux CI doctor tests by isolating fake-home `XDG_CONFIG_HOME` paths before release.

## 1.1.14

- Fixes the installer and release helper error paths so piped CI output cannot lose the real failure message before exit.
- Stabilizes corrupt-config installer regression tests by matching captured process output instead of Node's runtime-specific `execFile` wrapper message.
- Serializes the Node test runner so installer and doctor tests that spawn local processes cannot race each other in CI.
- Adds release verification coverage for the GitHub runner shape that exposed the flake: Linux x64, Node 20, and CI-mode environment variables.

## 1.1.13

- Installs `jq` in CI and Marketplace publish workflows so Linux release checks exercise the CLI hook helper instead of silently skipping it.
- Documents `jq` as a CLI hook dependency alongside the bash shell requirement.
- Reports missing `jq` in doctor output instead of leaving CLI hook parsing as an invisible no-op.

## 1.1.12

- Makes release verification deterministic by avoiding repeated live `npm ci` calls inside installer and doctor regression tests while keeping explicit failed-update rollback coverage.
- Removes the `jq` requirement from `npm run check` so JSON validation runs through Node on every supported development host.
- Adds quieter, more cache-friendly production dependency installation flags for local runtime updates.
- Teaches `npm run doctor` the same custom VS Code config override as the installer so custom VS Code profiles verify the path that was actually updated.

## 1.1.11

- Fixes the doctor JSONC regression test to use the platform-specific VS Code config path, matching Linux CI and macOS local installs.

## 1.1.10

- Completes installer update hardening with shared Copilot profile-root resolution across install, doctor, and VS Code status/update paths.
- Refuses parseable but non-object config files before replacing the installed runtime.
- Uses the same runtime allowlist for local installs and VS Code Marketplace bundles so unrelated repository artifacts cannot leak into installed runtime snapshots.

## 1.1.9

- Accepts JSONC in Copilot CLI `settings.json` and VS Code profile config during install and doctor checks, matching Copilot CLI's documented config format.
- Preserves comments outside the exact updated config subtrees while merging goal hook entries.
- Makes runtime updates transactional by installing production dependencies in a temporary runtime before replacing the existing local runtime.
- Supports non-default `COPILOT_HOME` profiles in installer paths, hook commands, and CLI hook state lookup.
- Adds regression coverage for JSONC install, JSONC doctor status, failed-update rollback, `COPILOT_HOME`, and VS Code JSONC config so Marketplace-bundled installers cannot reject valid commented config again.

## 1.1.8

- Adds a local command fallback so goal operations can recover when direct tools are hidden.
- Adds `npm run doctor` for local host diagnostics across Copilot CLI, installed runtime files, lifecycle hooks, stale drift hooks, duplicate hook entries, local command self-tests, and VS Code hook config.
- Injects `sessionId` and `cwd` into CLI hook context and creates a persisted draft goal from explicit CLI `/goal` prompts so local fallback tools can bootstrap a new goal when direct SDK tools are hidden.
- Recognizes prefixed goal tool names such as `goalSystem-goal_system_update` as goal tools, so recovery updates do not count as drift.
- Preflights target JSON files before copying runtime files and improves VS Code status wording for partial CLI-only or VS Code-only installs.

## 1.1.7

- Normalizes Copilot CLI goal hook installs so `~`, `$HOME`, absolute, and wrapper-based `goal-context.sh` commands do not stack duplicate goal hooks.
- Preserves composite user hooks that already include `goal-context.sh`, such as merge helpers that also inject system context.
- Extends VS Code status checks to detect disabled CLI hooks, duplicate goal hooks, and stale drift hooks instead of reporting a misleading clean install.
- Adds regression coverage for duplicate direct hooks, composite hook preservation, stale drift hook reporting, and flexible hook command detection.

## 1.1.6

- Makes drift recovery non-deadlocking by default: critical drift now injects a recovery reminder while allowing the tool call, with hard denial left behind an explicit `GOAL_SYSTEM_HARD_DRIFT_BLOCK=1` opt-in.
- Resets drift accounting at each new user turn so stale tool history from an older turn cannot permanently lock a session.
- Removes stale goal-system `preToolUse` and `postToolUse` hooks from Copilot CLI settings during install or update.
- Updates the goal skill, docs, and regression tests for the recoverable drift contract.

## 1.1.5

- Fixes `/goal` slash-command activation detection so adapters that rely on shared activation logic create persisted goals correctly.
- Makes VS Code Chat persist a draft goal on explicit `/goal` prompts and load one unambiguous same-directory goal on explicit continuation.
- Registers the VS Code Chat `UserPromptSubmit` hook in installed hook config and status checks.
- Replaces installed runtime snapshots during updates so stale files removed from newer releases do not remain active.
- Writes compact snapshots as both readable text and machine-readable JSON.
- Strengthens release checks for lockfile version drift and changelog coverage.

## 1.1.4

- Strengthens stop-time continuation with a hard directive to reload status, continue work, update state, and close only with evidence.
- Treats alternate stop payloads such as `finishReason`, `completionReason`, and `terminationReason` as stop attempts.
- Reuses the same stop-continuation contract across CLI hooks and the VS Code Chat hook adapter.

## 1.1.3

- Publishes the VS Code extension automatically from GitHub Actions when a `v*` tag is pushed.
- Fails the publish workflow clearly when the Marketplace token is missing instead of silently packaging without publishing.
- Documents the `VSCE_PAT` setup and tag-based publish flow.

## 1.1.2

- Treats empty Copilot `settings.json` and VS Code profile config files as empty objects during install or update.
- Keeps malformed non-empty JSON protected: the installer still refuses to overwrite it.

## 1.1.1

- Adds evidence-backed `issueResolutions` for renamed, merged, duplicate, superseded, or clearer-worded discovered issues.
- Rejects wildcard, target-only, or unevidenced issue-resolution entries during completion.
- Prompts in VS Code when extension updates leave `~/.copilot/extensions/goal-system/` stale.
- Updates status reporting, docs, and tests for runtime update checks.

## 1.1.0

- Adds a VS Code Copilot Chat preview adapter with custom agent, VS Code lifecycle hooks, and local goal tools.
- Adds `--target cli`, `--target vscode-chat`, and `--target all` installer modes.
- Adds persisted VS Code Chat drift tracking through shared goal history.
- Adds VS Code Chat install, hook, and local-tool tests.
- Updates documentation for CLI stable mode and VS Code Chat preview mode.

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
