#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import {
  GOAL_STATUSES,
  MUTABLE_GOAL_STATUSES,
  GoalStore,
  createGoalRecord,
  formatGoalSummary,
  isOpenGoal,
  mergeGoal,
  normalizeCwd,
  safeSessionId,
  validateGoalCompletion,
} from "../lib/goal-core.mjs";

const listFlagMap = new Map([
  ["--requirement", "requirements"],
  ["--scope", "scope"],
  ["--must-not-regress", "mustNotRegress"],
  ["--constraint", "constraints"],
  ["--environment", "currentEnvironment"],
  ["--tool", "requiredTools"],
  ["--validation", "validationProof"],
  ["--verification", "verificationResults"],
  ["--coverage", "requirementCoverage"],
  ["--inspection", "inspectionEvidence"],
  ["--issue", "discoveredIssues"],
  ["--resolved", "resolvedIssues"],
  ["--done", "doneSoFar"],
  ["--remaining", "remaining"],
  ["--blocker", "blockers"],
  ["--audit", "completionAudit"],
]);

const scalarFlagMap = new Map([
  ["--session-id", "sessionId"],
  ["--sessionId", "sessionId"],
  ["--cwd", "cwd"],
  ["--objective", "objective"],
  ["--status", "completionStatus"],
  ["--summary", "summary"],
  ["--history-note", "historyNote"],
  ["--source-prompt", "sourcePrompt"],
  ["--home", "home"],
  ["--state-root", "stateRoot"],
  ["--workspace-state-root", "workspaceStateRoot"],
  ["--input-json", "inputJson"],
]);

function usage() {
  return `Usage:
  goalctl status --session-id <id> --cwd <path> [--json]
  goalctl open --session-id <id> --cwd <path> --objective <text> [--replace-existing]
  goalctl update --session-id <id> --cwd <path> (--input-json <json> | --stdin | field flags...)
  goalctl close --session-id <id> --cwd <path> --status complete|blocked|cancelled [--input-json <json>]

Examples:
  goalctl status --session-id "$SESSION_ID" --cwd "$PWD"
  goalctl update --session-id "$SESSION_ID" --cwd "$PWD" --done "Inspected files" --remaining "Run tests"
  printf '%s\\n' '{"verificationResults":["npm test passed"],"remaining":[]}' | goalctl update --session-id "$SESSION_ID" --cwd "$PWD" --stdin`;
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgv(argv) {
  if (argv.includes("--self-test")) {
    return { command: "self-test", input: {}, options: {} };
  }

  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", input: {}, options: {} };
  }

  const input = {};
  const options = {
    json: false,
    readStdin: false,
    replaceExisting: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--stdin") {
      options.readStdin = true;
    } else if (arg === "--replace-existing") {
      options.replaceExisting = true;
      input.replaceExisting = true;
    } else if (scalarFlagMap.has(arg)) {
      const key = scalarFlagMap.get(arg);
      input[key] = readFlagValue(argv, index, arg);
      index += 1;
    } else if (listFlagMap.has(arg)) {
      const key = listFlagMap.get(arg);
      input[key] = Array.isArray(input[key]) ? input[key] : [];
      input[key].push(readFlagValue(argv, index, arg));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, input, options };
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim();
}

async function parseJsonInput(raw, label) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

async function mergeStructuredInput(input, options) {
  let merged = { ...input };
  if (input.inputJson) {
    const parsed = await parseJsonInput(input.inputJson, "--input-json");
    delete merged.inputJson;
    merged = { ...parsed, ...merged };
  }
  if (options.readStdin) {
    const parsed = await parseJsonInput(await readStdin(), "--stdin");
    merged = { ...parsed, ...merged };
  }
  return merged;
}

function copilotRootForInput(input) {
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  const home = input.home ? path.resolve(String(input.home)) : os.homedir();
  return path.join(home, ".copilot");
}

async function createStore(input) {
  const copilotRoot = copilotRootForInput(input);
  const store = new GoalStore({
    stateRoot: input.stateRoot || process.env.GOAL_SYSTEM_STATE_ROOT || path.join(copilotRoot, "session-state", "goal-system"),
    workspaceStateRoot: input.workspaceStateRoot || path.join(copilotRoot, "session-state"),
  });
  await store.init();
  return store;
}

function contextFromInput(input) {
  const sessionId = safeSessionId(input.sessionId || process.env.GOAL_SYSTEM_SESSION_ID || "");
  const cwd = normalizeCwd(input.cwd || process.env.GOAL_SYSTEM_CWD || process.cwd());
  if (!sessionId || sessionId === "unknown-session") {
    throw new Error("A session id is required. Pass --session-id from the hook context.");
  }
  return { sessionId, cwd };
}

function patchFromInput(input) {
  const patch = { ...input };
  for (const key of ["sessionId", "cwd", "home", "stateRoot", "workspaceStateRoot"]) {
    delete patch[key];
  }
  return patch;
}

async function loadGoal(store, input) {
  const { sessionId, cwd } = contextFromInput(input);
  const record = await store.loadGoalRecord(sessionId, cwd);
  return { sessionId, cwd, record };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.text}\n`);
}

async function handleStatus(store, input, options) {
  const { record } = await loadGoal(store, input);
  if (!record || !isOpenGoal(record.goal)) {
    printResult({ ok: true, text: "No persisted active goal is stored for this session/workspace.", goal: null }, options.json);
    return;
  }
  printResult({ ok: true, text: formatGoalSummary(record.goal, { includeHistory: true }), goal: record.goal }, options.json);
}

async function handleOpen(store, input, options) {
  const { sessionId, cwd, record } = await loadGoal(store, input);
  if (record && isOpenGoal(record.goal) && input.replaceExisting !== true) {
    throw new Error(
      "An active persisted goal already exists for this session/workspace. Use update, or pass --replace-existing only when the prompt clearly replaces the current goal."
    );
  }
  const patch = patchFromInput(input);
  if (!patch.objective) throw new Error("open requires --objective or inputJson.objective.");
  const goal = createGoalRecord(patch, sessionId, cwd, {
    sourcePrompt: patch.sourcePrompt,
    historyNote: patch.historyNote || "Goal opened or replaced from goalctl",
  });
  const persisted = await store.persistGoalRecord(sessionId, cwd, goal);
  store.auditLog("goalctl_open", {
    sid: sessionId,
    id: persisted.id,
    replaced: Boolean(record && isOpenGoal(record.goal)),
  });
  printResult({ ok: true, text: formatGoalSummary(persisted), goal: persisted }, options.json);
}

async function handleUpdate(store, input, options) {
  const { sessionId, cwd, record } = await loadGoal(store, input);
  if (!record || !record.goal) throw new Error("No persisted goal exists yet. Use open first.");
  if (!isOpenGoal(record.goal)) throw new Error("The persisted goal is already closed. Open a new goal only for an explicit replacement.");
  if (typeof input.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(input.completionStatus)) {
    throw new Error("update cannot mark a goal complete or cancelled. Use close after verification.");
  }

  const patch = patchFromInput(input);
  const changedFields = Object.keys(patch).filter((key) => !["historyNote", "sourcePrompt"].includes(key) && patch[key] !== undefined);
  if (!changedFields.length) {
    throw new Error("update requires at least one real state field such as done, remaining, blockers, inspection, verification, or input JSON.");
  }

  const nextGoal = mergeGoal(record.goal, patch, "update", patch.historyNote || "Goal state updated from goalctl");
  const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
  store.auditLog("goalctl_update", { sid: sessionId, id: persisted.id, fields: changedFields });
  printResult({ ok: true, text: formatGoalSummary(persisted), goal: persisted }, options.json);
}

async function handleClose(store, input, options) {
  const { sessionId, cwd, record } = await loadGoal(store, input);
  if (!record || !record.goal) throw new Error("No persisted goal exists yet, so there is nothing to close.");

  const patch = patchFromInput(input);
  if (!GOAL_STATUSES.includes(patch.completionStatus) || patch.completionStatus === "draft" || patch.completionStatus === "active") {
    throw new Error("close requires --status complete, blocked, or cancelled.");
  }

  const nextGoal = mergeGoal(
    record.goal,
    {
      ...patch,
      blockers: patch.completionStatus === "complete" && !Array.isArray(patch.blockers) ? [] : patch.blockers,
      remaining: patch.completionStatus === "complete" && !Array.isArray(patch.remaining) ? [] : patch.remaining,
    },
    "close",
    patch.summary || `Goal marked ${patch.completionStatus} from goalctl`
  );
  nextGoal.closedAt = new Date().toISOString();

  if (patch.completionStatus === "complete") {
    const failures = validateGoalCompletion(nextGoal);
    if (failures.length) {
      throw new Error(`Refusing to mark the goal complete. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`);
    }
  }

  const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
  store.auditLog("goalctl_close", { sid: sessionId, id: persisted.id, status: patch.completionStatus });
  printResult({ ok: true, text: formatGoalSummary(persisted, { includeHistory: false }), goal: persisted }, options.json);
}

async function main() {
  const { command, input: rawInput, options } = parseArgv(process.argv.slice(2));
  if (command === "self-test") {
    process.stdout.write("copilot-goal-system goalctl ready\n");
    return;
  }
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const input = await mergeStructuredInput(rawInput, options);
  const store = await createStore(input);

  if (command === "status") await handleStatus(store, input, options);
  else if (command === "open") await handleOpen(store, input, options);
  else if (command === "update") await handleUpdate(store, input, options);
  else if (command === "close") await handleClose(store, input, options);
  else throw new Error(`Unknown command "${command}".\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
