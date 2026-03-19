/**
 * BuilderClaw — SQLite Database Layer
 * Stores conversations, company profile, contacts, projects, config.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

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
`);

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
export function saveMessage(role, direction, content, sender, metadata) {
  return db.prepare(
    "INSERT INTO messages (role, direction, content, sender, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(role, direction, content, sender || null, Date.now(), metadata ? JSON.stringify(metadata) : null);
}

export function getMessages(limit = 50, offset = 0) {
  return db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(limit, offset);
}

export function getMessagesByRole(role, limit = 20) {
  return db.prepare("SELECT * FROM messages WHERE role = ? ORDER BY timestamp DESC LIMIT ?").all(role, limit);
}

export function getMessageCount() {
  return db.prepare("SELECT COUNT(*) as count FROM messages").get().count;
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

export { db };
