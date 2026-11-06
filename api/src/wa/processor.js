// The WhatsApp worker: reads each batch of messages once the chat goes quiet.
//   1. transcribe voice notes   2. send text, transcripts and photos to Claude
//   3. sure enough and the workshop is known → create the enquiry (status "created")
//      otherwise → wait in the app's WhatsApp tab for someone to check it (status "review")
// Chit-chat and replies to quotes are kept but set aside (status "ignored").
//
// Batch statuses: open → processing → created | review | ignored | failed, and review/failed → created | dismissed.
// MongoDB is the queue: a batch is claimed with one atomic findOneAndUpdate, so two workers never read the same one.
import { col } from "../db.js";
import { aiEnabled, readChat } from "../ai.js";
import { transcribe, transcribeEnabled } from "./transcribe.js";
import { createEnquiry } from "../routes/records.js";
import { audit } from "./ingest.js";
import { findVins, decodeVin, vinLine } from "./vin.js";

const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
export const config = () => ({
  quietMs: num(process.env.WA_QUIET_SECONDS, 90) * 1000,          // wait this long after the last message
  maxWaitMs: num(process.env.WA_MAX_WAIT_MINUTES, 10) * 60e3,     // but never longer than this after the first
  autoAt: process.env.WA_AUTO_CONFIDENCE === "off" ? Infinity : num(process.env.WA_AUTO_CONFIDENCE, 0.85),
  maxAttempts: 3,
});

const iso = ms => new Date(ms).toISOString();
const hhmm = ts => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" });
const digits = s => String(s || "").replace(/\D/g, "");

// Which workshop does this chat belong to? A chat linked earlier wins; then the workshop's
// "WhatsApp group name"; then, for direct chats, the workshop's phone number.
export async function findCustomer(chat, chatName) {
  const c = await col.wa_chats.findOne({ _id: chat });
  if (c?.customerId && (await col.customers.findOne({ _id: c.customerId }))) return c.customerId;
  const name = String(chatName || c?.name || "").trim().toLowerCase();
  const all = await col.customers.find({}).toArray();
  if (name) {
    const hit = all.find(x => String(x.groups || "").split(/[,;\n]/).map(g => g.trim().toLowerCase()).filter(Boolean).includes(name));
    if (hit) return hit._id;
  }
  const d = digits(chat.split("@")[0]);
  if (!chat.endsWith("@g.us") && d.length >= 9) {
    const hit = all.find(x => { const p = digits(x.phone); return p.length >= 9 && (d.endsWith(p.slice(-9))); });
    if (hit) return hit._id;
  }
  return null;
}

export async function linkChat(chat, customerId) {
  await col.wa_chats.updateOne({ _id: chat }, { $set: { customerId } }, { upsert: true });
}

// The batch as readable lines: "[10:02] Imran: text", photos and voice notes marked.
function transcriptOf(msgs) {
  let photo = 0;
  return msgs.map(m => {
    const who = m.senderName || m.sender.split("@")[0] || "Someone";
    const t = `[${hhmm(m.ts)}] ${who}`;
    if (m.type === "image") { photo += m.photoId ? 1 : 0; return `${t} sent ${m.photoId ? "photo " + photo : "a photo that could not be saved"}${m.text ? ": " + m.text : ""}`; }
    if (m.type === "audio") return `${t} (voice note): ${m.transcript || "[could not be transcribed]"}`;
    if (m.type === "text") return `${t}: ${m.text}`;
    return `${t} sent a ${m.type}${m.text ? ": " + m.text : ""} [not read]`;
  }).join("\n");
}

// Builds and saves the enquiry for a batch. Used for automatic creation and when someone accepts a batch.
export async function enquiryFromBatch(batch, customerId, by, items) {
  const msgs = await col.wa_messages.find({ batchId: batch._id }).sort({ ts: 1 }).toArray();
  const x = batch.extraction || {};
  const list = (items || x.items || []).map(i => ({
    vehicle: i.vehicle, part: i.part, qty: i.qty, options: [{ quality: i.quality || "used" }],
  }));
  const sender = x.sender || msgs.find(m => m.senderName)?.senderName || "";
  const message = transcriptOf(msgs).slice(0, 5000);
  const notes = [...(x.vins || []).map(vinLine), x.notes ? "WhatsApp reader: " + x.notes : ""].filter(Boolean).join("\n");
  return createEnquiry({ customerId, sender, message, notes, items: list, photos: msgs.map(m => m.photoId).filter(Boolean) },
    by, { source: "whatsapp", waBatchId: batch._id, waChat: batch.chat });
}

export async function processBatch(batch) {
  const cfg = config();
  const msgs = await col.wa_messages.find({ batchId: batch._id }).sort({ ts: 1 }).toArray();

  // 1. Voice notes
  for (const m of msgs) {
    if (m.type !== "audio" || m.transcript != null || !m.mediaId) continue;
    let text = null;
    if (transcribeEnabled()) {
      const media = await col.wa_media.findOne({ _id: m.mediaId });
      if (media) text = await transcribe(Buffer.isBuffer(media.data) ? media.data : Buffer.from(media.data.buffer ?? media.data), media.mime);
    }
    m.transcript = text ?? "";
    await col.wa_messages.updateOne({ _id: m._id }, { $set: { transcript: m.transcript } });
  }

  const customerId = await findCustomer(batch.chat, batch.chatName);
  const set = { customerId, processedAt: iso(Date.now()) };

  // 2. Read it
  if (!aiEnabled()) {
    Object.assign(set, { status: "review", extraction: { kind: "enquiry", items: [], confidence: 0, notes: "Message reading is off (no ANTHROPIC_API_KEY). Add the items by hand." } });
  } else {
    const images = [];
    for (const m of msgs) {
      if (!m.photoId || images.length >= 6) continue;
      const p = await col.photos.findOne({ _id: m.photoId });
      if (p) images.push({ mime: p.mime, data: Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data.buffer ?? p.data) });
    }
    // VINs typed in the chat (or said in a voice note) → official make, model and year for the reader.
    const vinText = msgs.map(m => [m.text, m.transcript].filter(Boolean).join(" ")).join("\n");
    const vins = await Promise.all(findVins(vinText).map(decodeVin));
    let transcript = transcriptOf(msgs);
    if (vins.length) transcript += "\n\nVIN lookups (from an official VIN decoder):\n" + vins.map(vinLine).join("\n");
    const x = await readChat({ transcript, images });
    x.vins = vins;
    set.extraction = x;
    if (x.kind !== "enquiry") set.status = "ignored";
    else if (customerId && x.items.length && x.confidence >= cfg.autoAt) set.status = "created";
    else set.status = "review";
  }

  // 3. Create or leave for review
  if (set.status === "created") {
    const enq = await enquiryFromBatch(Object.assign({}, batch, set), customerId, "whatsapp");
    if (enq) { set.enquiryId = enq._id; set.enqNo = enq.enqNo; }
    else set.status = "review";
  }
  await col.wa_batches.updateOne({ _id: batch._id }, { $set: set });
  await audit(batch._id, set.status === "created" ? "auto_created" : set.status, "whatsapp",
    { kind: set.extraction?.kind, confidence: set.extraction?.confidence, items: set.extraction?.items?.length || 0, enquiryId: set.enquiryId || null });
  return set;
}

// Claims and reads every batch that is due. Returns how many were handled.
export async function processDue(now = Date.now()) {
  const cfg = config();
  // A worker that died mid-batch leaves it "processing"; hand it back after 10 minutes.
  await col.wa_batches.updateMany({ status: "processing", lockedAt: { $lt: iso(now - 10 * 60e3) } }, { $set: { status: "open" } });
  let handled = 0;
  for (;;) {
    let b = await col.wa_batches.findOneAndUpdate(
      { status: "open", lastAt: { $lte: iso(now - cfg.quietMs) } },
      { $set: { status: "processing", lockedAt: iso(now) } }, { returnDocument: "after" });
    if (!b) b = await col.wa_batches.findOneAndUpdate(
      { status: "open", firstAt: { $lte: iso(now - cfg.maxWaitMs) } },
      { $set: { status: "processing", lockedAt: iso(now) } }, { returnDocument: "after" });
    if (!b) break;
    handled++;
    try { await processBatch(b); }
    catch (err) {
      const attempts = (b.attempts || 0) + 1;
      const failed = attempts >= cfg.maxAttempts;
      console.error(`[wa] batch ${b._id} failed (attempt ${attempts}):`, err.message);
      // Retry later: put it back as open, due again after another quiet period.
      await col.wa_batches.updateOne({ _id: b._id }, { $set: { status: failed ? "failed" : "open", attempts, error: err.message.slice(0, 300), lastAt: iso(now) } });
      await audit(b._id, failed ? "failed" : "retry", "whatsapp", { error: err.message.slice(0, 300), attempts });
    }
  }
  return handled;
}

export function startProcessor(everyMs = 10e3) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await processDue(); } catch (err) { console.error("[wa] worker:", err.message); } finally { busy = false; }
  };
  tick();
  return setInterval(tick, everyMs);
}
