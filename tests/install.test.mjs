import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const installer = path.join(root, "scripts", "install.mjs");

test("installer merges hooks, writes backups, and preserves existing settings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-test-"));
  const copilotDir = path.join(home, ".copilot");
  await writeFile(
    path.join(copilotDir, "settings.json"),
    JSON.stringify(
      {
        theme: "auto",
        hooks: {
          sessionStart: [{ type: "command", bash: "$HOME/.copilot/hooks/existing.sh", timeoutSec: 1 }],
        },
      },
      null,
      2
    ),
    { flag: "w" }
  ).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    await execFileAsync("mkdir", ["-p", copilotDir]);
    await writeFile(
      path.join(copilotDir, "settings.json"),
      JSON.stringify(
        {
          theme: "auto",
          hooks: {
            sessionStart: [{ type: "command", bash: "$HOME/.copilot/hooks/existing.sh", timeoutSec: 1 }],
          },
        },
        null,
        2
      )
    );
  });

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.equal(settings.theme, "auto");
  assert.equal(settings.hooks.sessionStart.some((hook) => hook.bash === "$HOME/.copilot/hooks/existing.sh"), true);
  assert.equal(settings.hooks.sessionStart.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  const snippet = await readFile(path.join(copilotDir, "copilot-instructions.md"), "utf8");
  assert.match(snippet, /copilot-goal-system snippet start/);

  const findResult = await execFileAsync("find", [copilotDir, "-name", "*.backup-*"], { encoding: "utf8" });
  assert.match(findResult.stdout, /settings\.json\.backup-/);

  await rm(home, { recursive: true, force: true });
});

test("installer refuses corrupt settings instead of overwriting them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-bad-json-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(path.join(copilotDir, "settings.json"), "{bad json");

  await assert.rejects(
    execFileAsync(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, HOME: home },
      maxBuffer: 1024 * 1024 * 8,
    }),
    /not valid JSON/
  );

  assert.equal(await readFile(path.join(copilotDir, "settings.json"), "utf8"), "{bad json");

  await rm(home, { recursive: true, force: true });
});
