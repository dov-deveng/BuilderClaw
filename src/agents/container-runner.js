/**
 * BuilderClaw — Container Runner
 * Manages Docker containers for Bear and sub-agents.
 * Adapted from Bear OS / NanoClaw pattern.
 * One persistent container per agent with IPC, sessions, and isolated workspace.
 */
import { spawn, execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectAuthMode } from "./credential-proxy.js";

const CONTAINER_IMAGE = "builderclaw-agent:latest";
const CREDENTIAL_PROXY_PORT = 3001;
const CONTAINER_TIMEOUT = 45 * 60 * 1000;  // Hard timeout: 45 min
const GRACEFUL_WARNING = 5 * 60 * 1000;    // Warn 5 min before hard kill
const IDLE_TIMEOUT = 2 * 60 * 60 * 1000;   // Idle timeout: 2 hours
const MAX_OUTPUT_SIZE = 5 * 1024 * 1024;
const OUTPUT_START_MARKER = "---BEAR_OUTPUT_START---";
const OUTPUT_END_MARKER = "---BEAR_OUTPUT_END---";
const MAX_HISTORY = 20;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");

const VALID_AGENTS = ["bear", "pm", "estimator", "accounts", "safety"];

// --- Container history ---
const containerHistory = [];
function addHistory(entry) {
  containerHistory.unshift(entry);
  if (containerHistory.length > MAX_HISTORY) containerHistory.length = MAX_HISTORY;
}

export function getContainerHistory() { return containerHistory; }

// --- Per-agent spawn lock ---
const spawnLocks = new Map();

// --- Per-agent state ---
const agents = new Map();

function getAgent(agent) {
  if (!agents.has(agent)) {
    agents.set(agent, {
      container: null,
      sessionId: null,
      resolvers: [],
      progress: { active: false, steps: [], startedAt: null },
    });
  }
  return agents.get(agent);
}

// --- Orphan cleanup ---
function killOrphanContainers() {
  try {
    const running = execSync('docker ps --filter "name=bclaw-" --format "{{.Names}}"', { timeout: 5000 })
      .toString().trim().split("\n").filter(Boolean);
    const tracked = new Set();
    for (const name of VALID_AGENTS) {
      const a = agents.get(name);
      if (a?.container?.containerName) tracked.add(a.container.containerName);
    }
    for (const name of running) {
      if (!tracked.has(name)) {
        console.log(`[cleanup] Killing orphan container: ${name}`);
        try { execFileSync("docker", ["kill", name], { timeout: 10000 }); } catch {}
      }
    }
  } catch {}
}

function killAgentContainers(agent) {
  try {
    const running = execSync(`docker ps --filter "name=bclaw-${agent}-" --format "{{.Names}}"`, { timeout: 5000 })
      .toString().trim().split("\n").filter(Boolean);
    for (const name of running) {
      console.log(`[${agent}] Pre-spawn: killing stale container ${name}`);
      try { execFileSync("docker", ["kill", name], { timeout: 10000 }); } catch {}
    }
  } catch {}
}

killOrphanContainers();

// --- Per-agent paths ---
function agentPaths(agent) {
  return {
    ipcDir: path.join(DATA_DIR, "ipc", agent),
    ipcInputDir: path.join(DATA_DIR, "ipc", agent, "input"),
    workDir: path.join(DATA_DIR, "workspace", agent),
    sessionsDir: path.join(DATA_DIR, "sessions", agent, ".claude"),
    promptDir: path.join(DATA_DIR, "prompt", agent),
    progressFile: path.join(DATA_DIR, `${agent}-progress.json`),
  };
}

// --- Progress tracking ---
export function getBearProgress(agent = "bear") {
  return getAgent(agent).progress;
}

function resetProgress(agent) {
  const a = getAgent(agent);
  a.progress = { active: true, steps: [], startedAt: Date.now() };
}

function addProgressStep(agent, text) {
  if (!text || text.length < 3) return;
  const a = getAgent(agent);
  a.progress.steps.push({ text, ts: Date.now() });
  if (a.progress.steps.length > 30) a.progress.steps = a.progress.steps.slice(-30);
}

function endProgress(agent) {
  getAgent(agent).progress.active = false;
}

function parseStderrForProgress(agent, chunk) {
  const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(Read|Write|Edit|Bash|Glob|Grep|WebFetch|WebSearch)\b/.test(line)) {
      addProgressStep(agent, line.slice(0, 120));
    } else if (/^(Planning|Creating|Reading|Writing|Searching|Analyzing|Building|Generating|Checking|Running)/i.test(line)) {
      addProgressStep(agent, line.slice(0, 120));
    }
  }
}

// --- Volume mounts ---
function buildVolumeMounts(agent) {
  const paths = agentPaths(agent);
  const mounts = [];

  // System prompt
  fs.mkdirSync(paths.promptDir, { recursive: true });
  const promptSrc = path.join(PROJECT_ROOT, "src", "agents", "prompts", `${agent}.md`);
  const fallbackSrc = path.join(PROJECT_ROOT, "src", "agents", "prompts", "bear.md");
  const src = fs.existsSync(promptSrc) ? promptSrc : fallbackSrc;
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(paths.promptDir, "system-prompt.md"));
  mounts.push({ hostPath: paths.promptDir, containerPath: "/workspace/prompt", readonly: true });

  // Agent working directory
  fs.mkdirSync(paths.workDir, { recursive: true });
  mounts.push({ hostPath: paths.workDir, containerPath: "/workspace/group", readonly: false });

  // IPC directory
  fs.mkdirSync(path.join(paths.ipcDir, "messages"), { recursive: true });
  fs.mkdirSync(path.join(paths.ipcDir, "tasks"), { recursive: true });
  fs.mkdirSync(paths.ipcInputDir, { recursive: true });
  mounts.push({ hostPath: paths.ipcDir, containerPath: "/workspace/ipc", readonly: false });

  // Credentials via proxy
  const envDir = path.join(DATA_DIR, "env");
  fs.mkdirSync(envDir, { recursive: true });
  const authMode = detectAuthMode();
  const envLines = [`ANTHROPIC_BASE_URL=http://host.docker.internal:${CREDENTIAL_PROXY_PORT}`];
  if (authMode === "api-key") {
    envLines.push("ANTHROPIC_API_KEY=placeholder");
  } else {
    envLines.push("CLAUDE_CODE_OAUTH_TOKEN=placeholder");
  }
  fs.writeFileSync(path.join(envDir, "env"), envLines.join("\n") + "\n");
  mounts.push({ hostPath: envDir, containerPath: "/workspace/env-dir", readonly: true });

  // Persistent Claude sessions
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const settingsFile = path.join(paths.sessionsDir, "settings.json");
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" },
    }, null, 2) + "\n");
  }
  mounts.push({ hostPath: paths.sessionsDir, containerPath: "/home/node/.claude", readonly: false });

  // Bear (main agent) gets orchestration access to delegate
  if (agent === "bear") {
    const orchDir = path.join(DATA_DIR, "orch-env");
    fs.mkdirSync(orchDir, { recursive: true });
    const orchLines = [
      `BUILDERCLAW_API_URL=http://host.docker.internal:3000`,
      `BUILDERCLAW_API_KEY=${process.env.BUILDERCLAW_API_KEY || ""}`,
    ];
    fs.writeFileSync(path.join(orchDir, "orchestration.env"), orchLines.join("\n") + "\n");
    mounts.push({ hostPath: orchDir, containerPath: "/workspace/orchestration", readonly: true });
  }

  return mounts;
}

function buildContainerArgs(mounts, containerName) {
  const args = ["run", "-i", "--rm", "--name", containerName];
  for (const m of mounts) {
    if (m.readonly) {
      args.push("--mount", `type=bind,source=${m.hostPath},target=${m.containerPath},readonly`);
    } else {
      args.push("-v", `${m.hostPath}:${m.containerPath}`);
    }
  }
  args.push(CONTAINER_IMAGE);
  return args;
}

// --- IPC functions ---
function sendIpcMessage(agent, text) {
  const { ipcInputDir } = agentPaths(agent);
  fs.mkdirSync(ipcInputDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filepath = path.join(ipcInputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ type: "message", text }));
  fs.renameSync(tempPath, filepath);
  console.log(`[${agent}] IPC message sent: ${text.slice(0, 80)}...`);
}

function sendCloseSentinel(agent) {
  const { ipcInputDir } = agentPaths(agent);
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.writeFileSync(path.join(ipcInputDir, "_close"), "");
}

function cleanIpcInput(agent) {
  const { ipcInputDir } = agentPaths(agent);
  try {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    for (const f of fs.readdirSync(ipcInputDir)) {
      try { fs.unlinkSync(path.join(ipcInputDir, f)); } catch {}
    }
  } catch {}
}

// --- Timer management ---
function cancelIdleTimer(agent) {
  const a = getAgent(agent);
  if (a.container?.idleTimer) { clearTimeout(a.container.idleTimer); a.container.idleTimer = null; }
}

function resetIdleTimer(agent) {
  const a = getAgent(agent);
  if (!a.container) return;
  cancelIdleTimer(agent);
  a.container.idleTimer = setTimeout(() => {
    console.log(`[${agent}] Idle timeout, saving progress then closing`);
    sendIpcMessage(agent, "Session ending due to idle timeout. Save a brief summary of current status and next steps to /workspace/group/PROGRESS.md. Keep it under 30 lines. Do not start any new tasks.");
    setTimeout(() => sendCloseSentinel(agent), 30000);
  }, IDLE_TIMEOUT);
}

// --- Container spawn ---
function spawnContainer(agent, task, resumeSessionId) {
  killAgentContainers(agent);
  cleanIpcInput(agent);

  const mounts = buildVolumeMounts(agent);
  const containerName = `bclaw-${agent}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
  const input = JSON.stringify({ task, sessionId: resumeSessionId });

  console.log(`[${agent}] Spawning container ${containerName}`);
  resetProgress(agent);
  addProgressStep(agent, `Starting container: ${containerName}`);

  const container = spawn("docker", containerArgs, { stdio: ["pipe", "pipe", "pipe"] });
  const a = getAgent(agent);

  a.container = {
    process: container,
    containerName,
    idleTimer: null,
    hardWarning: null,
    hardTimeout: null,
    startedAt: Date.now(),
    task: task.slice(0, 200),
  };
  spawnLocks.set(agent, false);

  container.stdin.write(input);
  container.stdin.end();

  let stdout = "", stderr = "", parseBuffer = "";

  container.stdout.on("data", (data) => {
    const chunk = data.toString();
    if (stdout.length < MAX_OUTPUT_SIZE) stdout += chunk;

    parseBuffer += chunk;
    let startIdx;
    while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
      const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) break;
      const jsonStr = parseBuffer.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
      parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.newSessionId) {
          a.sessionId = parsed.newSessionId;
          console.log(`[${agent}] Session: ${parsed.newSessionId}`);
        }
        resetHardTimeout();
        if (parsed.result) {
          cancelIdleTimer(agent);
        } else {
          resetIdleTimer(agent);
        }
        if (parsed.result && a.resolvers.length > 0) {
          const resolver = a.resolvers.shift();
          endProgress(agent);
          resolver.resolve({
            status: parsed.status || "success",
            result: parsed.result,
            allResults: [parsed.result],
            newSessionId: a.sessionId,
          });
        }
      } catch {}
    }
  });

  container.stderr.on("data", (data) => {
    const chunk = data.toString();
    if (stderr.length < MAX_OUTPUT_SIZE) stderr += chunk;
    parseStderrForProgress(agent, chunk);
    resetHardTimeout();
  });

  // Hard timeout with graceful warning
  const resetHardTimeout = () => {
    if (a.container?.hardWarning) clearTimeout(a.container.hardWarning);
    if (a.container?.hardTimeout) clearTimeout(a.container.hardTimeout);
    if (!a.container) return;
    a.container.hardWarning = setTimeout(() => {
      console.log(`[${agent}] Approaching timeout — sending wrap-up warning`);
      sendIpcMessage(agent, "You have 5 minutes before this container shuts down. IMMEDIATELY: 1) Stop any new work. 2) Write a progress summary to /workspace/group/PROGRESS.md listing what you completed, what is in progress, and what remains. 3) Save any unsaved work to files. Do this NOW.");
    }, CONTAINER_TIMEOUT - GRACEFUL_WARNING);
    a.container.hardTimeout = setTimeout(() => {
      console.log(`[${agent}] Hard timeout, stopping ${containerName}`);
      try { execFileSync("docker", ["stop", containerName], { timeout: 15000 }); } catch { container.kill("SIGKILL"); }
    }, CONTAINER_TIMEOUT);
  };
  resetHardTimeout();

  container.on("close", (code) => {
    if (a.container?.hardWarning) clearTimeout(a.container.hardWarning);
    if (a.container?.hardTimeout) clearTimeout(a.container.hardTimeout);
    if (a.container?.idleTimer) clearTimeout(a.container.idleTimer);
    endProgress(agent);
    console.log(`[${agent}] ${containerName} exited code=${code}`);

    addHistory({
      containerName, agent,
      status: code === 0 ? "completed" : "error",
      task: a.container?.task || task.slice(0, 200),
      startedAt: a.container?.startedAt || Date.now(),
      endedAt: Date.now(),
      exitCode: code,
      lastStep: a.progress.steps.length > 0 ? a.progress.steps[a.progress.steps.length - 1].text : null,
    });

    while (a.resolvers.length > 0) {
      const resolver = a.resolvers.shift();
      resolver.resolve({
        status: "error",
        result: null,
        error: code === 0 ? "Container exited (idle timeout)" : `Container exited with code ${code}`,
      });
    }

    a.container = null;
    spawnLocks.set(agent, false);
  });

  container.on("error", (err) => {
    if (a.container?.hardWarning) clearTimeout(a.container.hardWarning);
    if (a.container?.hardTimeout) clearTimeout(a.container.hardTimeout);
    console.error(`[${agent}] Spawn error: ${err.message}`);
    while (a.resolvers.length > 0) {
      a.resolvers.shift().resolve({ status: "error", result: null, error: `Spawn error: ${err.message}` });
    }
    a.container = null;
    spawnLocks.set(agent, false);
  });

  resetIdleTimer(agent);
}

// --- Public API ---
export async function runContainer(task, agent = "bear") {
  if (!VALID_AGENTS.includes(agent)) {
    return { status: "error", result: null, error: `Invalid agent: ${agent}` };
  }

  const a = getAgent(agent);

  // If no container running, spawn one
  if (!a.container) {
    if (spawnLocks.get(agent)) {
      return { status: "error", result: null, error: "Container is starting, try again in a moment" };
    }
    spawnLocks.set(agent, true);
    spawnContainer(agent, task, a.sessionId);
  } else {
    // Container exists — send task via IPC
    cancelIdleTimer(agent);
    resetProgress(agent);
    addProgressStep(agent, `New task: ${task.slice(0, 80)}`);
    sendIpcMessage(agent, task);
  }

  // Wait for result
  return new Promise((resolve) => {
    a.resolvers.push({ resolve });
    // Safety timeout
    setTimeout(() => {
      const idx = a.resolvers.indexOf(resolve);
      if (idx !== -1) {
        a.resolvers.splice(idx, 1);
        resolve({ status: "error", result: null, error: "Task timed out waiting for response" });
      }
    }, CONTAINER_TIMEOUT + 60000);
  });
}

export function stopContainer(agent = "bear") {
  const a = getAgent(agent);
  if (!a.container) return;
  const name = a.container.containerName;
  console.log(`[${agent}] Stopping ${name}`);
  try {
    execFileSync("docker", ["stop", "-t", "2", name], { timeout: 10000 });
  } catch {}
  try {
    const still = execSync(`docker ps -q --filter "name=${name}"`, { timeout: 5000 }).toString().trim();
    if (still) execFileSync("docker", ["kill", name], { timeout: 5000 });
  } catch {}
}

export function getAgentStatuses() {
  const statuses = {};
  for (const name of VALID_AGENTS) {
    const a = agents.get(name);
    statuses[name] = {
      online: !!a?.container,
      working: a?.progress?.active || false,
      lastStep: a?.progress?.steps?.length > 0 ? a.progress.steps[a.progress.steps.length - 1].text : null,
      containerName: a?.container?.containerName || null,
      uptime: a?.container?.startedAt ? Date.now() - a.container.startedAt : 0,
    };
  }
  return statuses;
}

export function getContainerInfo() {
  const active = [];
  for (const name of VALID_AGENTS) {
    const a = agents.get(name);
    if (a?.container) {
      active.push({
        agent: name,
        containerName: a.container.containerName,
        status: a.progress.active ? "working" : "idle",
        task: a.container.task,
        uptime: Date.now() - a.container.startedAt,
        lastStep: a.progress.steps.length > 0 ? a.progress.steps[a.progress.steps.length - 1].text : null,
      });
    }
  }
  return { active, history: containerHistory };
}

export function shutdownAll() {
  for (const name of VALID_AGENTS) {
    try { stopContainer(name); } catch {}
  }
}
