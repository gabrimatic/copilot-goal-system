# Goal-System Reliability E2E Prompt

Use this prompt inside Copilot CLI after installing the goal system. It is intentionally a real task with a failing test, not a hardcoded fact assertion.

```text
/goal
You are testing the installed goal system itself. Use the sample project at tests/fixtures/sample-goal-project as the target. This is an execution goal, not a review.

Destination:
Make the sample project pass its real test suite while proving the goal system behaves correctly.

Requirements:
1. Open or use the persisted Active Goal state.
2. Inspect the sample project files before changing anything.
3. Run the test suite and capture the real failure.
4. Fix every discovered in-scope issue in the sample project.
5. Rerun the test suite and capture the real passing result.
6. Update the persisted goal state with inspection evidence, discovered issues, resolved issues, validation proof, verification results, requirement coverage, and completion audit.
7. Attempt to close the goal only after proof exists.
8. Do not invent facts, do not skip tests, and do not mark complete before the tests pass.
9. Do not use subagents for goal_system_* tools.
10. Final answer must include exact commands run and whether the goal was closed complete.

Must not regress:
- Do not remove tests.
- Do not weaken assertions.
- Do not change package scripts to hide the failure.
- Do not hardcode the test runner output.

Validation:
- Run `npm test` from tests/fixtures/sample-goal-project after the fix.
- Use goal_system_status before closing.
- goal_system_close must refuse completion if evidence is missing; if it refuses, fix the goal state and try again only after real evidence exists.
```
