/**
 * BuilderClaw — Data Directory Resolution
 * In Electron (packaged): ~/Library/Application Support/BuilderClaw
 * In dev (node src/index.js): ./data (project root)
 */
import path from "path";
import os from "os";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  // Electron packaged app: use standard macOS app support directory
  if (process.resourcesPath) {
    return path.join(os.homedir(), "Library", "Application Support", "BuilderClaw");
  }
  // Dev mode: use project root /data
  return path.join(__dirname, "..", "data");
}

export const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

// Also export PROJECT_ROOT for .env file access
export function getEnvPath() {
  if (process.resourcesPath) {
    // In packaged app, store .env in data dir (not inside .app bundle)
    return path.join(DATA_DIR, ".env");
  }
  return path.join(__dirname, "..", ".env");
}
