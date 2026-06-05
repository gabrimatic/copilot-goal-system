import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home });

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
  const server = startMcpServer({ ...process.env, HOME: home, USERPROFILE: home });

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
