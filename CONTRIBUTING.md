# Contributing

Bug fixes, hook hardening, installer improvements, better docs, and adapter research are welcome.

## Dev setup

```bash
git clone https://github.com/gabrimatic/copilot-goal-system.git
cd copilot-goal-system
npm ci
npm run verify
```

Install into a temporary Copilot home before testing against your real profile:

```bash
tmp_home="$(mktemp -d)"
HOME="$tmp_home" ./install.sh
find "$tmp_home/.copilot" -maxdepth 4 -type f | sort
rm -rf "$tmp_home"
```

## Architecture

```text
extension.mjs                 # Copilot SDK session, hooks, and goal_system_* tools
lib/goal-core.mjs             # Pure state, validation, formatting, persistence
hooks/goal-context.sh         # CLI lifecycle hook helper
skills/goal/SKILL.md          # Main-session goal-mode behavior contract
scripts/install.mjs           # Installer and settings merge logic
tests/                        # Unit and hook smoke tests
docs/                         # Install, architecture, requirements, portability
```

## Change rules

- Keep goal behavior manual and main-session only.
- Do not weaken completion gates to make tests easier.
- Do not remove drift blocking or stop-time blocking without replacing them with stronger enforcement.
- Keep persisted state compact and redacted.
- Preserve existing user settings when updating installer behavior.
- Update docs when changing install paths, hook events, tool schemas, or completion requirements.

## Tests

```bash
npm run verify
node --test tests/goal-core.test.mjs
node --test tests/goal-hook.test.mjs
```

The sample fixture under `tests/fixtures/sample-goal-project` is intentionally broken. Do not fix it in normal development; it exists so a live Copilot goal can prove it inspected, fixed, tested, updated state, and closed with evidence.

## PR checklist

- `npm run verify` passes.
- Installer works in a temporary `HOME`.
- No secrets, tokens, private paths, or personal local state are committed.
- README and docs match the actual behavior.
- PR description explains what changed, why, and how it was verified.

## Vulnerability reporting

See [SECURITY.md](SECURITY.md). Do not open public issues for security vulnerabilities.
