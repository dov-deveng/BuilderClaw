/**
 * BuilderClaw — Main Entry Point
 * Starts everything: Express server, WhatsApp client, credential proxy, agents.
 */
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import QRCode from "qrcode";
import { startCredentialProxy } from "./agents/credential-proxy.js";
import { runContainer, stopContainer, getAgentStatuses, getContainerInfo, shutdownAll } from "./agents/container-runner.js";
import { getConfig, setConfig, getCompany, saveCompany, saveMessage, getMessages, getProjects, saveProject, updateProject, deleteProject, getContacts, saveContact, updateContact, deleteContact, getCostToday, buildContractorContext, getAgents, getAgent, createAgent, updateAgent, getAgentMemory, setAgentMemory, deleteAgentMemory, getAgentSkills, setAgentSkill } from "./memory/db.js";
import { getEnvPath } from "./data-dir.js";
import { buildAgentTask } from "./agents/agent-registry.js";
import { listAgentFiles, saveAgentFile, readAgentFile } from "./agents/agent-files.js";
import whatsapp from "./whatsapp/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard"), { index: false }));
app.use("/assets", express.static(path.join(__dirname, "dashboard", "assets")));

// No-cache on HTML so edits show without restart
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

// --- Helpers ---
function isSetupComplete() {
  return getConfig("setup_complete") === "true";
}

function checkDocker() {
  // GUI apps on macOS don't inherit terminal PATH, so check common Docker install locations
  const dockerPaths = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  for (const p of dockerPaths) {
    try {
      execSync(`"${p}" info`, { timeout: 5000, stdio: "pipe" });
      return true;
    } catch {}
  }
  // Fallback: try bare command in case PATH works
  try {
    execSync("docker info", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- Routes ---
app.get("/", (req, res) => {
  if (!isSetupComplete()) {
    res.sendFile(path.join(__dirname, "setup", "index.html"));
  } else {
    res.sendFile(path.join(__dirname, "dashboard", "index.html"));
  }
});

app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "setup", "index.html"));
});

// =====================
// SETUP API
// =====================

app.get("/api/setup/status", (req, res) => {
  const wa = whatsapp.getStatus();
  res.json({
    setupComplete: isSetupComplete(),
    whatsapp: wa.status,
    phoneNumber: wa.phoneNumber,
    company: getCompany(),
    hasDocker: checkDocker(),
    hasClaude: !!getConfig("anthropic_api_key"),
  });
});

app.get("/api/setup/check-docker", (req, res) => {
  res.json({ installed: checkDocker() });
});

app.post("/api/setup/save-api-key", (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || apiKey.length < 10) {
    return res.status(400).json({ error: "Valid API key required" });
  }

  // Sanitize: strip newlines, control chars, whitespace
  const cleanKey = apiKey.replace(/[\r\n\t\x00-\x1f]/g, "").trim();
  if (!cleanKey || cleanKey.length < 10) {
    return res.status(400).json({ error: "Invalid API key format" });
  }

  // Save to .env file
  const envPath = getEnvPath();
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
    content = content.split("\n").filter(l => !l.startsWith("ANTHROPIC_API_KEY=")).join("\n");
  }
  content = content.trim() + "\nANTHROPIC_API_KEY=" + cleanKey + "\n";
  fs.writeFileSync(envPath, content);

  // Mark as configured
  setConfig("anthropic_api_key", "configured");

  res.json({ ok: true });
});

// --- Claude CLI helper (bundled with the app) ---
import { spawn as spawnProcess } from "child_process";

function getClaudeCli() {
  return path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
}

function getNodeBin() {
  // Find system node binary — don't use process.execPath (that's Electron in packaged app)
  const home = process.env.HOME || "";
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    path.join(home, ".local", "bin", "node"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  // Check NVM default version
  try {
    const nvmDefault = path.join(home, ".nvm", "alias", "default");
    if (fs.existsSync(nvmDefault)) {
      const ver = fs.readFileSync(nvmDefault, "utf-8").trim();
      const nvmNode = path.join(home, ".nvm", "versions", "node", ver, "bin", "node");
      if (fs.existsSync(nvmNode)) return nvmNode;
    }
  } catch {}
  // Try to find via which
  try {
    const found = execSync("which node", { timeout: 3000, stdio: "pipe" }).toString().trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}
  // Last resort: use Electron as node (with ELECTRON_RUN_AS_NODE=1)
  return process.execPath;
}

function getClaudeEnv() {
  const home = process.env.HOME || "";
  const nodeBin = getNodeBin();
  const nodeDir = path.dirname(nodeBin);
  return {
    ...process.env,
    HOME: home,
    PATH: [nodeDir, home + "/.local/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", process.env.PATH || ""].join(":"),
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function spawnClaude(args) {
  const nodeBin = getNodeBin();
  const isElectron = nodeBin === process.execPath;
  const cmd = isElectron ? process.execPath : nodeBin;
  return spawnProcess(cmd, [getClaudeCli(), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: getClaudeEnv(),
  });
}

function execClaude(args, timeout = 15000) {
  const nodeBin = getNodeBin();
  const isElectron = nodeBin === process.execPath;
  const cmd = isElectron ? process.execPath : nodeBin;
  // Use spawnSync with array args to avoid shell injection
  const { stdout, status } = require("child_process").spawnSync(
    cmd, [getClaudeCli(), ...args],
    { timeout, stdio: "pipe", env: getClaudeEnv() }
  );
  if (status !== 0 && status !== null) throw new Error("Claude CLI exited with code " + status);
  return (stdout || "").toString().trim();
}

// --- OAuth login flow (Claude subscription) ---
let oauthState = { status: "idle" };

app.post("/api/setup/oauth-login", (req, res) => {
  const cli = getClaudeCli();
  if (!fs.existsSync(cli)) {
    oauthState = { status: "error", error: "Claude CLI not found in app bundle. Reinstall BuilderClaw." };
    return res.json(oauthState);
  }

  // Check if already logged in
  try {
    const status = JSON.parse(execClaude(["auth", "status", "--json"]));
    if (status.loggedIn) {
      setConfig("auth_mode", "oauth");
      setConfig("anthropic_api_key", "oauth:" + (status.email || "authenticated"));
      oauthState = { status: "success" };
      return res.json(oauthState);
    }
  } catch {}

  // Not logged in — start login flow
  oauthState = { status: "started" };
  res.json({ status: "started" });

  const child = spawnClaude(["auth", "login"]);
  child.on("close", (code) => {
    if (code === 0) {
      // Verify login succeeded
      try {
        const status = JSON.parse(execClaude(["auth", "status", "--json"]));
        if (status.loggedIn) {
          setConfig("auth_mode", "oauth");
          setConfig("anthropic_api_key", "oauth:" + (status.email || "authenticated"));
          oauthState = { status: "success" };
          return;
        }
      } catch {}
      oauthState = { status: "error", error: "Login completed but verification failed. Try again." };
    } else {
      oauthState = { status: "error", error: "Login failed. Try again or use the API key option." };
    }
  });

  setTimeout(() => {
    if (oauthState.status === "started") {
      oauthState = { status: "error", error: "Login timed out. Try again." };
      try { child.kill(); } catch {}
    }
  }, 120000);
});

app.get("/api/setup/oauth-status", (req, res) => {
  res.json(oauthState);
});

app.post("/api/setup/test-claude", async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: "API key required" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say ok" }],
      }),
    });
    if (response.ok) {
      res.json({ valid: true });
    } else {
      const err = await response.json().catch(() => ({}));
      res.json({ valid: false, error: err.error?.message || `HTTP ${response.status}` });
    }
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

app.get("/api/setup/whatsapp-qr", async (req, res) => {
  const wa = whatsapp.getStatus();
  if (wa.qrCode) {
    try {
      const dataUrl = await QRCode.toDataURL(wa.qrCode, { width: 280, margin: 2 });
      res.json({ qr: dataUrl, status: wa.status });
    } catch {
      res.json({ qr: null, status: wa.status });
    }
  } else {
    res.json({ qr: null, status: wa.status, phoneNumber: wa.phoneNumber });
  }
});

app.post("/api/setup/save-trigger", (req, res) => {
  const { trigger } = req.body;
  const word = (trigger || "@Claw").trim();
  setConfig("whatsapp_trigger", word);
  whatsapp.triggerWord = word;
  res.json({ ok: true, trigger: word });
});

app.post("/api/setup/connect-whatsapp", async (req, res) => {
  try {
    await whatsapp.connect();
    res.json({ status: "connecting" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/setup/company", (req, res) => {
  const { name, trade, state, team_size, pain_point } = req.body;
  if (!name || !trade || !state) {
    return res.status(400).json({ error: "Name, trade, and state are required" });
  }
  saveCompany({ name, trade, state, team_size, pain_point });
  res.json({ ok: true });
});

app.post("/api/setup/complete", async (req, res) => {
  setConfig("setup_complete", "true");
  setConfig("setup_completed_at", new Date().toISOString());

  // Start credential proxy now that API key is saved
  try {
    await startCredentialProxy();
  } catch (err) {
    console.error("[setup] Credential proxy start failed:", err.message);
  }

  // Auto-connect WhatsApp if not already connected
  if (whatsapp.getStatus().status !== "connected") {
    whatsapp.triggerWord = getConfig("whatsapp_trigger") || "@Claw";
    whatsapp.connect().catch(err => {
      console.error("[setup] WhatsApp connection failed:", err.message);
    });
  }

  res.json({ ok: true });
});

// =====================
// DASHBOARD API
// =====================

app.get("/api/status", (req, res) => {
  const wa = whatsapp.getStatus();
  res.json({
    running: true,
    whatsapp: wa.status,
    phoneNumber: wa.phoneNumber,
    company: getCompany(),
    costToday: getCostToday(),
  });
});

app.get("/api/messages", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const agentId = req.query.agent || null;
  res.json(getMessages(limit, offset, agentId));
});

// --- Agent CRUD ---
app.get("/api/agents", (req, res) => {
  res.json(getAgents());
});

app.get("/api/agents/:id", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(agent);
});

app.post("/api/agents", (req, res) => {
  const { id, name, role, icon } = req.body;
  if (!id || !name) return res.status(400).json({ error: "id and name required" });
  // Sanitize id
  const safeId = id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 30);
  createAgent({ id: safeId, name, role, icon });
  res.json({ ok: true, id: safeId });
});

app.put("/api/agents/:id", (req, res) => {
  updateAgent(req.params.id, req.body);
  res.json({ ok: true });
});

// --- Agent Memory ---
app.get("/api/agents/:id/memory", (req, res) => {
  res.json(getAgentMemory(req.params.id));
});

app.post("/api/agents/:id/memory", (req, res) => {
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: "key and value required" });
  setAgentMemory(req.params.id, key, value);
  res.json({ ok: true });
});

app.delete("/api/agents/:id/memory/:key", (req, res) => {
  deleteAgentMemory(req.params.id, req.params.key);
  res.json({ ok: true });
});

// --- Agent Skills ---
app.get("/api/agents/:id/skills", (req, res) => {
  res.json(getAgentSkills(req.params.id));
});

app.post("/api/agents/:id/skills", (req, res) => {
  const { skill_id, enabled, config } = req.body;
  if (!skill_id) return res.status(400).json({ error: "skill_id required" });
  setAgentSkill(req.params.id, skill_id, enabled !== false, config || null);
  res.json({ ok: true });
});

// --- Agent Files ---
app.get("/api/agents/:id/files", (req, res) => {
  res.json(listAgentFiles(req.params.id));
});

app.get("/api/agents/:id/files/:filename", (req, res) => {
  const content = readAgentFile(req.params.id, req.params.filename);
  if (content === null) return res.status(404).json({ error: "File not found" });
  res.type("text/plain").send(content);
});

app.get("/api/containers", (req, res) => {
  res.json(getContainerInfo());
});

// =====================
// MEMORY API
// =====================

app.get("/api/company", (req, res) => {
  res.json(getCompany() || {});
});

app.put("/api/company", (req, res) => {
  saveCompany(req.body);
  res.json({ ok: true });
});

app.get("/api/projects", (req, res) => {
  res.json(getProjects());
});

app.post("/api/projects", (req, res) => {
  saveProject(req.body);
  res.json({ ok: true });
});

app.put("/api/projects/:id", (req, res) => {
  updateProject(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete("/api/projects/:id", (req, res) => {
  deleteProject(req.params.id);
  res.json({ ok: true });
});

app.get("/api/contacts", (req, res) => {
  res.json(getContacts());
});

app.post("/api/contacts", (req, res) => {
  saveContact(req.body);
  res.json({ ok: true });
});

app.put("/api/contacts/:id", (req, res) => {
  updateContact(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete("/api/contacts/:id", (req, res) => {
  deleteContact(req.params.id);
  res.json({ ok: true });
});

// =====================
// CHAT API
// =====================

// --- Direct Claude execution (no Docker needed) ---
function runClaudeDirect(task) {
  return new Promise((resolve) => {
    const child = spawnClaude(["--print", task]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve({ status: "success", result: stdout.trim() });
      } else {
        resolve({ status: "error", result: null, error: stderr || "Claude returned no output" });
      }
    });
    child.on("error", (err) => {
      resolve({ status: "error", result: null, error: err.message });
    });
  });
}

// Pick execution method: OAuth uses bundled CLI directly, API key uses Docker containers
async function runTask(task, agentId = "claw") {
  const authMode = getConfig("auth_mode");
  if (authMode === "oauth") {
    return runClaudeDirect(task);
  }
  // API key mode: use Docker containers with credential proxy
  const containerAgent = agentId === "claw" ? "bear" : agentId;
  return runContainer(task, containerAgent);
}

// Post-process agent response: extract [MEMORY:...] and [FILE:...] tags
function processAgentResponse(agentId, rawResponse) {
  let clean = rawResponse;
  const files = [];

  // Extract and save memories
  const memoryPattern = /\[MEMORY:([a-zA-Z0-9_]+)=([^\]]+)\]/g;
  let match;
  while ((match = memoryPattern.exec(rawResponse)) !== null) {
    try {
      setAgentMemory(agentId, match[1], match[2].trim());
      console.log(`[memory] ${agentId}: saved ${match[1]}`);
    } catch (err) {
      console.error(`[memory] Failed to save: ${err.message}`);
    }
    clean = clean.replace(match[0], "");
  }

  // Extract and save files
  const filePattern = /\[FILE:([\w.\-]+)\]([\s\S]*?)\[\/FILE\]/g;
  while ((match = filePattern.exec(rawResponse)) !== null) {
    try {
      const savedName = saveAgentFile(agentId, match[1], match[2].trim());
      files.push(savedName);
      console.log(`[files] ${agentId}: saved ${savedName}`);
    } catch (err) {
      console.error(`[files] Failed to save: ${err.message}`);
    }
    clean = clean.replace(match[0], "");
  }

  return { text: clean.trim(), savedFiles: files };
}

const chatJobs = new Map();
let jobCounter = 0;

app.post("/api/chat/send", (req, res) => {
  const { message, agent } = req.body;
  if (!message || message.length > 10000) {
    return res.status(400).json({ error: "Message required (max 10000 chars)" });
  }

  const agentId = agent || "claw";
  const jobId = String(++jobCounter);
  chatJobs.set(jobId, { status: "running", message, agent: agentId });

  // Save user message
  saveMessage("user", "out", message, "You", null, agentId);

  // Build per-agent prompt
  const fullTask = buildAgentTask(agentId, message, "chat");

  runTask(fullTask, agentId)
    .then(result => {
      const raw = result.result || "Sorry, I couldn't process that. Try again?";
      const { text, savedFiles } = processAgentResponse(agentId, raw);
      saveMessage(agentId, "in", text, getAgent(agentId)?.name || "Claw", null, agentId);
      chatJobs.set(jobId, { status: "done", result: text, files: savedFiles });
      // Cleanup old jobs
      if (chatJobs.size > 100) {
        const keys = [...chatJobs.keys()];
        for (let i = 0; i < keys.length - 50; i++) chatJobs.delete(keys[i]);
      }
    })
    .catch(err => {
      chatJobs.set(jobId, { status: "error", error: err.message });
    });

  res.json({ jobId });
});

app.get("/api/chat/job/:id", (req, res) => {
  const job = chatJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.post("/api/agent/stop", (req, res) => {
  const { agent } = req.body;
  stopContainer(agent || "claw");
  res.json({ ok: true });
});

// =====================
// WHATSAPP → CLAW PIPELINE
// =====================

whatsapp.on("message", async (msg) => {
  const { text, sender, senderName } = msg;

  // Save incoming message
  saveMessage("incoming", "in", text, senderName, null, "claw");

  // Don't process if setup isn't complete
  if (!isSetupComplete()) {
    console.log(`[pipeline] Skipping — setup not complete. Message from ${senderName}: ${text.slice(0, 60)}`);
    return;
  }

  // Build per-agent prompt (WhatsApp always goes to Claw)
  const fullTask = buildAgentTask("claw", text, "whatsapp");

  try {
    const result = await runTask(fullTask, "claw");
    const raw = result.result || "Sorry, I couldn't process that. Try again?";
    const { text: response } = processAgentResponse("claw", raw);

    saveMessage("claw", "out", response, "Claw", null, "claw");
    await whatsapp.sendMessage(sender, response);
  } catch (err) {
    console.error("[pipeline] Error processing message:", err.message);
    await whatsapp.sendMessage(sender, "Claw ran into an issue. Give me a moment and try again.");
  }
});

// =====================
// START
// =====================

async function start() {
  // Only start credential proxy if setup is already complete
  if (isSetupComplete()) {
    try {
      await startCredentialProxy();
    } catch (err) {
      console.error("[startup] Credential proxy failed:", err.message);
    }
  }

  // Start Express server
  app.listen(PORT, () => {
    console.log(`\n  BuilderClaw running at http://localhost:${PORT}\n`);
    if (!isSetupComplete()) {
      console.log("  Setup required — open the URL above to get started.\n");
    } else {
      console.log("  Dashboard is live. WhatsApp connecting...\n");
      whatsapp.triggerWord = getConfig("whatsapp_trigger") || "@Claw";
      whatsapp.connect().catch(err => {
        console.error("[startup] WhatsApp connection failed:", err.message);
      });
    }
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[shutdown] Stopping BuilderClaw...");
    shutdownAll();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    shutdownAll();
    process.exit(0);
  });
}

start();
