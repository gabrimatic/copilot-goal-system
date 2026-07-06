import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

const mcpServer = path.resolve("adapters", "mcp", "server.mjs");

function startMcpServer(env) {
  const child = spawn(process.execPath, [mcpServer], {
    cwd: path.resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const pending = new Map();
  let stderr = "";
  let nextId = 1;

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`Invalid JSON-RPC line: ${line}\n${error.message}`));
      }
      pending.clear();
      return;
    }
    if (Object.hasOwn(message, "id") && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
      }, 5000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
          else resolve(message.result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function close() {
    lines.close();
    child.stdin.end();
    child.kill();
  }

  return { child, close, notify, request };
}

async function initializeClient(server) {
  const initialized = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "copilot-goal-system-test",
      version: "0.0.0",
    },
  });
  assert.equal(initialized.serverInfo.name, "copilot-goal-system");
  server.notify("notifications/initialized");
}

async function callTool(server, name, args) {
  return await server.request("tools/call", {
    name,
    arguments: args,
  });
}

test("MCP stdio server exposes the complete goal tool flow", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-flow-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home, GOAL_SYSTEM_ALLOW_PATH_OVERRIDES: "1" });

  try {
    await initializeClient(server);
    const tools = await server.request("tools/list");
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "goal_system_block",
      "goal_system_cancel",
      "goal_system_checkpoint",
      "goal_system_close",
      "goal_system_finish",
      "goal_system_open",
      "goal_system_status",
      "goal_system_update",
    ]);

    const open = await callTool(server, "goal_system_open", {
      sessionId: "session-mcp",
      cwd,
      objective: "Prove MCP goal support",
      requirements: ["Exercise the full MCP goal tool flow"],
      remaining: ["Checkpoint through MCP"],
    });
    assert.equal(open.isError, undefined);
    assert.match(open.content[0].text, /Objective: Prove MCP goal support/);

    const checkpoint = await callTool(server, "goal_system_checkpoint", {
      sessionId: "session-mcp",
      cwd,
      doneSoFar: ["Opened the goal over MCP"],
      inspectionEvidence: ["Used raw JSON-RPC stdio to call the MCP server"],
      verificationResults: ["MCP checkpoint tool returned success"],
      remaining: [],
    });
    assert.equal(checkpoint.isError, undefined);
    assert.match(checkpoint.content[0].text, /Checkpoint saved/);

    const finish = await callTool(server, "goal_system_finish", {
      sessionId: "session-mcp",
      cwd,
      doneSoFar: ["Completed the MCP flow"],
      inspectionEvidence: ["Listed MCP tools and called open, checkpoint, finish, and status"],
      validationProof: ["Goal completion validation ran inside the shared goal core"],
      verificationResults: ["MCP raw stdio E2E test passed"],
      requirementCoverage: ["Exercise the full MCP goal tool flow covered by open/checkpoint/finish/status calls"],
      completionAudit: ["No remaining work or blockers are recorded"],
    });
    assert.equal(finish.isError, undefined);
    assert.match(finish.content[0].text, /Status: complete/);

    const status = await callTool(server, "goal_system_status", {
      sessionId: "session-mcp",
      cwd,
    });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /No persisted active goal/);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP stdio server returns goal validation errors without crashing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-errors-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home, GOAL_SYSTEM_ALLOW_PATH_OVERRIDES: "1" });

  try {
    await initializeClient(server);
    await callTool(server, "goal_system_open", {
      sessionId: "session-mcp-error",
      cwd,
      objective: "Reject weak MCP completion",
    });

    const weakFinish = await callTool(server, "goal_system_finish", {
      sessionId: "session-mcp-error",
      cwd,
      doneSoFar: ["Claimed done"],
    });

    assert.equal(weakFinish.isError, true);
    assert.match(weakFinish.content[0].text, /Refusing to mark the goal complete/);

    const status = await callTool(server, "goal_system_status", {
      sessionId: "session-mcp-error",
      cwd,
    });
    assert.equal(status.isError, undefined);
    assert.match(status.content[0].text, /Status: active/);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP checkpoint survives 6 concurrent tool calls without losing any doneSoFar entry", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-concurrent-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home, GOAL_SYSTEM_ALLOW_PATH_OVERRIDES: "1" });

  try {
    await initializeClient(server);
    await callTool(server, "goal_system_open", {
      sessionId: "session-mcp-concurrent",
      cwd,
      objective: "Survive concurrent MCP checkpoints",
    });

    const calls = Array.from({ length: 6 }, (_value, index) =>
      callTool(server, "goal_system_checkpoint", {
        sessionId: "session-mcp-concurrent",
        cwd,
        doneSoFar: [`concurrent mcp entry ${index + 1}`],
      })
    );
    const results = await Promise.all(calls);
    for (const result of results) assert.equal(result.isError, undefined);

    const goal = JSON.parse(
      await readFile(
        path.join(home, ".copilot", "session-state", "goal-system", "by-session", "session-mcp-concurrent.json"),
        "utf8"
      )
    );
    for (let index = 1; index <= 6; index += 1) {
      assert.equal(goal.doneSoFar.includes(`concurrent mcp entry ${index}`), true, `missing concurrent mcp entry ${index}`);
    }
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP goal_system_finish refuses recorded remaining work until explicitly cleared", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-finish-remaining-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home, GOAL_SYSTEM_ALLOW_PATH_OVERRIDES: "1" });

  try {
    await initializeClient(server);
    await callTool(server, "goal_system_open", {
      sessionId: "session-mcp-finish-remaining",
      cwd,
      objective: "Finish only after remaining is resolved",
      requirements: ["ship the fix"],
      remaining: ["write the missing test"],
    });

    const finishArgs = {
      sessionId: "session-mcp-finish-remaining",
      cwd,
      doneSoFar: ["Implemented the fix"],
      inspectionEvidence: ["Inspected the target module and reproduced the bug"],
      validationProof: ["Completion gate exercised with real evidence"],
      verificationResults: ["npm run verify passed with zero failures"],
      requirementCoverage: ["ship the fix covered by the passing verify run"],
      completionAudit: ["No blockers recorded and evidence is present"],
    };

    const refused = await callTool(server, "goal_system_finish", finishArgs);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Refusing to finish the goal/);
    assert.match(refused.content[0].text, /Remaining work is still recorded/);
    assert.match(refused.content[0].text, /write the missing test/);

    const finished = await callTool(server, "goal_system_finish", { ...finishArgs, remaining: [] });
    assert.equal(finished.isError, undefined);
    assert.match(finished.content[0].text, /Status: complete/);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP goal_system_open warns when another session already has an open goal in the same workspace", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-open-warning-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home, GOAL_SYSTEM_ALLOW_PATH_OVERRIDES: "1" });

  try {
    await initializeClient(server);
    await callTool(server, "goal_system_open", { sessionId: "session-mcp-first", cwd, objective: "First open goal" });
    const second = await callTool(server, "goal_system_open", {
      sessionId: "session-mcp-second",
      cwd,
      objective: "Second open goal",
    });

    assert.equal(second.isError, undefined);
    assert.match(second.content[0].text, /other open goals exist/);
    assert.match(second.content[0].text, /session-mcp-first/);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP server rejects path overrides without the opt-in environment variable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-path-override-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home });

  try {
    await initializeClient(server);
    const result = await callTool(server, "goal_system_status", {
      sessionId: "session-path-override",
      cwd,
      stateRoot: path.join(home, "elsewhere"),
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Path overrides/);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP server honors path overrides when explicitly enabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-path-override-allowed-"));
  const cwd = path.join(home, "project");
  const elsewhere = path.join(home, "elsewhere");
  await mkdir(cwd, { recursive: true });
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home, GOAL_SYSTEM_ALLOW_PATH_OVERRIDES: "1" });

  try {
    await initializeClient(server);
    const opened = await callTool(server, "goal_system_open", {
      sessionId: "session-path-override-allowed",
      cwd,
      objective: "Use an explicit state root",
      stateRoot: elsewhere,
    });
    assert.equal(opened.isError, undefined);

    const goal = JSON.parse(await readFile(path.join(elsewhere, "by-session", "session-path-override-allowed.json"), "utf8"));
    assert.equal(goal.objective, "Use an explicit state root");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP server reports the package.json version", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-mcp-version-"));
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home });

  try {
    const initialized = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "copilot-goal-system-test", version: "0.0.0" },
    });
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    assert.equal(initialized.serverInfo.version, packageJson.version);
    server.notify("notifications/initialized");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
