import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GoalStore,
  buildDriftEnforcement,
  createGoalRecord,
  formatGoalSummary,
  getOutstandingIssues,
  isGoalSystemToolName,
  isLikelySubagentInvocation,
  isOpenGoal,
  mergeGoal,
  redactSensitiveText,
  safeSessionId,
  shouldEnforceDrift,
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

test("redaction removes sensitive values from persisted previews and history", () => {
  const input = "email person@example.com token=abc123 password: hunter2 ghp_abcdefghijklmnopqrstuvwxyz123456";
  const output = redactSensitiveText(input);
  assert.doesNotMatch(output, /person@example\.com/);
  assert.doesNotMatch(output, /hunter2/);
  assert.doesNotMatch(output, /ghp_/);
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
  const compactJson = await readFile(path.join(root, "goals", "compact", "session-a.txt.json"), "utf8");
  assert.match(compactJson, /first goal/);

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

test("drift enforcement blocks non-goal tools after the configured threshold", () => {
  assert.equal(isGoalSystemToolName("goal_system_update"), true);
  assert.equal(isGoalSystemToolName("bash"), false);

  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "bash", driftCount: 5, threshold: 5, isSubagent: false }),
    true
  );
  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "goal_system_update", driftCount: 99, threshold: 5, isSubagent: false }),
    false
  );
  assert.equal(
    shouldEnforceDrift({ hasActiveGoal: true, toolName: "bash", driftCount: 99, threshold: 5, isSubagent: true }),
    false
  );

  assert.match(buildDriftEnforcement(7, 5), /7 tool calls/);
  assert.match(buildDriftEnforcement(7, 5), /goal_system_update/);
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
