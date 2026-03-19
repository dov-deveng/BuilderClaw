/**
 * BuilderClaw — WhatsApp Client (Baileys)
 * Connects to the contractor's WhatsApp, receives messages, sends responses.
 */
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, "..", "..", "data", "auth_info");

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.status = "disconnected"; // disconnected, connecting, connected, qr_pending
    this.qrCode = null;
    this.phoneNumber = null;
    this.messageQueue = [];
    this.processing = false;
  }

  async connect() {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.status = "connecting";
    this.emit("status", this.status);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["BuilderClaw", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: false,
    });

    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.status = "qr_pending";
        this.emit("qr", qr);
        this.emit("status", this.status);
      }

      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        this.status = "disconnected";
        this.emit("status", this.status);

        if (reason === DisconnectReason.loggedOut) {
          console.log("[whatsapp] Logged out. Clearing auth and stopping.");
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          this.emit("logged_out");
        } else {
          console.log(`[whatsapp] Disconnected (reason: ${reason}). Reconnecting in 5s...`);
          setTimeout(() => this.connect(), 5000);
        }
      }

      if (connection === "open") {
        this.status = "connected";
        this.qrCode = null;
        this.phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || "Unknown";
        console.log(`[whatsapp] Connected as ${this.phoneNumber}`);
        this.emit("status", this.status);
        this.emit("connected", this.phoneNumber);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip messages from self, status updates, and reactions
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;
        if (msg.message?.reactionMessage) continue;

        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || "";

        if (!text.trim()) continue;

        const sender = msg.key.remoteJid;
        const senderName = msg.pushName || sender.split("@")[0];

        console.log(`[whatsapp] Message from ${senderName}: ${text.slice(0, 80)}`);

        this.emit("message", {
          text: text.trim(),
          sender,
          senderName,
          timestamp: msg.messageTimestamp,
          raw: msg,
        });
      }
    });
  }

  async sendMessage(to, text) {
    if (!this.sock || this.status !== "connected") {
      console.error("[whatsapp] Cannot send — not connected");
      return false;
    }
    try {
      await this.sock.sendMessage(to, { text });
      console.log(`[whatsapp] Sent to ${to}: ${text.slice(0, 80)}`);
      return true;
    } catch (err) {
      console.error(`[whatsapp] Send error: ${err.message}`);
      return false;
    }
  }

  async disconnect() {
    if (this.sock) {
      try { await this.sock.logout(); } catch {}
      this.sock = null;
      this.status = "disconnected";
      this.emit("status", this.status);
    }
  }

  getStatus() {
    return {
      status: this.status,
      phoneNumber: this.phoneNumber,
      qrCode: this.qrCode,
    };
  }
}

// Singleton
const whatsapp = new WhatsAppClient();
export default whatsapp;
