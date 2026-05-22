import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const hookPath = path.resolve("adapters/vscode-chat/hook-runner.mjs");

async function runHook(input, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
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
        reject(new Error(`VS Code hook exited ${code}${signal ? ` signal ${signal}` : ""}: ${stderr}${stdout ? `\nstdout: ${stdout}` : ""}`));
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
  const cwdSessionDir = path.join(stateRoot, "by-cwd-session");
  const workspaceDir = path.join(home, ".copilot", "session-state", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwdSessionDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const goal = {
    version: 3,
    id: patch.id || "goal-vscode-1",
    sessionId,
    cwd,
    objective: "Make VS Code goal mode reliable",
    completionStatus: "active",
    doneSoFar: ["read official VS Code hook docs"],
    remaining: ["finish adapter verification"],
    blockers: [],
    validationProof: [],
    history: [],
    updatedAt: "2026-05-07T07:00:00.000Z",
    createdAt: "2026-05-07T07:00:00.000Z",
    ...patch,
  };
  await writeFile(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(goal, null, 2));
  const cwdHash = createHash("sha1").update(path.resolve(cwd)).digest("hex");
  await writeFile(path.join(cwdSessionDir, `${cwdHash}--${sessionId}.json`), JSON.stringify(goal, null, 2));
  await writeFile(path.join(workspaceDir, "goal-state.json"), JSON.stringify(goal, null, 2));
  return { goal, stateRoot };
}

test("VS Code SubagentStart injects only the main-session boundary", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-subagent`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-subagent", cwd, {
    id: "private-goal-id",
    objective: "Private objective",
  });

  const result = await runHook(
    {
      hookEventName: "SubagentStart",
      sessionId: "session-subagent",
      cwd,
      agent_id: "subagent-1",
      agent_type: "Plan",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SubagentStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /main-session only/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Do not use goal_system_/);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /private-goal-id/);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /Private objective/);

  await rm(home, { recursive: true, force: true });
});

test("VS Code Stop blocks only the current session when an active goal is open", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-stop`);
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
      hookEventName: "Stop",
      sessionId: "session-a",
      cwd,
      stop_hook_active: false,
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(parsed.hookSpecificOutput.decision, "block");
  assert.match(parsed.hookSpecificOutput.reason, /Goal ID: goal-a/);
  assert.match(parsed.hookSpecificOutput.reason, /Objective: Objective A/);
  assert.match(parsed.hookSpecificOutput.reason, /hard continuation directive/);
  assert.match(parsed.hookSpecificOutput.reason, /goal_system_update/);
  assert.doesNotMatch(parsed.hookSpecificOutput.reason, /goal-b/);
  assert.doesNotMatch(parsed.hookSpecificOutput.reason, /Objective B/);

  await rm(home, { recursive: true, force: true });
});

test("VS Code Stop treats alternate finish reason payloads as stop attempts", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-finishreason`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-finishreason", cwd, {
    id: "goal-vscode-finishreason",
    objective: "Objective finish reason",
    remaining: ["continue after alternate finish reason"],
  });

  const result = await runHook(
    {
      sessionId: "session-finishreason",
      cwd,
      finishReason: "stop",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(parsed.hookSpecificOutput.decision, "block");
  assert.match(parsed.hookSpecificOutput.reason, /Goal ID: goal-vscode-finishreason/);
  assert.match(parsed.hookSpecificOutput.reason, /hard continuation directive/);
  assert.match(parsed.hookSpecificOutput.reason, /continue after alternate finish reason/);

  await rm(home, { recursive: true, force: true });
});

test("VS Code PreCompact writes a compact snapshot through the shared goal store", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-compact`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const { stateRoot } = await writeGoal(home, "session-compact", cwd);

  const result = await runHook(
    {
      hookEventName: "PreCompact",
      sessionId: "session-compact",
      cwd,
      trigger: "auto",
    },
    { HOME: home }
  );

  assert.equal(result.stdout, "{\"continue\":true}");
  const snapshotText = await readFile(path.join(stateRoot, "compact", "session-compact.txt"), "utf8");
  assert.match(snapshotText, /Goal ID: goal-vscode-1/);
  assert.match(snapshotText, /Remaining: finish adapter verification/);
  const snapshot = JSON.parse(await readFile(path.join(stateRoot, "compact", "session-compact.txt.json"), "utf8"));
  assert.match(snapshot.snapshot, /Goal ID: goal-vscode-1/);
  assert.match(snapshot.snapshot, /Remaining: finish adapter verification/);

  await rm(home, { recursive: true, force: true });
});

test("VS Code UserPromptSubmit hydrates one unambiguous same-directory goal on explicit continue", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-continue`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "previous-session", cwd, {
    id: "goal-to-continue",
    objective: "Continue this exact goal",
    remaining: ["finish continuation support"],
  });

  const result = await runHook(
    {
      hookEventName: "UserPromptSubmit",
      sessionId: "new-session",
      cwd,
      prompt: "continue the active goal",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.continue, true);
  assert.match(parsed.systemMessage, /single unambiguous same-directory goal was loaded/);
  assert.match(parsed.systemMessage, /Goal ID: goal-to-continue/);
  assert.match(parsed.systemMessage, /Continue this exact goal/);

  const hydrated = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "new-session.json"), "utf8"));
  assert.equal(hydrated.id, "goal-to-continue");
  assert.equal(hydrated.sessionId, "new-session");

  await rm(home, { recursive: true, force: true });
});

test("VS Code UserPromptSubmit creates a persisted draft goal on explicit activation", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-activate`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });

  const result = await runHook(
    {
      hookEventName: "UserPromptSubmit",
      sessionId: "session-activate",
      cwd,
      prompt: "/goal fix the release flow end to end",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.continue, true);
  assert.match(parsed.systemMessage, /persisted draft goal was created/i);
  assert.match(parsed.systemMessage, /inspect the real environment/i);

  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-activate.json"), "utf8"));
  assert.equal(goal.objective, "fix the release flow end to end");
  assert.equal(goal.completionStatus, "draft");
  assert.match(goal.remaining.join("\n"), /Inspect the real environment/);

  await rm(home, { recursive: true, force: true });
});

test("VS Code PreToolUse warns but allows critical drift so recovery tools never deadlock", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-drift`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-drift", cwd, {
    history: Array.from({ length: 5 }, (_, index) => ({
      at: `2026-05-07T07:0${index}:00.000Z`,
      type: "tool",
      note: `read: file-${index}.js`,
    })),
  });

  const result = await runHook(
    {
      hookEventName: "PreToolUse",
      sessionId: "session-drift",
      cwd,
      tool_name: "runTerminalCommand",
      tool_input: { command: "npm test" },
      tool_use_id: "tool-1",
    },
    { HOME: home }
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(parsed.hookSpecificOutput.additionalContext, /Goal-state drift guard/);
  assert.doesNotMatch(result.stdout, /"deny"/);

  await rm(home, { recursive: true, force: true });
});

test("VS Code UserPromptSubmit starts a fresh drift window for the next turn", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-turn-reset`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-turn-reset", cwd, {
    history: Array.from({ length: 5 }, (_, index) => ({
      at: `2026-05-07T07:0${index}:00.000Z`,
      type: "tool",
      note: `read: stale-${index}.js`,
    })),
  });

  const promptResult = await runHook(
    {
      hookEventName: "UserPromptSubmit",
      sessionId: "session-turn-reset",
      cwd,
      prompt: "keep going",
    },
    { HOME: home }
  );

  const promptParsed = JSON.parse(promptResult.stdout);
  assert.equal(promptParsed.continue, true);

  const toolResult = await runHook(
    {
      hookEventName: "PreToolUse",
      sessionId: "session-turn-reset",
      cwd,
      tool_name: "runTerminalCommand",
      tool_input: { command: "npm test" },
      tool_use_id: "tool-after-turn",
    },
    { HOME: home }
  );

  assert.equal(toolResult.stdout, "{\"continue\":true}");

  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-turn-reset.json"), "utf8"));
  assert.equal(goal.history.at(-1).type, "turn");

  await rm(home, { recursive: true, force: true });
});

test("VS Code PostToolUse records non-subagent tool history in the current session goal", async () => {
  const home = path.join(tmpdir(), `goal-vscode-hook-${process.pid}-posttool`);
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  await writeGoal(home, "session-posttool", cwd);

  const result = await runHook(
    {
      hookEventName: "PostToolUse",
      sessionId: "session-posttool",
      cwd,
      tool_name: "readFile",
      tool_input: { path: "src/index.ts" },
      tool_use_id: "tool-2",
      tool_response: "ok",
    },
    { HOME: home }
  );

  assert.equal(result.stdout, "{\"continue\":true}");
  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-posttool.json"), "utf8"));
  assert.equal(goal.history.at(-1).type, "tool");
  assert.match(goal.history.at(-1).note, /readFile/);

  await rm(home, { recursive: true, force: true });
});
