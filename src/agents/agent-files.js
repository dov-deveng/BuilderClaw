/**
 * BuilderClaw — Agent File Storage
 * Each agent gets its own folder for generated documents.
 */
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../data-dir.js";

const AGENTS_DIR = path.join(DATA_DIR, "agents");

export function ensureAgentDir(agentId) {
  const dir = path.join(AGENTS_DIR, agentId, "files");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAgentDir(agentId) {
  return ensureAgentDir(agentId);
}

export function listAgentFiles(agentId) {
  const dir = ensureAgentDir(agentId);
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith("."))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

export function saveAgentFile(agentId, filename, content) {
  const dir = ensureAgentDir(agentId);
  // Sanitize filename
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const filePath = path.join(dir, safe);
  fs.writeFileSync(filePath, content, "utf-8");
  return safe;
}

export function readAgentFile(agentId, filename) {
  const dir = ensureAgentDir(agentId);
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dir, safe);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

export function deleteAgentFile(agentId, filename) {
  const dir = ensureAgentDir(agentId);
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dir, safe);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
