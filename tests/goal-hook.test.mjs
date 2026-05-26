import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const hookPath = path.resolve("hooks/goal-context.sh");

async function runHook(input, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", [hookPath], {
      env: { ...process.env, ...env },
      cwd: path.resolve("."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`hook exited ${code}${signal ? ` signal ${signal}` : ""}: ${stderr}${stdout ? `\nstdout: ${stdout}` : ""}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeGoal(home, sessionId, cwd, patch = {}) {
  const stateRoot = path.join(home, ".copilot", "session-state", "goal-system");
  const sessionDir = path.join(stateRoot, "by-session");
  const workspaceDir = path.join(home, ".copilot", "session-state", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const goal = {
    id: patch.id || "goal-1",
    sessionId,
    cwd,
    objective: "Make goal mode reliable",
    completionStatus: "active",
    doneSoFar: ["inspected files"],
    remaining: ["run verification"],
    blockers: [],
    validationProof: [],
    updatedAt: "2026-05-06T07:00:00.000Z",
    createdAt: "2026-05-06T07:00:00.000Z",
    ...patch,
  };
  await writeFile(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(goal, null, 2));
  await writeFile(path.join(workspaceDir, "goal-state.json"), JSON.stringify(goal, null, 2));
  return { goal, stateRoot };
}

test("subagentStart injects a main-session-only boundary even when camelCase payloads omit hook_event_name", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-subagent`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-subagent", cwd, {
    id: "goal-hidden-from-subagent",
    objective: "Private main-session objective",
  });

  const result = await runHook(
    {
      sessionId: "session-subagent",
      timestamp: Date.now(),
      cwd,
      agentName: "developer",
      agentDescription: "does bounded work",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.additionalContext, /main-session only/);
  assert.match(parsed.additionalContext, /Do not use goal_system_/);
  assert.doesNotMatch(parsed.additionalContext, /goal-hidden-from-subagent/);
  assert.doesNotMatch(parsed.additionalContext, /Private main-session objective/);

  await rm(home, { recursive: true, force: true });
});

test("sessionStart without an active goal injects local session context", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-empty-session`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });

  const result = await runHook(
    {
      sessionId: "session-empty",
      timestamp: Date.now(),
      cwd,
      source: "startup",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.additionalContext, /Goal System for Copilot CLI is available/);
  assert.match(parsed.additionalContext, /Session ID: session-empty/);
  assert.match(parsed.additionalContext, /CWD: /);
  assert.match(parsed.additionalContext, /goalctl\.mjs/);
  assert.match(parsed.additionalContext, /goal_system_open/);

  await rm(home, { recursive: true, force: true });
});

test("postToolUse records tool history for active CLI goals", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-posttool`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-posttool", cwd);

  const result = await runHook(
    {
      hook_event_name: "postToolUse",
      sessionId: "session-posttool",
      timestamp: Date.now(),
      cwd,
      toolName: "readFile",
      toolResult: "ok",
    },
    { HOME: home }
  );

  assert.equal(result.stdout, "");
  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-posttool.json"), "utf8"));
  assert.equal(goal.history.at(-1).type, "tool");
  assert.equal(goal.history.at(-1).note, "readFile");

  await rm(home, { recursive: true, force: true });
});

test("preToolUse warns on stale CLI goal state without blocking useful work", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-pretool-warn`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-pretool", cwd, {
    history: Array.from({ length: 3 }, (_value, index) => ({
      at: `2026-05-06T07:0${index}:00.000Z`,
      type: "tool",
      note: `readFile-${index}`,
    })),
  });

  const result = await runHook(
    {
      hook_event_name: "preToolUse",
      sessionId: "session-pretool",
      timestamp: Date.now(),
      cwd,
      toolName: "bash",
      toolArgs: { command: "npm test" },
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.additionalContext, /Goal-state drift warning/);
  assert.doesNotMatch(result.stdout, /"block"/);

  await rm(home, { recursive: true, force: true });
});

test("preToolUse can hard-block stale CLI drift when explicitly enabled", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-pretool-block`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-pretool-block", cwd, {
    history: Array.from({ length: 5 }, (_value, index) => ({
      at: `2026-05-06T07:0${index}:00.000Z`,
      type: "tool",
      note: `readFile-${index}`,
    })),
  });

  const result = await runHook(
    {
      hook_event_name: "preToolUse",
      sessionId: "session-pretool-block",
      timestamp: Date.now(),
      cwd,
      toolName: "bash",
      toolArgs: { command: "npm test" },
    },
    { HOME: home, GOAL_SYSTEM_HARD_DRIFT_BLOCK: "1" }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Goal-state drift guard/);

  await rm(home, { recursive: true, force: true });
});

test("userPromptSubmitted creates a CLI draft goal on explicit goal activation", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-cli-activate`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });

  const result = await runHook(
    {
      sessionId: "session-cli-activate",
      timestamp: Date.now(),
      cwd,
      prompt: "/goal fix the release flow end to end",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.additionalContext, /persisted draft goal was created/i);
  assert.match(parsed.additionalContext, /Session ID: session-cli-activate/);
  assert.match(parsed.additionalContext, /goalctl/);
  assert.match(parsed.additionalContext, /goal_system_update/);

  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-cli-activate.json"), "utf8"));
  assert.equal(goal.objective, "fix the release flow end to end");
  assert.equal(goal.completionStatus, "draft");
  assert.equal(goal.sessionId, "session-cli-activate");
  assert.equal(goal.cwd, await realpath(cwd));
  assert.match(goal.remaining.join("\n"), /Inspect the real environment/);

  const stateDir = await stat(path.join(home, ".copilot", "session-state", "goal-system", "by-session"));
  const goalFile = await stat(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-cli-activate.json"));
  assert.equal(stateDir.mode & 0o777, 0o700);
  assert.equal(goalFile.mode & 0o777, 0o600);

  await rm(home, { recursive: true, force: true });
});

test("CLI hook stores goal state under COPILOT_HOME when configured", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-copilot-home`);
  const copilotHome = path.join(home, "custom-copilot");
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });

  const result = await runHook(
    {
      sessionId: "session-custom-home",
      timestamp: Date.now(),
      cwd,
      prompt: "/goal verify custom profile updates",
    },
    { HOME: home, COPILOT_HOME: copilotHome }
  );

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.additionalContext, /persisted draft goal was created/i);

  const goal = JSON.parse(await readFile(path.join(copilotHome, "session-state", "goal-system", "by-session", "session-custom-home.json"), "utf8"));
  assert.equal(goal.objective, "verify custom profile updates");
  await assert.rejects(readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-custom-home.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("agentStop blocks a premature stop while an active goal is still open", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-agentstop`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-main", cwd);

  const result = await runHook(
    {
      sessionId: "session-main",
      timestamp: Date.now(),
      cwd,
      transcriptPath: path.join(home, "transcript.jsonl"),
      stopReason: "end_turn",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /STOP BLOCKED|Active persisted goal is still open/);
  assert.match(parsed.reason, /Session ID: session-main/);
  assert.match(parsed.reason, /CWD: /);
  assert.match(parsed.reason, /hard continuation directive/);
  assert.match(parsed.reason, /goalctl status/);
  assert.match(parsed.reason, /goal_system_status/);
  assert.match(parsed.reason, /goal_system_update/);
  assert.match(parsed.reason, /goal_system_close, or run goalctl close, only when/);

  await rm(home, { recursive: true, force: true });
});

test("agentStop treats alternate finish reason payloads as stop attempts", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-finishreason`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-finishreason", cwd, {
    id: "goal-finishreason",
    remaining: ["continue after nonstandard stop reason"],
  });

  const result = await runHook(
    {
      sessionId: "session-finishreason",
      timestamp: Date.now(),
      cwd,
      finishReason: "stop",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Goal ID: goal-finishreason/);
  assert.match(parsed.reason, /hard continuation directive/);
  assert.match(parsed.reason, /continue after nonstandard stop reason/);

  await rm(home, { recursive: true, force: true });
});

test("agentStop blocks only the current session goal when multiple sessions share a directory", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-agentstop-isolation`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-a", cwd, {
    id: "goal-a",
    objective: "Objective A",
    remaining: ["finish A"],
  });
  await writeGoal(home, "session-b", cwd, {
    id: "goal-b",
    objective: "Objective B",
    remaining: ["finish B"],
  });

  const result = await runHook(
    {
      sessionId: "session-a",
      timestamp: Date.now(),
      cwd,
      transcriptPath: path.join(home, "transcript.jsonl"),
      stopReason: "end_turn",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Goal ID: goal-a/);
  assert.match(parsed.reason, /Objective: Objective A/);
  assert.match(parsed.reason, /Remaining: finish A/);
  assert.doesNotMatch(parsed.reason, /goal-b/);
  assert.doesNotMatch(parsed.reason, /Objective B/);
  assert.doesNotMatch(parsed.reason, /finish B/);

  await rm(home, { recursive: true, force: true });
});

test("agentStop ignores a terminal blocked goal with closedAt", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-closedblocked`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-closed-blocked", cwd, {
    completionStatus: "blocked",
    blockers: ["external credential unavailable"],
    closedAt: "2026-05-06T08:00:00.000Z",
  });

  const result = await runHook(
    {
      sessionId: "session-closed-blocked",
      timestamp: Date.now(),
      cwd,
      transcriptPath: path.join(home, "transcript.jsonl"),
      stopReason: "end_turn",
    },
    { HOME: home }
  );

  assert.equal(result.stdout, "");

  await rm(home, { recursive: true, force: true });
});

test("notification injects compact active-goal context", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-notification`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-notification", cwd);

  const result = await runHook(
    {
      sessionId: "session-notification",
      timestamp: Date.now(),
      cwd,
      hook_event_name: "Notification",
      message: "Agent is idle",
      notification_type: "agent_idle",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.additionalContext, /Open persisted main-session goal/);
  assert.match(parsed.additionalContext, /Goal ID: goal-1/);

  await rm(home, { recursive: true, force: true });
});

test("preCompact writes a compact snapshot side effect for context recovery", async () => {
  const home = path.join(tmpdir(), `goal-hook-${process.pid}-compact`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const { stateRoot } = await writeGoal(home, "session-compact", cwd);

  const result = await runHook(
    {
      sessionId: "session-compact",
      timestamp: Date.now(),
      cwd,
      transcriptPath: path.join(home, "transcript.jsonl"),
      trigger: "manual",
      customInstructions: "compact now",
    },
    { HOME: home }
  );

  assert.equal(result.stdout, "");
  const snapshot = await readFile(path.join(stateRoot, "compact", "session-compact.txt"), "utf8");
  assert.match(snapshot, /Goal ID: goal-1/);
  assert.match(snapshot, /Remaining: run verification/);
  const compactDir = await stat(path.join(stateRoot, "compact"));
  const snapshotFile = await stat(path.join(stateRoot, "compact", "session-compact.txt"));
  assert.equal(compactDir.mode & 0o777, 0o700);
  assert.equal(snapshotFile.mode & 0o777, 0o600);

  await rm(home, { recursive: true, force: true });
});
