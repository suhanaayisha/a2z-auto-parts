// Saving incoming WhatsApp messages. The listener (wa/src/listener.js) turns each Baileys message into
// a plain object and calls ingestMessage; nothing here depends on Baileys, so tests can call it directly.
//
// Messages from one chat that arrive close together (text, then a photo, then a voice note) go into one
// "batch". The worker reads a batch once the chat has been quiet for a while (see processor.js).
import crypto from "node:crypto";
import { col } from "../db.js";

const rid = p => p + crypto.randomBytes(7).toString("hex");
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE = 4 * 1024 * 1024, MAX_AUDIO = 16 * 1024 * 1024;

export async function audit(batchId, action, by, detail = {}) {
  await col.wa_audit.insertOne({ _id: rid("a"), at: new Date().toISOString(), batchId, action, by, detail });
}

// m: { id, chat, chatName, isGroup, sender, senderName, ts (ISO), type: text|image|audio|video|document|other,
//      text, media?: { mime, data: Buffer } }
// Returns the saved message, or null if it was a duplicate.
// The team's own WhatsApp numbers (Settings → Your company), read at most every 30 seconds.
let team = { at: 0, list: [] };
const last9 = s => String(s || "").split("@")[0].split(":")[0].replace(/\D/g, "").slice(-9);
export async function isTeamNumber(jid) {
  if (Date.now() - team.at > 30e3) {
    const co = await col.settings.findOne({ _id: "company" });
    team = { at: Date.now(), list: (co?.teamNumbers || []).map(last9).filter(x => x.length === 9) };
  }
  const d = last9(jid);
  return d.length === 9 && team.list.includes(d);
}
export function forgetTeamNumbers() { team.at = 0; }

export async function ingestMessage(m) {
  if (await col.wa_messages.findOne({ _id: m.id })) return null; // WhatsApp can deliver the same message twice

  // Messages from the team (e.g. a salesperson replying with prices from another phone) are kept for the
  // record but never batched, so they are never read as a workshop's request.
  if (await isTeamNumber(m.sender)) {
    const doc = { _id: m.id, chat: m.chat, batchId: null, fromTeam: true, sender: m.sender || "", senderName: m.senderName || "", ts: m.ts,
      type: m.type, text: String(m.text || "").slice(0, 5000), photoId: null, mediaId: null, transcript: null, note: "From the team", receivedAt: new Date().toISOString() };
    await col.wa_messages.insertOne(doc);
    return doc;
  }

  let photoId = null, mediaId = null, note = "";
  if (m.media?.data?.length) {
    const mime = String(m.media.mime || "").split(";")[0];
    if (m.type === "image" && IMAGE_TYPES.includes(mime) && m.media.data.length <= MAX_IMAGE) {
      // Same store and id format as photos uploaded in the app, so they show on the enquiry.
      photoId = "p" + crypto.randomBytes(7).toString("hex");
      await col.photos.insertOne({ _id: photoId, mime, size: m.media.data.length, data: m.media.data, createdAt: new Date().toISOString(), by: "whatsapp" });
    } else if (m.type === "audio" && m.media.data.length <= MAX_AUDIO) {
      mediaId = rid("m");
      await col.wa_media.insertOne({ _id: mediaId, mime, size: m.media.data.length, data: m.media.data, createdAt: new Date().toISOString() });
    } else note = "Not stored (type or size)";
  }

  await col.wa_chats.updateOne({ _id: m.chat },
    { $set: { name: m.chatName || "", isGroup: !!m.isGroup, lastAt: m.ts } }, { upsert: true });

  // Join the chat's open batch, or start one.
  const now = new Date().toISOString();
  const batch = await col.wa_batches.findOneAndUpdate(
    { chat: m.chat, status: "open" },
    { $push: { messageIds: m.id }, $set: { lastAt: now, chatName: m.chatName || "" },
      $setOnInsert: { _id: rid("b"), firstAt: now, attempts: 0, createdAt: now } },
    { upsert: true, returnDocument: "after" });

  const doc = {
    _id: m.id, chat: m.chat, batchId: batch._id, sender: m.sender || "", senderName: m.senderName || "", ts: m.ts,
    type: m.type, text: String(m.text || "").slice(0, 5000), photoId, mediaId, transcript: null, note, receivedAt: now,
  };
  await col.wa_messages.insertOne(doc);
  return doc;
}
