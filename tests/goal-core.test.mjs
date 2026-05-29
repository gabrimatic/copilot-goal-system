import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACTIVATION_REGEX,
  GoalStore,
  appendGoalHistory,
  buildDriftEnforcement,
  buildStopContinuationDirective,
  countToolDrift,
  createGoalRecord,
  formatGoalSummary,
  getOutstandingIssues,
  isGoalSystemToolName,
  isGoalSystemControlPlaneText,
  isLikelySubagentInvocation,
  isOpenGoal,
  mergeGoal,
  normalizeCwd,
  redactSensitiveText,
  safeSessionId,
  shouldEnforceDrift,
  summarizeToolUse,
  trimmedPromptObjective,
  validateGoalCompletion,
} from "../lib/goal-core.mjs";

test("safeSessionId prevents path traversal", () => {
  assert.equal(safeSessionId("../evil/session"), ".._evil_session");
  assert.equal(safeSessionId("abc-123_DEF.xyz"), "abc-123_DEF.xyz");
});

test("activation prompt objective is trimmed without inventing facts", () => {
  assert.equal(trimmedPromptObjective("/goal polish every page"), "polish every page");
  assert.equal(trimmedPromptObjective("new goal: fix tests"), "fix tests");
});

test("activation regex recognizes slash-command and natural-language goal prompts", () => {
  assert.equal(ACTIVATION_REGEX.test("/goal polish every page"), true);
  assert.equal(ACTIVATION_REGEX.test("please use /goal and fix the repo"), true);
  assert.equal(ACTIVATION_REGEX.test("keep working until this is done"), true);
  assert.equal(ACTIVATION_REGEX.test("ordinary one-off question"), false);
});

test("normalizeCwd canonicalizes existing symlinked directories", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-normalize-cwd-"));
  const realDir = await mkdtemp(path.join(home, "real-"));
  const linkDir = path.join(home, "link");
  await symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");

  assert.equal(normalizeCwd(linkDir), normalizeCwd(await realpath(realDir)));

  await rm(home, { recursive: true, force: true });
});

test("redaction removes sensitive values from persisted previews and history", () => {
  const input = "email person@example.com token=abc123 password: hunter2 ghp_abcdefghijklmnopqrstuvwxyz123456";
  const output = redactSensitiveText(input);
  assert.doesNotMatch(output, /person@example\.com/);
  assert.doesNotMatch(output, /hunter2/);
  assert.doesNotMatch(output, /ghp_/);
});

test("stop continuation directive forces real continuation without issue-string bypass", () => {
  const goal = createGoalRecord(
    {
      objective: "Finish the release safely",
      remaining: ["verify Marketplace publish", "update local runtime"],
      blockers: ["waiting for Marketplace propagation"],
      completionStatus: "active",
    },
    "session:stop",
    "/tmp/project"
  );

  const directive = buildStopContinuationDirective(goal);
  assert.match(directive, /STOP BLOCKED/);
  assert.match(directive, /hard continuation directive/);
  assert.match(directive, /Call goal_system_status/);
  assert.match(directive, /goal_system_checkpoint/);
  assert.match(directive, /goal_system_finish/);
  assert.match(directive, /goalctl checkpoint/);
  assert.match(directive, /goalctl finish/);
  assert.match(directive, /do not bypass the guard by copying unresolved issue text/);
});

test("tool drift is scoped to the current user turn", () => {
  const goal = createGoalRecord(
    {
      objective: "Keep a long-running task aligned",
      remaining: ["continue implementation"],
    },
    "session:turn-drift",
    "/tmp/project"
  );

  const withOlderTools = ["read: src/a.js", "bash: npm test", "view: src/b.js", "rg: TODO", "bash: git diff"].reduce(
    (current, note) => appendGoalHistory(current, "tool", note),
    goal
  );
  const nextTurn = appendGoalHistory(withOlderTools, "turn", "User prompt submitted");
  const currentTurn = appendGoalHistory(nextTurn, "tool", "read: src/current.js");

  assert.equal(countToolDrift(withOlderTools), 5);
  assert.equal(countToolDrift(currentTurn), 1);
});

test("drift enforcement is opt-in so unavailable update tools cannot deadlock a session", () => {
  assert.equal(
    shouldEnforceDrift({
      hasActiveGoal: true,
      toolName: "bash",
      driftCount: 5,
      threshold: 5,
      hardBlockDrift: false,
      canRecoverWithGoalUpdate: false,
    }),
    false
  );
  assert.equal(
    shouldEnforceDrift({
      hasActiveGoal: true,
      toolName: "bash",
      driftCount: 5,
      threshold: 5,
      hardBlockDrift: true,
      canRecoverWithGoalUpdate: false,
    }),
    false
  );
  assert.equal(
    shouldEnforceDrift({
      hasActiveGoal: true,
      toolName: "bash",
      driftCount: 5,
      threshold: 5,
      hardBlockDrift: true,
      canRecoverWithGoalUpdate: true,
    }),
    true
  );
});

test("mergeGoal appends durable evidence but lets remaining and blockers be cleared", () => {
  const goal = createGoalRecord(
    {
      objective: "Make the goal system reliable",
      requirements: ["persist state"],
      inspectionEvidence: ["read extension.mjs"],
      doneSoFar: ["mapped files"],
      remaining: ["write tests", "fix hook"],
      blockers: ["sdk runtime not launched"],
    },
    "session:one",
    "/tmp/project"
  );

  const next = mergeGoal(goal, {
    requirements: ["survive compaction"],
    inspectionEvidence: ["read hook payload docs"],
    doneSoFar: ["added failing tests"],
    remaining: [],
    blockers: [],
  });

  assert.deepEqual(next.requirements, ["persist state", "survive compaction"]);
  assert.deepEqual(next.inspectionEvidence, ["read extension.mjs", "read hook payload docs"]);
  assert.deepEqual(next.doneSoFar, ["mapped files", "added failing tests"]);
  assert.deepEqual(next.remaining, []);
  assert.deepEqual(next.blockers, []);
});

test("completion validation requires real proof, no remaining work, and resolved discovered issues", () => {
  const goal = createGoalRecord(
    {
      objective: "Ship reliable goal mode",
      requirements: ["inspect first", "verify before close"],
      inspectionEvidence: ["read current implementation"],
      discoveredIssues: ["hook does not handle agentStop"],
      resolvedIssues: ["hook does not handle agentStop"],
      validationProof: ["node --test passed"],
      verificationResults: ["npm run verify passed"],
      requirementCoverage: ["inspect first covered by inspection evidence", "verify before close covered by npm run verify"],
      doneSoFar: ["implemented strict goal hooks"],
      remaining: [],
      blockers: [],
      completionAudit: ["all discovered in-scope issues are resolved"],
    },
    "session:two",
    "/tmp/project"
  );

  assert.deepEqual(validateGoalCompletion(goal), []);

  const incomplete = mergeGoal(goal, {
    discoveredIssues: ["completion can be faked"],
    remaining: ["run shell hook smoke tests"],
  });

  assert.match(validateGoalCompletion(incomplete).join("\n"), /Remaining work is still recorded/);
  assert.match(validateGoalCompletion(incomplete).join("\n"), /Discovered issues remain unresolved/);
});

test("dynamic horizon tasks can grow discovered issues and must resolve all before completion", () => {
  const initialIssues = ["issue 1", "issue 2", "issue 3"];
  const expandedIssues = Array.from({ length: 10 }, (_value, index) => `issue ${index + 1}`);

  const goal = createGoalRecord(
    {
      objective: "Finish the whole horizon task",
      requirements: ["fix every in-scope issue", "prove completion"],
      inspectionEvidence: ["read failing test output"],
      discoveredIssues: initialIssues,
      doneSoFar: ["mapped the first failures"],
      remaining: initialIssues,
    },
    "session:horizon",
    "/tmp/project"
  );

  const expanded = mergeGoal(goal, {
    inspectionEvidence: ["inspected deeper runtime path"],
    discoveredIssues: expandedIssues,
    doneSoFar: ["found the larger issue set"],
    remaining: expandedIssues,
  });

  assert.deepEqual(expanded.discoveredIssues, expandedIssues);
  assert.deepEqual(expanded.remaining, expandedIssues);
  assert.deepEqual(expanded.doneSoFar, ["mapped the first failures", "found the larger issue set"]);
  assert.deepEqual(expanded.inspectionEvidence, ["read failing test output", "inspected deeper runtime path"]);
  assert.deepEqual(getOutstandingIssues(expanded), expandedIssues);
  assert.match(validateGoalCompletion(expanded).join("\n"), /Discovered issues remain unresolved/);

  const complete = mergeGoal(expanded, {
    resolvedIssues: expandedIssues,
    validationProof: ["npm run verify passed"],
    verificationResults: ["all targeted checks passed after fixes"],
    requirementCoverage: ["fix every in-scope issue covered by resolvedIssues", "prove completion covered by npm run verify"],
    doneSoFar: ["fixed all ten discovered issues"],
    remaining: [],
    blockers: [],
    completionAudit: ["no unresolved discovered issues, blockers, or remaining work"],
  });

  assert.deepEqual(getOutstandingIssues(complete), []);
  assert.deepEqual(validateGoalCompletion(complete), []);
});

test("evidence-backed issue resolutions can close renamed or merged discovered issues", () => {
  const goal = createGoalRecord(
    {
      objective: "Make closure audit smarter without weakening safety",
      requirements: ["do not require literal resolved issue strings", "keep completion proof strict"],
      inspectionEvidence: ["reproduced literal string mismatch in getOutstandingIssues"],
      discoveredIssues: [
        "ISSUE-001: close audit requires exact original issue text in resolvedIssues",
        "ISSUE-002: merged duplicate issues cannot be represented safely",
      ],
      resolvedIssues: ["implemented evidence-aware closure audit for renamed and merged issues"],
      issueResolutions: [
        {
          covers: ["ISSUE-001"],
          status: "resolved",
          resolution: "Added issue resolution coverage so the resolved issue wording can differ from the original discovered issue.",
          evidence: ["node --test tests/goal-core.test.mjs"],
        },
        {
          covers: ["ISSUE-002"],
          status: "merged",
          resolution: "Covered duplicate and merged issue closure through the same evidence-backed resolution map.",
          evidence: ["node --test tests/goal-core.test.mjs"],
        },
      ],
      validationProof: ["node --test tests/goal-core.test.mjs"],
      verificationResults: ["targeted goal-core tests passed"],
      requirementCoverage: [
        "do not require literal resolved issue strings covered by ISSUE-001 issueResolutions",
        "keep completion proof strict covered by required evidence on each issue resolution",
      ],
      doneSoFar: ["added closure audit coverage mapping"],
      remaining: [],
      blockers: [],
      completionAudit: ["all discovered issues are either directly resolved or covered by evidence-backed issueResolutions"],
    },
    "session:issue-resolution",
    "/tmp/project"
  );

  assert.deepEqual(getOutstandingIssues(goal), []);
  assert.deepEqual(validateGoalCompletion(goal), []);
});

test("issue resolutions do not permit wildcard or unevidenced completion claims", () => {
  const goal = createGoalRecord(
    {
      objective: "Reject fake issue closure",
      requirements: ["prevent cheating"],
      inspectionEvidence: ["read current issue list"],
      discoveredIssues: ["ISSUE-001: fake completion can pass", "ISSUE-002: wildcard closure hides remaining work"],
      issueResolutions: [
        {
          covers: ["all"],
          status: "resolved",
          resolution: "Everything is fixed.",
          evidence: ["done"],
        },
        {
          covers: ["ISSUE-001"],
          status: "resolved",
          resolution: "Claimed fixed without proof.",
          evidence: [],
        },
      ],
      validationProof: ["node --test tests/goal-core.test.mjs"],
      verificationResults: ["targeted test failed before fix"],
      requirementCoverage: ["prevent cheating covered by issue resolution validation"],
      doneSoFar: ["added negative test"],
      remaining: [],
      blockers: [],
      completionAudit: ["attempted fake closure should be refused"],
    },
    "session:issue-resolution-negative",
    "/tmp/project"
  );

  const failures = validateGoalCompletion(goal).join("\n");
  assert.match(failures, /Issue resolution 1 uses wildcard coverage/);
  assert.match(failures, /Issue resolution 2 has no evidence/);
  assert.match(failures, /Discovered issues remain unresolved/);
});

test("issue resolution target text does not count as original issue coverage", () => {
  const goal = createGoalRecord(
    {
      objective: "Keep issue resolution mapping honest",
      requirements: ["target issue cannot hide missing original issue reference"],
      inspectionEvidence: ["read issue resolution schema"],
      discoveredIssues: ["ISSUE-001: original issue still needs explicit coverage"],
      issueResolutions: [
        {
          target: "ISSUE-001: original issue still needs explicit coverage",
          status: "merged",
          resolution: "Merged into a broader resolved issue.",
          evidence: ["node --test tests/goal-core.test.mjs"],
        },
      ],
      validationProof: ["node --test tests/goal-core.test.mjs"],
      verificationResults: ["targeted test fails before fix"],
      requirementCoverage: ["target issue cannot hide missing original issue reference covered by validation"],
      doneSoFar: ["added target-only negative test"],
      remaining: [],
      blockers: [],
      completionAudit: ["target-only coverage should be refused"],
    },
    "session:issue-resolution-target",
    "/tmp/project"
  );

  const failures = validateGoalCompletion(goal).join("\n");
  assert.match(failures, /Issue resolution 1 does not name the discovered issue it covers/);
  assert.match(failures, /Discovered issues remain unresolved/);
});

test("closedAt makes terminal blocked goals stop loading as open goals", () => {
  const openBlocked = createGoalRecord(
    {
      objective: "Wait for credentials",
      completionStatus: "blocked",
      blockers: ["missing token"],
    },
    "session:block",
    "/tmp/project"
  );

  assert.equal(isOpenGoal(openBlocked), true);
  assert.equal(isOpenGoal({ ...openBlocked, closedAt: "2026-05-06T08:00:00.000Z" }), false);
});

test("GoalStore isolates same-directory goals by session and hydrates only unambiguous workspace continuation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "goal-store-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new GoalStore({ stateRoot: path.join(root, "goals"), workspaceStateRoot: workspaceRoot });
  await store.init();

  const cwd = path.join(root, "project");
  const first = createGoalRecord({ objective: "first goal" }, "session-a", cwd);
  const second = createGoalRecord({ objective: "second goal" }, "session-b", cwd);
  const third = createGoalRecord({ objective: "third goal" }, "session-c", cwd);

  await store.persistGoalRecord("session-a", cwd, first);
  await store.persistGoalRecord("session-b", cwd, second);
  await store.persistGoalRecord("session-c", cwd, third);

  const loadedFirst = await store.loadGoalRecord("session-a", cwd);
  const loadedSecond = await store.loadGoalRecord("session-b", cwd);
  const loadedThird = await store.loadGoalRecord("session-c", cwd);
  assert.equal(loadedFirst.goal.objective, "first goal");
  assert.equal(loadedSecond.goal.objective, "second goal");
  assert.equal(loadedThird.goal.objective, "third goal");

  const candidates = await store.loadWorkspaceGoalCandidates(cwd);
  assert.equal(candidates.length, 3);
  assert.deepEqual(store.pickSingleOpenWorkspaceGoal(candidates), { record: null, openCount: 3 });

  const closedSecond = mergeGoal(second, {
    completionStatus: "cancelled",
    remaining: [],
    blockers: [],
  });
  await store.persistGoalRecord("session-b", cwd, closedSecond);

  const closedThird = mergeGoal(third, {
    completionStatus: "cancelled",
    remaining: [],
    blockers: [],
  });
  await store.persistGoalRecord("session-c", cwd, closedThird);

  const single = store.pickSingleOpenWorkspaceGoal(await store.loadWorkspaceGoalCandidates(cwd));
  assert.equal(single.openCount, 1);
  assert.equal(single.record.goal.objective, "first goal");

  const snapshot = await store.writeCompactSnapshot("session-a", cwd, first);
  assert.match(snapshot, /Objective: first goal/);
  const compactText = await readFile(path.join(root, "goals", "compact", "session-a.txt"), "utf8");
  assert.match(compactText, /Objective: first goal/);
  const compactJson = await readFile(path.join(root, "goals", "compact", "session-a.txt.json"), "utf8");
  assert.match(compactJson, /first goal/);

  await rm(root, { recursive: true, force: true });
});

test("GoalStore treats the same open goal resumed in multiple sessions as one continuation candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "goal-store-resume-"));
  const store = new GoalStore({ stateRoot: path.join(root, "goals"), workspaceStateRoot: path.join(root, "workspace") });
  await store.init();

  const cwd = path.join(root, "project");
  const original = createGoalRecord({ objective: "resume me" }, "session-a", cwd);
  const resumed = { ...original, updatedAt: "2999-01-01T00:00:00.000Z" };

  await store.persistGoalRecord("session-a", cwd, original);
  await store.persistGoalRecord("session-b", cwd, resumed);

  const candidates = await store.loadWorkspaceGoalCandidates(cwd);
  assert.equal(candidates.length, 2);

  const single = store.pickSingleOpenWorkspaceGoal(candidates);
  assert.equal(single.openCount, 1);
  assert.equal(single.record.goal.id, original.id);
  assert.equal(single.record.goal.sessionId, "session-b");

  await rm(root, { recursive: true, force: true });
});

test("compact snapshots summarize large queues without mutating authoritative state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "goal-compact-"));
  const store = new GoalStore({ stateRoot: path.join(root, "goals"), workspaceStateRoot: path.join(root, "workspace") });
  await store.init();

  const cwd = path.join(root, "project");
  const remaining = Array.from({ length: 10 }, (_value, index) => `remaining ${index + 1}`);
  const goal = createGoalRecord(
    {
      objective: "Keep long-run state alive",
      doneSoFar: ["phase 1", "phase 2", "phase 3", "phase 4", "phase 5"],
      discoveredIssues: remaining,
      remaining,
    },
    "session-large",
    cwd
  );

  await store.persistGoalRecord("session-large", cwd, goal);
  const snapshot = await store.writeCompactSnapshot("session-large", cwd, goal);
  assert.match(snapshot, /Done so far: phase 1 \| phase 2 \| phase 3 \| phase 4 \| …/);
  assert.match(snapshot, /Remaining: remaining 1 \| remaining 2 \| remaining 3 \| remaining 4 \| …/);

  const loaded = await store.loadGoalRecord("session-large", cwd);
  assert.equal(loaded.goal.remaining.length, 10);
  assert.equal(loaded.goal.discoveredIssues.length, 10);

  await rm(root, { recursive: true, force: true });
});

test("strict drift enforcement blocks non-goal tools only when recovery is available", () => {
  assert.equal(isGoalSystemToolName("goal_system_update"), true);
  assert.equal(isGoalSystemToolName("vscode.goal_system_status"), true);
  assert.equal(isGoalSystemToolName("tool-goal_system_update"), true);
  assert.equal(isGoalSystemToolName("goal_system_close"), true);
  assert.equal(isGoalSystemToolName("goal_system_checkpoint"), true);
  assert.equal(isGoalSystemToolName("tool-goal_system_finish"), true);
  assert.equal(isGoalSystemToolName("bash"), false);

  assert.equal(
    shouldEnforceDrift({
      hasActiveGoal: true,
      toolName: "bash",
      driftCount: 5,
      threshold: 5,
      isSubagent: false,
      hardBlockDrift: true,
      canRecoverWithGoalUpdate: true,
    }),
    true
  );
  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "goal_system_update", driftCount: 99, threshold: 5, isSubagent: false }),
    false
  );
  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "tool-goal_system_update", driftCount: 99, threshold: 5, isSubagent: false }),
    false
  );
  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "goal_system_checkpoint", driftCount: 99, threshold: 5, isSubagent: false }),
    false
  );
  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "bash", driftCount: 99, threshold: 5, isSubagent: true }),
    false
  );

  assert.match(buildDriftEnforcement(7, 5), /7 tool calls/);
  assert.match(buildDriftEnforcement(7, 5), /goal_system_update/);
  assert.match(buildDriftEnforcement(7, 5), /goal_system_checkpoint/);
  assert.match(buildDriftEnforcement(7, 5), /goalctl checkpoint/);
});

test("shared tool history helpers support VS Code hook payloads", () => {
  assert.equal(summarizeToolUse({ toolName: "bash", toolArgs: { command: "npm test" } }), "bash: npm test");
  assert.equal(summarizeToolUse({ toolName: "apply_patch", toolArgs: {} }), "apply_patch");
  assert.equal(summarizeToolUse({ toolName: "rg", toolArgs: { pattern: "goal" } }), "rg: goal");
  assert.equal(summarizeToolUse({ tool_name: "runTerminalCommand", tool_input: { command: "npm test" } }), "runTerminalCommand");

  let goal = createGoalRecord({ objective: "Track drift" }, "session-drift", process.cwd());
  goal = appendGoalHistory(goal, "tool", "read: src/a.ts");
  goal = appendGoalHistory(goal, "tool", "read: src/b.ts");
  assert.equal(countToolDrift(goal), 2);

  goal = appendGoalHistory(goal, "update", "Goal state updated");
  goal = appendGoalHistory(goal, "tool", "read: src/c.ts");
  assert.equal(countToolDrift(goal), 1);
});

test("goal-system control-plane reads do not count as task inspection evidence", () => {
  assert.equal(isGoalSystemControlPlaneText("read: /Users/me/.copilot/extensions/goal-system/bin/goalctl.mjs"), true);

  const ordinaryGoal = createGoalRecord(
    {
      objective: "Fix the sample calculator",
      requirements: ["Make calculator tests pass"],
      doneSoFar: ["Claimed the task is done"],
      inspectionEvidence: ["Read ~/.copilot/extensions/goal-system/bin/goalctl.mjs"],
      validationProof: ["npm test passed"],
      verificationResults: ["npm test passed"],
      requirementCoverage: ["Calculator tests cover the requested behavior"],
      completionAudit: ["No remaining work and no blockers"],
      remaining: [],
      blockers: [],
    },
    "session-control-plane",
    process.cwd()
  );
  assert.match(validateGoalCompletion(ordinaryGoal).join("\n"), /control-plane files do not count/);

  const goalSystemGoal = createGoalRecord(
    {
      objective: "Fix the Copilot goal system command fallback",
      requirements: ["Inspect goalctl behavior"],
      doneSoFar: ["Verified command fallback"],
      inspectionEvidence: ["Read ~/.copilot/extensions/goal-system/bin/goalctl.mjs"],
      validationProof: ["npm test passed"],
      verificationResults: ["npm test passed"],
      requirementCoverage: ["Goalctl behavior inspected for the requested goal-system task"],
      completionAudit: ["No remaining work and no blockers"],
      remaining: [],
      blockers: [],
    },
    "session-control-plane-allowed",
    process.cwd()
  );
  assert.deepEqual(validateGoalCompletion(goalSystemGoal), []);
});

test("subagent detection keeps delegated workers outside goal ownership", () => {
  assert.equal(isLikelySubagentInvocation({ isSubagent: true }), true);
  assert.equal(isLikelySubagentInvocation({ subagent: true }), true);
  assert.equal(isLikelySubagentInvocation({ parentSessionId: "session-main" }), true);
  assert.equal(isLikelySubagentInvocation({ parent_session_id: "session-main" }), true);
  assert.equal(isLikelySubagentInvocation({ parentInvocationId: "invocation-main" }), true);
  assert.equal(isLikelySubagentInvocation({ parent_invocation_id: "invocation-main" }), true);
  assert.equal(isLikelySubagentInvocation({ sessionId: "session-main" }), false);
});

test("formatGoalSummary stays compact and includes the authoritative goal identity", () => {
  const goal = createGoalRecord(
    {
      objective: "Keep goal state compact",
      remaining: ["one", "two", "three", "four", "five", "six"],
    },
    "session:summary",
    "/tmp/project"
  );

  const summary = formatGoalSummary(goal);
  assert.match(summary, /Goal ID:/);
  assert.match(summary, /Objective: Keep goal state compact/);
  assert.match(summary, /Remaining: one | two | three | four | five |/);
});
