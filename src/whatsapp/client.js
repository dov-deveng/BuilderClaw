/**
 * BuilderClaw — WhatsApp Client (Baileys)
 * Connects to the contractor's WhatsApp.
 *
 * Two modes:
 *   1. PASSIVE COLLECTION — stores every message from every chat into whatsapp_inbox.
 *      Voice notes, images, and documents are downloaded to data/media/.
 *      No API calls, no analysis — just raw storage for later reports.
 *
 *   2. ACTIVE RESPONSE — only in self-chat (DM with Claw's own number).
 *      Contractor messages themselves → Claw responds. Nobody else can trigger it.
 *      This prevents runaway API usage and sensitive info leaks.
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";
import { DATA_DIR } from "../data-dir.js";
import { storeInboxMessage } from "../memory/db.js";

const AUTH_DIR = path.join(DATA_DIR, "auth_info");
const MEDIA_DIR = path.join(DATA_DIR, "media");

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.status = "disconnected"; // disconnected, connecting, connected, qr_pending
    this.qrCode = null;
    this.phoneNumber = null;
    this.selfJid = null; // e.g. "1234567890@s.whatsapp.net"
    this.messageQueue = [];
    this.processing = false;
    this.groupMetadata = new Map(); // jid → { subject, participants }
  }

  async connect() {
    // Clean up previous socket to prevent duplicate event handlers
    if (this.sock) {
      try { this.sock.ev.removeAllListeners(); } catch {}
      this.sock = null;
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
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
      syncFullHistory: false,
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
        const rawId = sock.user?.id || "";
        this.phoneNumber = rawId.split(":")[0] || rawId.split("@")[0] || "Unknown";
        this.selfJid = this.phoneNumber + "@s.whatsapp.net";
        console.log(`[whatsapp] Connected as ${this.phoneNumber}`);
        this.emit("status", this.status);
        this.emit("connected", this.phoneNumber);
      }
    });

    // --- Passive collection: store EVERY message from EVERY chat ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        const jid = msg.key?.remoteJid || "";

        // Skip status broadcasts and newsletters
        if (jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "status@broadcast") continue;

        // Skip reactions (no useful content)
        if (msg.message?.reactionMessage) continue;

        const isGroup = jid.endsWith("@g.us");
        const isFromMe = msg.key?.fromMe || false;
        const isSelfChat = this.selfJid ? jid === this.selfJid : false;

        // Extract text content
        const rawMsg = msg.message || {};
        const text = rawMsg.conversation
          || rawMsg.extendedTextMessage?.text
          || rawMsg.imageMessage?.caption
          || rawMsg.videoMessage?.caption
          || rawMsg.documentMessage?.caption
          || "";

        // Determine media type
        let mediaType = null;
        if (rawMsg.imageMessage) mediaType = "image";
        else if (rawMsg.audioMessage) mediaType = rawMsg.audioMessage.ptt ? "voice_note" : "audio";
        else if (rawMsg.videoMessage) mediaType = "video";
        else if (rawMsg.documentMessage) mediaType = "document";
        else if (rawMsg.stickerMessage) mediaType = "sticker";

        // Download media to disk (async, don't block message processing)
        let mediaPath = null;
        if (mediaType && mediaType !== "sticker") {
          mediaPath = await this._downloadMedia(msg, jid, mediaType).catch((err) => {
            console.error(`[whatsapp] Media download failed: ${err.message}`);
            return null;
          });
        }

        // Get sender info
        const senderJid = isGroup ? (msg.key?.participant || jid) : jid;
        const senderName = msg.pushName || senderJid.split("@")[0];

        // Get chat name (cache group metadata)
        let chatName = null;
        if (isGroup) {
          chatName = await this._getGroupName(jid);
        } else {
          chatName = msg.pushName || jid.split("@")[0];
        }

        // Store to inbox (passive — no API calls)
        const msgId = msg.key?.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timestamp = msg.messageTimestamp
          ? (typeof msg.messageTimestamp === "number" ? msg.messageTimestamp * 1000 : Number(msg.messageTimestamp) * 1000)
          : Date.now();

        try {
          storeInboxMessage({
            id: msgId,
            chat_jid: jid,
            chat_name: chatName,
            sender_jid: senderJid,
            sender_name: senderName,
            content: text || (mediaType ? `[${mediaType}]` : null),
            media_type: mediaType,
            media_path: mediaPath,
            is_from_me: isFromMe,
            is_group: isGroup,
            timestamp,
          });
        } catch (err) {
          // Duplicate message ID — safe to ignore
          if (!err.message?.includes("UNIQUE constraint")) {
            console.error(`[whatsapp] Inbox store error: ${err.message}`);
          }
        }

        // --- ACTIVE RESPONSE: only in self-chat, only from me ---
        if (isSelfChat && isFromMe && text.trim()) {
          const trigger = this.triggerWord || "@Claw";
          if (text.toLowerCase().includes(trigger.toLowerCase())) {
            const cleanText = text.replace(new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
            if (cleanText) {
              console.log(`[whatsapp] [self-chat] Task: ${cleanText.slice(0, 80)}`);
              this.emit("message", {
                text: cleanText,
                sender: jid,
                senderName: "You",
                timestamp: msg.messageTimestamp,
                raw: msg,
              });
            }
          }
        }
      }
    });
  }

  /**
   * Download media from a WhatsApp message to disk.
   * Returns the file path on success, null on failure.
   */
  async _downloadMedia(msg, chatJid, mediaType) {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, {
        reuploadRequest: this.sock.updateMediaMessage,
        logger: this.sock.logger,
      });

      if (!buffer || buffer.length === 0) return null;

      // Determine extension from mime type
      const rawMsg = msg.message || {};
      const mimetype = rawMsg.imageMessage?.mimetype
        || rawMsg.audioMessage?.mimetype
        || rawMsg.videoMessage?.mimetype
        || rawMsg.documentMessage?.mimetype
        || "";

      const ext = this._mimeToExt(mimetype, mediaType);
      const safeChatId = chatJid.replace(/[^a-zA-Z0-9@._-]/g, "");
      const chatMediaDir = path.join(MEDIA_DIR, safeChatId);
      fs.mkdirSync(chatMediaDir, { recursive: true });

      // Use document filename if available
      const docName = rawMsg.documentMessage?.fileName;
      const filename = docName
        ? docName.replace(/[^a-zA-Z0-9._-]/g, "_")
        : `${mediaType}-${Date.now()}${ext}`;

      const filePath = path.join(chatMediaDir, filename);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      return null;
    }
  }

  _mimeToExt(mimetype, mediaType) {
    const map = {
      "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
      "video/mp4": ".mp4", "audio/ogg; codecs=opus": ".ogg", "audio/mpeg": ".mp3",
      "application/pdf": ".pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    };
    if (map[mimetype]) return map[mimetype];
    // Fallback by media type
    const fallback = { image: ".jpg", voice_note: ".ogg", audio: ".mp3", video: ".mp4", document: ".bin" };
    return fallback[mediaType] || ".bin";
  }

  async _getGroupName(jid) {
    if (this.groupMetadata.has(jid)) return this.groupMetadata.get(jid);
    try {
      const meta = await this.sock.groupMetadata(jid);
      const name = meta?.subject || jid;
      this.groupMetadata.set(jid, name);
      return name;
    } catch {
      return jid;
    }
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
