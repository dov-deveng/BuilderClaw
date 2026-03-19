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
import { getConfig, setConfig, getCompany, saveCompany, saveMessage, getMessages, getProjects, saveProject, updateProject, deleteProject, getContacts, saveContact, updateContact, deleteContact, getCostToday, buildContractorContext } from "./memory/db.js";
import { getEnvPath } from "./data-dir.js";
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

  // Save to .env file
  const envPath = getEnvPath();
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
    content = content.split("\n").filter(l => !l.startsWith("ANTHROPIC_API_KEY=")).join("\n");
  }
  content = content.trim() + "\nANTHROPIC_API_KEY=" + apiKey + "\n";
  fs.writeFileSync(envPath, content);

  // Mark as configured
  setConfig("anthropic_api_key", "configured");

  res.json({ ok: true });
});

// --- OAuth login flow (Claude subscription) ---
let oauthState = { status: "idle" }; // idle, started, success, error

app.post("/api/setup/oauth-login", async (req, res) => {
  oauthState = { status: "started" };

  // Use bundled Claude CLI — no system install needed
  const home = process.env.HOME || "";
  const bundledCli = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (!fs.existsSync(bundledCli)) {
    oauthState = { status: "error", error: "Claude CLI not found in app bundle. Reinstall BuilderClaw." };
    return res.json({ status: "error", error: oauthState.error });
  }

  oauthState = { status: "started" };
  res.json({ status: "started" });

  // Run claude login in background — it opens a browser
  const { spawn } = await import("child_process");
  const fullPath = [home + "/.local/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", process.env.PATH || ""].join(":");
  const child = spawn(process.execPath, [bundledCli, "login"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, PATH: fullPath, ELECTRON_RUN_AS_NODE: "1" },
  });

  let output = "";
  child.stdout.on("data", (d) => { output += d.toString(); });
  child.stderr.on("data", (d) => { output += d.toString(); });

  child.on("close", (code) => {
    if (code === 0) {
      // Claude Code stores OAuth token in ~/.claude/ — find it
      const claudeDir = path.join(process.env.HOME || "", ".claude");
      const credFiles = [
        path.join(claudeDir, ".credentials.json"),
        path.join(claudeDir, "credentials.json"),
      ];
      let token = null;
      for (const f of credFiles) {
        try {
          const creds = JSON.parse(fs.readFileSync(f, "utf-8"));
          token = creds.oauthToken || creds.claudeAiOauth?.accessToken || creds.accessToken;
          if (token) break;
        } catch {}
      }

      if (token) {
        // Save OAuth token to .env
        const envPath = getEnvPath();
        let content = "";
        if (fs.existsSync(envPath)) {
          content = fs.readFileSync(envPath, "utf-8");
          content = content.split("\n").filter(l => !l.startsWith("CLAUDE_CODE_OAUTH_TOKEN=") && !l.startsWith("ANTHROPIC_API_KEY=")).join("\n");
        }
        content = content.trim() + "\nCLAUDE_CODE_OAUTH_TOKEN=" + token + "\n";
        fs.writeFileSync(envPath, content);
        setConfig("anthropic_api_key", "oauth");
        oauthState = { status: "success" };
      } else {
        oauthState = { status: "error", error: "Login succeeded but couldn't find token. Try the API key option instead." };
      }
    } else {
      oauthState = { status: "error", error: "Login failed (exit " + code + "). Try the API key option instead." };
    }
  });

  // Timeout after 2 minutes
  setTimeout(() => {
    if (oauthState.status === "started") {
      oauthState = { status: "error", error: "Login timed out. Try again or use the API key option." };
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
    agents: getAgentStatuses(),
    costToday: getCostToday(),
  });
});

app.get("/api/messages", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  res.json(getMessages(limit, offset));
});

app.get("/api/agents", (req, res) => {
  res.json(getAgentStatuses());
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

const chatJobs = new Map();
let jobCounter = 0;

app.post("/api/chat/send", (req, res) => {
  const { message } = req.body;
  if (!message || message.length > 10000) {
    return res.status(400).json({ error: "Message required (max 10000 chars)" });
  }

  const jobId = String(++jobCounter);
  chatJobs.set(jobId, { status: "running", message });

  // Save user message
  saveMessage("user", "out", message, "You");

  // Build context and send to Bear
  const context = buildContractorContext();
  const fullTask = context
    ? `${context}\n\n---\nMessage from contractor:\n${message}\n\nRespond concisely (2-4 sentences for simple answers). Do NOT use markdown formatting.`
    : `Message from contractor:\n${message}\n\nRespond concisely (2-4 sentences for simple answers). Do NOT use markdown formatting.`;

  runContainer(fullTask, "bear")
    .then(result => {
      const response = result.result || "Sorry, I couldn't process that. Try again?";
      saveMessage("bear", "in", response, "Bear");
      chatJobs.set(jobId, { status: "done", result: response });
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

// =====================
// AGENT API
// =====================

app.post("/api/agent/task", async (req, res) => {
  const { task, agent } = req.body;
  if (!task || task.length > 10000) {
    return res.status(400).json({ error: "Task required (max 10000 chars)" });
  }
  const agentName = agent || "bear";
  try {
    const result = await runContainer(task, agentName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent/stop", (req, res) => {
  const { agent } = req.body;
  stopContainer(agent || "bear");
  res.json({ ok: true });
});

// =====================
// WHATSAPP → BEAR PIPELINE
// =====================

whatsapp.on("message", async (msg) => {
  const { text, sender, senderName } = msg;

  // Save incoming message always (for history)
  saveMessage("incoming", "in", text, senderName);

  // Don't route to Bear if setup isn't complete — no API key means containers will crash
  if (!isSetupComplete()) {
    console.log(`[pipeline] Skipping Bear — setup not complete. Message from ${senderName}: ${text.slice(0, 60)}`);
    return;
  }

  // Build context and send to Bear
  const context = buildContractorContext();
  const fullTask = context
    ? `${context}\n\n---\nWhatsApp message from ${senderName}:\n${text}\n\nRespond concisely for WhatsApp (2-4 sentences for simple answers). Do NOT use markdown formatting.`
    : `WhatsApp message from ${senderName}:\n${text}\n\nRespond concisely for WhatsApp (2-4 sentences for simple answers). Do NOT use markdown formatting.`;

  try {
    const result = await runContainer(fullTask, "bear");
    const response = result.result || "Sorry, I couldn't process that. Try again?";

    // Save outgoing message
    saveMessage("bear", "out", response, "Bear");

    // Send via WhatsApp
    await whatsapp.sendMessage(sender, response);
  } catch (err) {
    console.error("[pipeline] Error processing message:", err.message);
    await whatsapp.sendMessage(sender, "Bear ran into an issue. Give me a moment and try again.");
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
