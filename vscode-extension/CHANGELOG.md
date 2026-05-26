# Changelog

## 1.1.19

- Makes bundled goal audit writes deterministic so local `goalctl close` records the close event before the process exits.
- Adds release coverage for immediate close-audit durability after an evidence-backed completion.

## 1.1.18

- Removes the remaining legacy server cleanup/status surface from the Marketplace bundle.
- Adds CLI tool-use lifecycle hook coverage so local installs can warn on stale goal state while keeping useful investigation recoverable.
- Keeps completion and stop-time enforcement strict: open goals block premature final stop, and close refuses missing proof or unresolved work.

## 1.1.17

- Removes the goal-system legacy server process and external server SDK dependency from the bundled runtime.
- Adds direct VS Code language model tools for goal status, open, update, and close.
- Adds the local `goalctl` command fallback and updates setup/status checks for local installs.
- Stops creating legacy server config for older local profiles.

## 1.1.16

- Recovers malformed or non-object Copilot and VS Code target config files during install/update by preserving the original as an `*.invalid-backup-*` file, recreating a clean JSON object, and continuing setup.
- Preserves existing config file permissions when writing backups or replacing target JSON/JSONC files.
- Adds Marketplace-bundled installer regression coverage for corrupt VS Code config recovery.
- Documents the recovery behavior for repeated extension reinstall/update flows.

## 1.1.15

- Fixes Linux CI doctor test isolation for fake VS Code config paths.

## 1.1.14

- Fixes installer and helper-script error output so CI and terminal users reliably see the real failure reason.
- Stabilizes corrupt-config installer tests across Node runtimes.

## 1.1.13

- Installs `jq` in CI and publish workflows so Linux release checks cover CLI hook behavior.
- Documents `jq` as required for CLI hook mode.
- Reports missing `jq` in doctor output.

## 1.1.12

- Makes installer/update release checks less dependent on host package-manager/network behavior.
- Removes the `jq` requirement from the shared project check path.
- Uses quieter, cache-friendly dependency installation flags when the bundled installer prepares the local runtime.
- Aligns doctor checks with installer overrides for custom VS Code config paths.

## 1.1.11

- Fixes platform-specific doctor regression coverage for VS Code config paths.

## 1.1.10

- Uses one Copilot profile-root resolver across install, status, doctor, and bundled update paths.
- Refuses non-object config files before replacing the installed local runtime.
- Uses the shared runtime allowlist for both local installs and Marketplace bundles.

## 1.1.9

- Accepts JSONC in Copilot CLI and VS Code config files during install and status checks.
- Preserves comments outside the exact updated config subtrees when merging goal hooks.
- Prepares production dependencies before replacing the installed local runtime during updates.
- Supports non-default `COPILOT_HOME` profile paths in the bundled installer.
- Adds Marketplace-bundle regression coverage for valid commented config files, failed update rollback, and custom Copilot profiles.

## 1.1.8

- Installs a Copilot CLI local command fallback so goal tools can recover when direct tools are hidden.
- Adds local doctor diagnostics for runtime files, CLI hooks, local command self-tests, VS Code hooks, duplicate hooks, and stale drift hooks.
- Includes `sessionId` and `cwd` in CLI hook context and creates a persisted CLI draft goal from explicit `/goal` prompts so fallback tools have the arguments they need.
- Recognizes prefixed goal tool names and reports partial CLI-only or VS Code-only installs more clearly.

## 1.1.7

- Recognizes existing Copilot CLI goal hooks written with `~`, `$HOME`, absolute paths, or wrapper commands.
- Reports disabled CLI hooks, duplicate goal hook entries, and stale drift hooks in the status view.
- Installs the updated runtime that avoids adding duplicate direct hooks when a composite hook already runs `goal-context.sh`.

## 1.1.6

- Makes drift recovery non-deadlocking by default: critical drift now injects a recovery reminder while allowing the tool call.
- Resets VS Code Chat drift accounting at each new user turn.
- Installs the updated runtime that removes stale Copilot CLI drift hooks during local setup.

## 1.1.5

- Creates persisted draft goals from explicit `/goal` prompts in VS Code Chat instead of relying only on agent instructions.
- Loads one unambiguous same-directory goal on explicit continuation in VS Code Chat.
- Installs and checks the `UserPromptSubmit` hook for the VS Code Chat adapter.
- Replaces installed local runtime snapshots during updates so stale files from older releases do not remain active.

## 1.1.4

- Strengthens blocked-stop behavior with a hard continuation directive.
- Treats alternate stop payloads such as `finishReason`, `completionReason`, and `terminationReason` as stop attempts.
- Keeps CLI and VS Code Chat stop behavior aligned.

## 1.1.3

- Publishes from GitHub Actions automatically when a `v*` tag is pushed.
- Fails clearly when the Marketplace token secret is missing.
- Documents the `VSCE_PAT` setup and tag-based publish flow.

## 1.1.2

- Treats an empty VS Code profile config file as an empty config when installing or updating local files.
- Preserves the existing refusal behavior for malformed non-empty JSON.

## 1.1.1

- Prompts to update local Copilot runtime files when the extension bundle is newer than `~/.copilot/extensions/goal-system/`.
- Adds status report fields for extension version, installed runtime version, and runtime update state.
- Adds evidence-backed issue-resolution support for renamed, merged, duplicate, superseded, or clarified discovered issues.

## 1.1.0

- Adds `Copilot Goal System: Install Recommended Setup` for CLI plus VS Code Chat setup.
- Adds separate CLI-only and VS Code Chat-only install commands.
- Adds status checks for the VS Code Chat custom agent, hook config, and local goal tools.
- Updates walkthrough and Marketplace copy for VS Code Copilot Chat preview support.

## 1.0.2

- Adds a compact status bar item for installed, missing, installing, and error states.
- Adds `Copilot Goal System: Open Setup Walkthrough`.
- Improves first-run onboarding with less repeated notification behavior.
- Renames Command Palette entries for quicker scanning.
- Adds settings for first-run prompts and status bar visibility.

## 1.0.1

- Adds a first-run setup prompt after the extension is installed in VS Code.
- Clarifies Marketplace documentation for install behavior, commands, requirements, and updates.
- Adds Marketplace author metadata.
- Generates the bundled goal-system package from the repository source during packaging.

## 1.0.0

- Initial Marketplace release.
- Installs Copilot Goal System into the local GitHub Copilot CLI profile.
- Adds install, status, docs, installed-files, state-folder, and runtime-prompt commands.
- Bundles the goal system package, skill, hook helper, installer, docs, tests, and E2E fixture.
