"use strict";

const os = require("node:os");
const path = require("node:path");

function resolveHomePath(value, home = os.homedir()) {
  const text = String(value || "");
  if (text === "~") return home;
  if (text.startsWith("~/")) return path.join(home, text.slice(2));
  return path.resolve(text);
}

function copilotRootForHome(home, env = process.env) {
  return env.COPILOT_HOME ? resolveHomePath(env.COPILOT_HOME, home) : path.join(home, ".copilot");
}

module.exports = {
  copilotRootForHome,
  resolveHomePath,
};
