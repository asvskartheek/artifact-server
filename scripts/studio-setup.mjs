#!/usr/bin/env node
/**
 * Artifact Studio, one command, any OS (Windows / macOS / Linux):
 *
 *   node scripts/studio-setup.mjs
 *
 * 1. installs what is missing: git, pnpm, dependencies, GitHub Copilot CLI
 * 2. starts the studio server in the background (no window)
 * 3. connects GitHub Copilot (CLI + VS Code) over MCP, plus the skill
 * 4. starts the always-on agent, answering comments as "Copilot" in parallel
 *
 * Fully local: everything talks to 127.0.0.1 with the server's own local
 * credential. No API key. Safe to run again; it only fills in what is missing.
 * `node scripts/studio-setup.mjs stop` stops the background processes.
 */
import {execFileSync, spawn} from "node:child_process";
import {existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {homedir, platform} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(repo, ".artifact-server");
const logs = join(repo, ".studio-logs");
const windows = platform() === "win32";
const say = (text) => console.log(`• ${text}`);

/** Run a command quietly, with no window; true when it succeeded. */
function ok(command, args = [], options = {}) {
  try {
    execFileSync(command, args, {stdio: "ignore", shell: windows, windowsHide: true, ...options});
    return true;
  } catch {
    return false;
  }
}

function must(command, args, what) {
  say(what);
  execFileSync(command, args, {cwd: repo, stdio: "inherit", shell: windows, windowsHide: true});
}

/** Start a long-running process detached in the background, logging to a file. */
function background(name, command, args, env = {}) {
  mkdirSync(logs, {recursive: true});
  const out = openSync(join(logs, `${name}.log`), "a");
  const child = spawn(command, args, {
    cwd: repo,
    detached: true,
    env: {...process.env, ...env},
    shell: windows,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(join(logs, `${name}.pid`), String(child.pid));
}

function stop() {
  for (const name of ["server", "agent"]) {
    const file = join(logs, `${name}.pid`);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    try {
      if (windows) ok("taskkill", ["/pid", String(pid), "/T", "/F"]);
      else process.kill(-pid, "SIGTERM");
      say(`stopped ${name}`);
    } catch {
      // already gone
    }
    // A stale pid file would point at whatever process reuses that pid later.
    rmSync(file, {force: true});
  }
}

async function serverUp() {
  try {
    const response = await fetch("http://127.0.0.1:8787/api/v1/session");
    return response.status < 500;
  } catch {
    return false;
  }
}

if (process.argv[2] === "stop") {
  stop();
  process.exit(0);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 12)) {
  console.error("Node.js 24.12 or newer is needed: https://nodejs.org");
  process.exit(1);
}

// 1. prerequisites
if (!ok("git", ["--version"])) {
  say("installing git");
  if (windows) ok("winget", ["install", "--id", "Git.Git", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"]);
  else if (platform() === "darwin") {
    if (!ok("brew", ["install", "git"])) ok("xcode-select", ["--install"]);
  } else if (!ok("sudo", ["apt-get", "install", "-y", "git"])) {
    ok("sudo", ["dnf", "install", "-y", "git"]);
  }
  if (!ok("git", ["--version"])) say("git could not be installed automatically; parallel edits fall back to one-at-a-time");
}
if (!ok("pnpm", ["--version"])) must("npm", ["install", "-g", "pnpm@10.34.3"], "installing pnpm");
if (!existsSync(join(repo, "node_modules"))) must("pnpm", ["install"], "installing dependencies");
if (!ok("copilot", ["--version"])) must("npm", ["install", "-g", "@github/copilot"], "installing GitHub Copilot CLI");

// 2. server, in the background
if (await serverUp()) {
  say("studio server already running");
} else {
  must("pnpm", ["--filter", "@artifact-server/web", "build"], "building the studio UI");
  say("starting the studio server (background)");
  background("server", process.execPath, ["--import", "tsx", "src/cli/main.ts", "start", "--data", data, "--port", "8787", "--managed"]);
  // Poll once a second, up to a minute (sequential on purpose).
  const waitForServer = async (left) => (await serverUp()) || (left > 0
    && (await new Promise((done) => setTimeout(done, 1000)), waitForServer(left - 1)));
  if (!(await waitForServer(60))) {
    console.error(`The server did not start; see ${join(logs, "server.log")}`);
    process.exit(1);
  }
}

// 3. connect GitHub Copilot: VS Code chat + CLI (MCP), and the publishing skill
const tsx = join(repo, "node_modules", ".bin", windows ? "tsx.cmd" : "tsx");
const mcpServer = {command: tsx, args: [join(repo, "src", "cli", "main.ts"), "mcp", "--data", data]};
ok(process.execPath, ["--import", "tsx", "src/cli/main.ts", "connect", "vscode", "--data", data], {cwd: repo});
const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
mkdirSync(join(copilotHome, "skills"), {recursive: true});
const mcpConfigFile = join(copilotHome, "mcp-config.json");
const mcpConfig = existsSync(mcpConfigFile) ? JSON.parse(readFileSync(mcpConfigFile, "utf8")) : {};
mcpConfig.mcpServers = {...mcpConfig.mcpServers, "artifact-server": {type: "local", ...mcpServer, tools: ["*"]}};
writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2));
ok("copilot", ["skill", "add", join(repo, "skills", "artifact-server")]);
say("GitHub Copilot connected (CLI + VS Code): ask it to make an artifact");

// 4. the always-on agent, played by Copilot, answering comments in parallel
const agentPid = join(logs, "agent.pid");
const agentAlive = existsSync(agentPid) && ok(windows ? "tasklist" : "kill", windows
  ? ["/FI", `PID eq ${readFileSync(agentPid, "utf8")}`, "/NH"]
  : ["-0", readFileSync(agentPid, "utf8")]);
if (agentAlive) {
  say("agent already running");
} else {
  say("starting the agent as \"Copilot\" (background)");
  background("agent", process.execPath, [join(repo, "integrations", "studio-agent", "agent.mjs")], {
    STUDIO_AGENT_CMD: JSON.stringify([
      "copilot", "-p", "{prompt}", "--silent", "--no-ask-user",
      // Edit files only: no shell, no network, no windows.
      "--allow-tool=write", "--deny-tool=shell", "--deny-tool=url",
    ]),
    STUDIO_AGENT_KIND: "copilot",
    STUDIO_AGENT_NAME: "Copilot",
  });
}

console.log(`\nOpen http://127.0.0.1:8787/review\nLogs: ${logs}\nStop: node scripts/studio-setup.mjs stop`);
