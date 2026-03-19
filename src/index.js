/**
 * BuilderClaw — Main Entry Point
 * Starts everything: Express server, WhatsApp client, credential proxy, agents.
 */
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { startCredentialProxy } from "./agents/credential-proxy.js";
import { runContainer, stopContainer, getAgentStatuses, getContainerInfo, shutdownAll } from "./agents/container-runner.js";
import { getConfig, setConfig, getCompany, saveCompany, saveMessage, getMessages, getProjects, saveProject, updateProject, deleteProject, getContacts, saveContact, updateContact, deleteContact, getCostToday, buildContractorContext } from "./memory/db.js";
import whatsapp from "./whatsapp/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const PORT = 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

// No-cache on HTML so edits show without restart
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

// --- Setup check ---
function isSetupComplete() {
  return getConfig("setup_complete") === "true";
}

// --- Routes ---

// Serve setup wizard or dashboard based on setup state
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

// --- Setup API ---
app.get("/api/setup/status", (req, res) => {
  const wa = whatsapp.getStatus();
  res.json({
    setupComplete: isSetupComplete(),
    whatsapp: wa.status,
    phoneNumber: wa.phoneNumber,
    company: getCompany(),
    hasDocker: checkDocker(),
    hasClaude: !!getConfig("claude_authenticated"),
  });
});

app.get("/api/setup/whatsapp-qr", (req, res) => {
  const wa = whatsapp.getStatus();
  if (wa.qrCode) {
    res.json({ qr: wa.qrCode, status: wa.status });
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

app.post("/api/setup/complete", (req, res) => {
  setConfig("setup_complete", "true");
  setConfig("setup_completed_at", new Date().toISOString());
  res.json({ ok: true });
});

// --- Dashboard API ---
app.get("/api/status", (req, res) => {
  const wa = whatsapp.getStatus();
  res.json({
    running: true,
    whatsapp: wa.status,
    phoneNumber: wa.phoneNumber,
    company: getCompany(),
    agents: getAgentStatuses(),
    costToday: getCostToday(),
    messageCount: getMessages(1, 0).length > 0 ? true : false,
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

// --- Memory API ---
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

// --- Agent API ---
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

// --- Helpers ---
function checkDocker() {
  try {
    execSync("docker info", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- WhatsApp → Bear pipeline ---
whatsapp.on("message", async (msg) => {
  const { text, sender, senderName } = msg;

  // Save incoming message
  saveMessage("incoming", "in", text, senderName);

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

// --- Start everything ---
async function start() {
  // Start credential proxy
  try {
    await startCredentialProxy();
  } catch (err) {
    console.error("[startup] Credential proxy failed:", err.message);
  }

  // Start Express server
  app.listen(PORT, () => {
    console.log(`\n  BuilderClaw running at http://localhost:${PORT}\n`);
    if (!isSetupComplete()) {
      console.log("  Setup required — open the URL above to get started.\n");
    } else {
      console.log("  Dashboard is live. WhatsApp connecting...\n");
      // Auto-connect WhatsApp if setup is complete
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
