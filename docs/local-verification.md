# Local Verification

Run local verification before changing the installer, hook behavior, goal state, or completion gates.

## Static checks

```bash
npm run check
```

Covered:

- `node --check extension.mjs`
- `node --check lib/goal-core.mjs`
- `node --check scripts/install.mjs`
- shell syntax checks
- JSON validation for manifests and hook config

## Test suite

```bash
npm test
```

Covered:

- session ID sanitization
- activation prompt trimming
- sensitive value redaction
- append-safe evidence merging
- intentional clearing of `remaining` and `blockers`
- refusal of weak completion evidence
- unresolved discovered issue blocking
- closed terminal blocked-goal handling
- multi-session and multi-directory state isolation
- same-directory ambiguity detection
- compact prompt notes
- no raw history leakage in summaries
- hook quiet exit with no goal
- subagentStart boundary-only context
- agentStop blocking while a goal remains open
- agentStop ignoring terminal blocked goals
- preCompact snapshot side effect
- drift blocking helper behavior

## Fixture sanity check

```bash
cd tests/fixtures/sample-goal-project
npm test
```

Expected result: fail before an agent fixes it.

The failure is intentional. It proves the runtime E2E prompt is asking Copilot to do real work, not recite hardcoded facts.
