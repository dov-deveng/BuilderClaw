/**
 * BuilderClaw — Credential Proxy
 * Containers route API calls through this proxy via ANTHROPIC_BASE_URL.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request.
 *
 * BuilderClaw credential proxy.
 */
import { createServer } from "http";
import { request as httpsRequest } from "https";
import { execSync } from "child_process";
import fs from "fs";
import { getEnvPath } from "../data-dir.js";

function readSecrets() {
  const envFile = getEnvPath();
  const result = {};
  if (!fs.existsSync(envFile)) return result;
  const content = fs.readFileSync(envFile, "utf-8");
  const wanted = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}

export function detectAuthMode() {
  const secrets = readSecrets();
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN) return "oauth";
  if (secrets.ANTHROPIC_API_KEY) return "api-key";
  return "oauth";
}

let proxyServer = null;

export function stopCredentialProxy() {
  if (proxyServer) {
    try { proxyServer.close(); } catch {}
    proxyServer = null;
  }
}

export function startCredentialProxy(port = 3001, host = "127.0.0.1") {
  // Kill any existing proxy first
  stopCredentialProxy();

  const secrets = readSecrets();
  const authMode = detectAuthMode();
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  if (!secrets.ANTHROPIC_API_KEY && !oauthToken) {
    console.warn("[credential-proxy] No API key or OAuth token found in .env — proxy won't inject credentials");
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = { ...req.headers, host: "api.anthropic.com", "content-length": body.length };

        delete headers["connection"];
        delete headers["keep-alive"];
        delete headers["transfer-encoding"];

        if (authMode === "api-key") {
          delete headers["x-api-key"];
          headers["x-api-key"] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers["authorization"]) {
            delete headers["authorization"];
            if (oauthToken) {
              headers["authorization"] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = httpsRequest(
          {
            hostname: "api.anthropic.com",
            port: 443,
            path: req.url,
            method: req.method,
            headers,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on("error", (err) => {
          console.error("[credential-proxy] Upstream error:", err.message);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end("Bad Gateway");
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      proxyServer = server;
      console.log(`[credential-proxy] Started on ${host}:${port} (mode: ${authMode})`);
      resolve(server);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`[credential-proxy] Port ${port} in use, retrying...`);
        // Try to kill whatever's on the port and retry once
        try {
          execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, { timeout: 3000 });
        } catch {}
        setTimeout(() => {
          server.listen(port, host, () => {
            proxyServer = server;
            console.log(`[credential-proxy] Started on ${host}:${port} (mode: ${authMode}) [retry]`);
            resolve(server);
          });
          server.on("error", reject);
        }, 1000);
      } else {
        reject(err);
      }
    });
  });
}
