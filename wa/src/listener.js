// Listens to WhatsApp as a linked device (like WhatsApp Web) and saves every incoming message.
// It only reads: it never sends, reacts or marks messages as read.
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, getContentType,
  isJidBroadcast, isJidGroup, isJidStatusBroadcast, makeCacheableSignalKeyStore, normalizeMessageContent,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import { col } from "../../api/src/db.js";
import { ingestMessage } from "../../api/src/wa/ingest.js";
import { useMongoAuthState } from "./auth-state.js";

const logger = pino({ level: process.env.WA_LOG_LEVEL || "warn" });
const ONLY_GROUPS = process.env.WA_CHATS === "groups";       // ignore direct chats
const MAX_AGE_MS = 3 * 864e5;                                 // skip anything older than 3 days after a reconnect

const state = { connection: "starting", qr: null, me: null, error: null };
async function saveState(patch = {}) {
  Object.assign(state, patch);
  await col.wa_state.replaceOne({ _id: "listener" }, { ...state, seenAt: new Date().toISOString() }, { upsert: true });
}

const groupNames = new Map();
async function chatName(sock, jid, pushName) {
  if (!isJidGroup(jid)) return pushName || jid.split("@")[0];
  if (!groupNames.has(jid)) {
    try { groupNames.set(jid, (await sock.groupMetadata(jid)).subject || ""); }
    catch { groupNames.set(jid, (await col.wa_chats.findOne({ _id: jid }))?.name || ""); }
  }
  return groupNames.get(jid);
}

// Prefer the phone-number form of an id (…@s.whatsapp.net) over WhatsApp's private "lid" form,
// so direct chats can be matched to a workshop's phone number.
const pn = (a, b) => [a, b].find(j => j && j.endsWith("@s.whatsapp.net")) || a || b || "";

const TEXT_TYPES = { conversation: "text", extendedTextMessage: "text", imageMessage: "image", audioMessage: "audio",
  videoMessage: "video", documentMessage: "document", documentWithCaptionMessage: "document" };

async function handle(sock, msg) {
  const k = msg.key || {};
  if (!msg.message || k.fromMe || !k.remoteJid) return;
  if (isJidStatusBroadcast(k.remoteJid) || isJidBroadcast(k.remoteJid) || k.remoteJid.endsWith("@newsletter")) return;
  const group = isJidGroup(k.remoteJid);
  if (ONLY_GROUPS && !group) return;
  const ts = new Date(Number(msg.messageTimestamp || 0) * 1000 || Date.now());
  if (Date.now() - ts.getTime() > MAX_AGE_MS) return;

  const content = normalizeMessageContent(msg.message);
  const kind = getContentType(content);
  const type = TEXT_TYPES[kind];
  if (!type) return; // reactions, stickers, polls, protocol messages…
  const body = content[kind] || {};
  let text = typeof body === "string" ? body : body.text || body.caption || "";
  if (kind === "documentWithCaptionMessage") text = content.documentWithCaptionMessage?.message?.documentMessage?.caption || "";
  const quoted = body.contextInfo?.quotedMessage;
  if (quoted) {
    const q = normalizeMessageContent(quoted), qk = getContentType(q), qb = q?.[qk];
    const qt = typeof qb === "string" ? qb : qb?.text || qb?.caption || "";
    if (qt) text = `(replying to: "${qt.slice(0, 200)}") ${text}`;
  }

  let media;
  if (type === "image" || type === "audio") {
    try {
      const data = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      media = { mime: body.mimetype || (type === "audio" ? "audio/ogg" : "image/jpeg"), data };
    } catch (err) { logger.warn({ err: err.message }, "media download failed"); }
  }

  const chat = group ? k.remoteJid : pn(k.remoteJid, k.remoteJidAlt);
  const sender = group ? pn(k.participant, k.participantAlt) : chat;
  const saved = await ingestMessage({
    id: k.id, chat, chatName: await chatName(sock, k.remoteJid, msg.pushName), isGroup: !!group,
    sender, senderName: msg.pushName || "", ts: ts.toISOString(), type, text, media,
  });
  if (saved) logger.info({ chat, type }, "saved");
}

export async function startListener() {
  const auth = await useMongoAuthState(col.wa_auth);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use Baileys' built-in version */ }

  const sock = makeWASocket({
    version, logger, auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
    browser: Browsers.ubuntu("A2Z Auto Parts"),
    markOnlineOnConnect: false,   // so the phone keeps getting notifications
    syncFullHistory: false,
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", auth.saveCreds);
  sock.ev.on("groups.update", ups => ups.forEach(g => g.subject && groupNames.set(g.id, g.subject)));
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      try { await handle(sock, m); } catch (err) { console.error("[wa] could not save a message:", err.message); }
    }
  });
  sock.ev.on("connection.update", async u => {
    if (u.qr) await saveState({ connection: "qr", qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }), error: null });
    if (u.connection === "open") {
      await saveState({ connection: "open", qr: null, error: null, me: { id: sock.user?.id || "", name: sock.user?.name || "" } });
      console.log("[wa] connected as", sock.user?.id);
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: forget the login and show a fresh QR code.
        console.log("[wa] logged out; waiting for a new QR scan");
        await auth.clear();
        await saveState({ connection: "logged_out", qr: null, me: null, error: "Unlinked from the phone. Scan the new code." });
      } else {
        await saveState({ connection: "reconnecting", error: u.lastDisconnect?.error?.message || null });
      }
      // 440 = another copy of this service took over the same login (e.g. during a deploy). Back off so the two don't keep kicking each other off.
      const wait = code === DisconnectReason.loggedOut ? 1000 : code === DisconnectReason.connectionReplaced ? 90e3 : 3000;
      setTimeout(() => startListener().catch(err => console.error("[wa] restart failed:", err)), wait);
    }
  });

  return sock;
}

// Tells the app the listener is alive, even when nothing is arriving.
export function heartbeat() {
  saveState().catch(() => {});
  return setInterval(() => saveState().catch(() => {}), 30e3);
}
