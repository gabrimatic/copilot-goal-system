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

test("goalctl opens, updates, and reads persisted state without MCP", async () => {
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
    "Remove MCP dependency",
    "--remaining",
    "Run tests",
  ], { env });
  assert.match(openResult.stdout, /Objective: Remove MCP dependency/);

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
  assert.equal(goal.objective, "Remove MCP dependency");
  assert.equal(goal.doneSoFar.includes("Added goalctl fallback"), true);

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
