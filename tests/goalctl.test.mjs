import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const goalctl = path.resolve("bin/goalctl.mjs");

async function runGoalctl(args, options = {}) {
  return execFileAsync(process.execPath, [goalctl, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
    ...options,
  });
}

test("goalctl opens, updates, and reads persisted local state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goalctl-open-update-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home };

  const openResult = await runGoalctl([
    "open",
    "--session-id",
    "session-goalctl",
    "--cwd",
    cwd,
    "--objective",
    "Prove the local goal path",
    "--remaining",
    "Run tests",
  ], { env });
  assert.match(openResult.stdout, /Objective: Prove the local goal path/);

  const updateResult = await runGoalctl([
    "update",
    "--session-id",
    "session-goalctl",
    "--cwd",
    cwd,
    "--done",
    "Added goalctl fallback",
    "--inspection",
    "Read installer and hook runtime",
    "--verification",
    "goalctl smoke passed",
    "--remaining",
    "Run npm verify",
  ], { env });
  assert.match(updateResult.stdout, /Added goalctl fallback/);

  const statusResult = await runGoalctl(["status", "--session-id", "session-goalctl", "--cwd", cwd], { env });
  assert.match(statusResult.stdout, /Goal ID:/);
  assert.match(statusResult.stdout, /Verification results: goalctl smoke passed/);

  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-goalctl.json"), "utf8"));
  assert.equal(goal.objective, "Prove the local goal path");
  assert.equal(goal.doneSoFar.includes("Added goalctl fallback"), true);

  await rm(home, { recursive: true, force: true });
});

test("goalctl resolves the current workspace goal and saves an agent checkpoint", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goalctl-agent-checkpoint-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home };

  await runGoalctl([
    "open",
    "--session-id",
    "session-agent-checkpoint",
    "--cwd",
    cwd,
    "--objective",
    "Make checkpoint easy for agents",
  ], { env });

  const checkpoint = await runGoalctl([
    "checkpoint",
    "--done",
    "Inspected the user-requested project",
    "--evidence",
    "Read package.json and test scripts",
    "--next",
    "Run npm test",
  ], { env, cwd });
  assert.match(checkpoint.stdout, /Checkpoint saved/);
  assert.match(checkpoint.stdout, /Inspected the user-requested project/);

  const status = await runGoalctl(["status"], { env, cwd });
  assert.match(status.stdout, /Goal ID:/);
  assert.match(status.stdout, /Remaining: Run npm test/);

  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-agent-checkpoint.json"), "utf8"));
  assert.equal(goal.completionStatus, "active");
  assert.equal(goal.doneSoFar.includes("Inspected the user-requested project"), true);
  assert.equal(goal.inspectionEvidence.includes("Read package.json and test scripts"), true);
  assert.deepEqual(goal.remaining, ["Run npm test"]);

  await rm(home, { recursive: true, force: true });
});

test("goalctl refuses implicit workspace resolution when same-directory goals are ambiguous", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goalctl-agent-ambiguous-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home };

  await runGoalctl(["open", "--session-id", "session-one", "--cwd", cwd, "--objective", "First goal"], { env });
  await runGoalctl(["open", "--session-id", "session-two", "--cwd", cwd, "--objective", "Second goal"], { env });

  await assert.rejects(
    runGoalctl(["checkpoint", "--done", "Tried implicit update"], { env, cwd }),
    (error) => {
      assert.match(error.stderr, /Multiple active goals exist for this working directory/);
      assert.match(error.stderr, /session-one/);
      assert.match(error.stderr, /session-two/);
      return true;
    }
  );

  await rm(home, { recursive: true, force: true });
});

test("goalctl finish closes a workspace-resolved goal with proof aliases", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goalctl-agent-finish-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home };

  await runGoalctl([
    "open",
    "--session-id",
    "session-agent-finish",
    "--cwd",
    cwd,
    "--objective",
    "Finish with agent-friendly aliases",
    "--requirement",
    "inspect",
    "--requirement",
    "verify",
  ], { env });

  const finish = await runGoalctl([
    "finish",
    "--done",
    "Implemented the requested behavior",
    "--evidence",
    "Inspected the target workspace files",
    "--proof",
    "Completion gate required proof fields",
    "--verify",
    "npm run verify passed",
    "--coverage",
    "inspect covered by workspace inspection",
    "--coverage",
    "verify covered by npm run verify",
    "--audit",
    "No remaining work or blockers",
  ], { env, cwd });

  assert.match(finish.stdout, /Goal finished/);
  assert.match(finish.stdout, /Status: complete/);

  const goal = JSON.parse(await readFile(path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-agent-finish.json"), "utf8"));
  assert.equal(goal.completionStatus, "complete");
  assert.equal(Boolean(goal.closedAt), true);
  assert.deepEqual(goal.remaining, []);

  await rm(home, { recursive: true, force: true });
});

test("goalctl refuses weak completion evidence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goalctl-close-refuse-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home };

  await runGoalctl([
    "open",
    "--session-id",
    "session-close-refuse",
    "--cwd",
    cwd,
    "--objective",
    "Finish only with proof",
  ], { env });

  await assert.rejects(
    runGoalctl([
      "close",
      "--session-id",
      "session-close-refuse",
      "--cwd",
      cwd,
      "--status",
      "complete",
    ], { env }),
    (error) => {
      assert.match(error.stderr, /Refusing to mark the goal complete/);
      assert.match(error.stderr, /Verification results are empty/);
      return true;
    }
  );

  await rm(home, { recursive: true, force: true });
});

test("goalctl close durably records audit before process exit", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goalctl-close-audit-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home };

  await runGoalctl([
    "open",
    "--session-id",
    "session-close-audit",
    "--cwd",
    cwd,
    "--objective",
    "Close with an immediate audit trail",
  ], { env });

  await runGoalctl([
    "close",
    "--session-id",
    "session-close-audit",
    "--cwd",
    cwd,
    "--status",
    "complete",
    "--done",
    "Verified close audit durability",
    "--inspection",
    "Inspected the persisted audit log immediately after goalctl close exited",
    "--validation",
    "goalctl close accepted only after evidence fields were present",
    "--verification",
    "The audit log contained goalctl_close without waiting for another process",
    "--audit",
    "No remaining work, no blockers, and durable audit evidence present",
  ], { env });

  const auditLog = await readFile(path.join(home, ".copilot", "session-state", "goal-system", "audit.log"), "utf8");
  assert.match(auditLog, /"e":"goalctl_close"/);

  await rm(home, { recursive: true, force: true });
});
