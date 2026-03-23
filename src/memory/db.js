/**
 * BuilderClaw — SQLite Database Layer
 * Stores conversations, company profile, contacts, projects, config.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../data-dir.js";

const db = new Database(path.join(DATA_DIR, "builderclaw.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    direction TEXT NOT NULL,
    sender TEXT,
    content TEXT NOT NULL,
    timestamp INTEGER DEFAULT (unixepoch() * 1000),
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS company (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT,
    trade TEXT,
    state TEXT,
    team_size TEXT,
    pain_point TEXT,
    updated_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    status TEXT DEFAULT 'active',
    notes TEXT,
    mentioned_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    company TEXT,
    phone TEXT,
    email TEXT,
    mentioned_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS cost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    timestamp INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT,
    icon TEXT,
    prompt_file TEXT,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    UNIQUE(agent_id, key)
  );

  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    config TEXT,
    PRIMARY KEY (agent_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS whatsapp_inbox (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    chat_name TEXT,
    sender_jid TEXT,
    sender_name TEXT,
    content TEXT,
    media_type TEXT,
    media_path TEXT,
    is_from_me INTEGER DEFAULT 0,
    is_group INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_chat ON whatsapp_inbox(chat_jid);
  CREATE INDEX IF NOT EXISTS idx_inbox_ts ON whatsapp_inbox(timestamp);

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    task_prompt TEXT NOT NULL,
    agent_id TEXT DEFAULT 'claw',
    interval_minutes INTEGER DEFAULT 0,
    next_run INTEGER NOT NULL,
    last_run INTEGER,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );
`);

// --- Migrations ---
try {
  const cols = db.prepare("PRAGMA table_info(messages)").all();
  if (!cols.find(c => c.name === "agent_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN agent_id TEXT DEFAULT 'claw'");
  }
} catch {}

// Migrate prompt_file: bear.md → claw.md for existing installs
try {
  db.prepare("UPDATE agents SET prompt_file = 'claw.md' WHERE id = 'claw' AND prompt_file = 'bear.md'").run();
} catch {}

// --- Seed default agents ---
const DEFAULT_AGENTS = [
  { id: "claw", name: "Claw", role: "Your main point of contact. Routes tasks, answers questions.", icon: "/assets/claw-mascot.png", prompt_file: "claw.md" },
  { id: "pm", name: "PM", role: "Schedules, timelines, task tracking, punch lists.", icon: "📋", prompt_file: "pm.md" },
  { id: "estimator", name: "Estimator", role: "Takeoffs, material estimates, labor calcs, bids.", icon: "📐", prompt_file: "estimator.md" },
  { id: "accounts", name: "Accounts", role: "Invoicing, payments, lien waivers, budgets.", icon: "💰", prompt_file: "accounts.md" },
  { id: "safety", name: "Safety", role: "OSHA compliance, toolbox talks, incident reports.", icon: "🦺", prompt_file: "safety.md" },
  { id: "marketing", name: "Marketing", role: "Social media, proposals, client outreach, brand.", icon: "📣", prompt_file: "marketing.md" },
];

const seedAgent = db.prepare("INSERT OR IGNORE INTO agents (id, name, role, icon, prompt_file) VALUES (?, ?, ?, ?, ?)");
for (const a of DEFAULT_AGENTS) {
  seedAgent.run(a.id, a.name, a.role, a.icon, a.prompt_file);
}

// --- Config ---
export function getConfig(key) {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

// --- Company ---
export function getCompany() {
  return db.prepare("SELECT * FROM company WHERE id = 1").get() || null;
}

export function saveCompany(data) {
  db.prepare(`
    INSERT OR REPLACE INTO company (id, name, trade, state, team_size, pain_point, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(data.name, data.trade, data.state, data.team_size, data.pain_point || null, Date.now());
}

// --- Messages ---
export function saveMessage(role, direction, content, sender, metadata, agentId = "claw") {
  return db.prepare(
    "INSERT INTO messages (role, direction, content, sender, timestamp, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(role, direction, content, sender || null, Date.now(), metadata ? JSON.stringify(metadata) : null, agentId);
}

export function getMessages(limit = 50, offset = 0, agentId = null) {
  if (agentId) {
    return db.prepare("SELECT * FROM messages WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(agentId, limit, offset);
  }
  return db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(limit, offset);
}

export function getMessagesByRole(role, limit = 20) {
  return db.prepare("SELECT * FROM messages WHERE role = ? ORDER BY timestamp DESC LIMIT ?").all(role, limit);
}

export function getRecentAgentMessages(agentId, limit = 10) {
  return db.prepare("SELECT * FROM messages WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?").all(agentId, limit);
}

export function getMessageCount() {
  return db.prepare("SELECT COUNT(*) as count FROM messages").get().count;
}

// --- Agents ---
export function getAgents() {
  return db.prepare("SELECT * FROM agents WHERE enabled = 1 ORDER BY created_at").all();
}

export function getAgent(id) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

export function createAgent(data) {
  return db.prepare(
    "INSERT OR REPLACE INTO agents (id, name, role, icon, prompt_file, enabled) VALUES (?, ?, ?, ?, ?, 1)"
  ).run(data.id, data.name, data.role || "", data.icon || "🤖", data.prompt_file || null);
}

export function updateAgent(id, data) {
  const ALLOWED = new Set(["name", "role", "icon", "prompt_file", "enabled"]);
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (!ALLOWED.has(k)) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// --- Agent Memory ---
export function getAgentMemory(agentId) {
  return db.prepare("SELECT key, value, updated_at FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC").all(agentId);
}

export function setAgentMemory(agentId, key, value) {
  db.prepare(
    "INSERT INTO agent_memory (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(agentId, key, value, Date.now());
}

export function deleteAgentMemory(agentId, key) {
  db.prepare("DELETE FROM agent_memory WHERE agent_id = ? AND key = ?").run(agentId, key);
}

export function getAgentMemorySummary(agentId) {
  const memories = db.prepare("SELECT key, value FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 20").all(agentId);
  if (memories.length === 0) return "";
  return "YOUR SAVED MEMORIES (use these naturally, don't announce them):\n" +
    memories.map(m => `- ${m.key}: ${m.value}`).join("\n");
}

// --- Agent Skills ---
export function getAgentSkills(agentId) {
  return db.prepare("SELECT * FROM agent_skills WHERE agent_id = ? AND enabled = 1").all(agentId);
}

export function setAgentSkill(agentId, skillId, enabled, config = null) {
  db.prepare(
    "INSERT INTO agent_skills (agent_id, skill_id, enabled, config) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, skill_id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config"
  ).run(agentId, skillId, enabled ? 1 : 0, config);
}

// --- Projects ---
export function getProjects() {
  return db.prepare("SELECT * FROM projects ORDER BY mentioned_at DESC").all();
}

export function saveProject(data) {
  return db.prepare(
    "INSERT INTO projects (name, address, status, notes, mentioned_at) VALUES (?, ?, ?, ?, ?)"
  ).run(data.name, data.address || null, data.status || "active", data.notes || null, Date.now());
}

export function updateProject(id, data) {
  const ALLOWED = new Set(["name", "address", "status", "notes"]);
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (!ALLOWED.has(k)) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteProject(id) {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// --- Contacts ---
export function getContacts() {
  return db.prepare("SELECT * FROM contacts ORDER BY mentioned_at DESC").all();
}

export function saveContact(data) {
  return db.prepare(
    "INSERT INTO contacts (name, role, company, phone, email, mentioned_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(data.name, data.role || null, data.company || null, data.phone || null, data.email || null, Date.now());
}

export function updateContact(id, data) {
  const ALLOWED = new Set(["name", "role", "company", "phone", "email"]);
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (!ALLOWED.has(k)) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteContact(id) {
  db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
}

// --- Cost tracking ---
export function logCost(role, tokensIn, tokensOut) {
  db.prepare("INSERT INTO cost_log (role, tokens_in, tokens_out, timestamp) VALUES (?, ?, ?, ?)").run(
    role, tokensIn || 0, tokensOut || 0, Date.now()
  );
}

export function getCostToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return db.prepare(
    "SELECT SUM(tokens_in) as total_in, SUM(tokens_out) as total_out, COUNT(*) as calls FROM cost_log WHERE timestamp >= ?"
  ).get(startOfDay.getTime());
}

export function getCostByRole() {
  return db.prepare(
    "SELECT role, SUM(tokens_in) as total_in, SUM(tokens_out) as total_out, COUNT(*) as calls FROM cost_log GROUP BY role"
  ).all();
}

// --- Context builder (injected into every agent system prompt) ---
export function buildContractorContext() {
  const company = getCompany();
  if (!company) return "";

  const projects = getProjects().filter(p => p.status === "active");
  const contacts = getContacts();

  let ctx = `CONTRACTOR CONTEXT (use this silently, never reference it directly):
Company: ${company.name || "Unknown"}, ${company.trade || "General Contractor"}, based in ${company.state || "Unknown"}
Team size: ${company.team_size || "Unknown"}`;

  if (projects.length > 0) {
    ctx += `\nActive projects: ${projects.map(p => p.name).join(", ")}`;
  }
  if (contacts.length > 0) {
    ctx += `\nKnown contacts: ${contacts.map(c => `${c.name}${c.role ? " (" + c.role + ")" : ""}`).join(", ")}`;
  }

  return ctx;
}

// --- Scheduled Tasks ---
export function createScheduledTask(data) {
  return db.prepare(
    "INSERT INTO scheduled_tasks (name, description, task_prompt, agent_id, interval_minutes, next_run) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(data.name, data.description || null, data.task_prompt, data.agent_id || "claw", data.interval_minutes || 0, data.next_run);
}

export function getScheduledTasks() {
  return db.prepare("SELECT * FROM scheduled_tasks ORDER BY next_run").all();
}

export function getDueTasks(now) {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run <= ?").all(now);
}

export function updateTaskAfterRun(id, lastRun) {
  const task = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
  if (!task) return;
  if (task.interval_minutes > 0) {
    const nextRun = lastRun + task.interval_minutes * 60 * 1000;
    db.prepare("UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?").run(lastRun, nextRun, id);
  } else {
    // One-time task: disable after running
    db.prepare("UPDATE scheduled_tasks SET last_run = ?, enabled = 0 WHERE id = ?").run(lastRun, id);
  }
}

export function deleteScheduledTask(id) {
  db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
}

// --- WhatsApp Inbox (passive collection) ---
export function storeInboxMessage(msg) {
  db.prepare(`
    INSERT OR IGNORE INTO whatsapp_inbox (id, chat_jid, chat_name, sender_jid, sender_name, content, media_type, media_path, is_from_me, is_group, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.chat_jid, msg.chat_name || null, msg.sender_jid || null,
    msg.sender_name || null, msg.content || null, msg.media_type || null,
    msg.media_path || null, msg.is_from_me ? 1 : 0, msg.is_group ? 1 : 0,
    msg.timestamp
  );
}

export function getInboxMessages(chatJid, limit = 50) {
  if (chatJid) {
    return db.prepare("SELECT * FROM whatsapp_inbox WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?").all(chatJid, limit);
  }
  return db.prepare("SELECT * FROM whatsapp_inbox ORDER BY timestamp DESC LIMIT ?").all(limit);
}

export function getInboxChats() {
  return db.prepare(`
    SELECT chat_jid, chat_name, is_group, MAX(timestamp) as last_message, COUNT(*) as message_count
    FROM whatsapp_inbox GROUP BY chat_jid ORDER BY last_message DESC
  `).all();
}

export function getInboxSearch(query, limit = 50) {
  return db.prepare("SELECT * FROM whatsapp_inbox WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?").all(`%${query}%`, limit);
}

export { db };
