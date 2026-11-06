// Quotes sent from the app to WhatsApp (Phase 2).
//
// Pressing Send on an enquiry puts a message in wa_outbox. The listener, which holds the WhatsApp connection,
// sends one at a time, as a reply to the workshop's original request when there is one.
// Every sent message is also recorded in wa_prices (status "sent_from_app"), so the workshop's reply to it
// ("OK", "1A 2B") is noted on the enquiry, exactly like replies to prices a salesperson typed.
//
// Outbox statuses: queued → sending → sent | failed. A message that can't go out within 15 minutes
// (WhatsApp not connected) fails rather than arriving hours late.
import crypto from "node:crypto";
import { col } from "../db.js";
import { audit } from "./ingest.js";
import { findCustomer } from "./processor.js";

const EXPIRE_MS = 15 * 60e3;
const rid = p => p + crypto.randomBytes(7).toString("hex");
const iso = ms => new Date(ms).toISOString();

export const sendingEnabled = co => co?.waSending !== false;

export async function listenerConnected(now = Date.now()) {
  const s = await col.wa_state.findOne({ _id: "listener" });
  return !!s && s.connection === "open" && now - new Date(s.seenAt).getTime() < 120e3;
}

// Where an enquiry's quote goes: the chat it came from, as a reply to the workshop's request;
// or, for an enquiry typed in by hand, the workshop's most recent WhatsApp chat (not as a reply).
export async function sendTarget(e) {
  if (e.waChat) {
    const chat = await col.wa_chats.findOne({ _id: e.waChat });
    let quoted = null;
    if (e.waBatchId) {
      const msgs = (await col.wa_messages.find({ batchId: e.waBatchId }).toArray()).sort((a, z) => (a.ts < z.ts ? -1 : 1));
      const m = msgs.find(x => (x.body ?? x.text)) || msgs[0];
      if (m) quoted = { id: m._id, participant: m.participant || (e.waChat.endsWith("@g.us") ? m.sender : undefined), text: String(m.body ?? m.text ?? "").slice(0, 300), by: m.senderName || "" };
    }
    return { chat: e.waChat, chatName: chat?.name || "", quoted };
  }
  if (!e.customerId) return null;
  const chats = (await col.wa_chats.find({}).toArray()).sort((a, z) => (a.lastAt < z.lastAt ? 1 : -1));
  for (const c of chats) if ((c.customerId || (await findCustomer(c._id, c.name))) === e.customerId) return { chat: c._id, chatName: c.name || "", quoted: null };
  return null;
}

export async function queueSend(e, text, userId) {
  const target = await sendTarget(e);
  if (!target) return { status: 400, error: "This workshop has no WhatsApp chat yet. Add its group name under Customers, or use Copy." };
  const now = iso(Date.now());
  const job = { _id: rid("o"), enquiryId: e._id, enqNo: e.enqNo, quoteNo: e.quoteNo, quoteRev: e.quoteRev, chat: target.chat, chatName: target.chatName,
    quoted: target.quoted ? { id: target.quoted.id, participant: target.quoted.participant, text: target.quoted.text } : null,
    text, status: "queued", attempts: 0, by: userId, createdAt: now };
  await col.wa_outbox.insertOne(job);
  const waSent = { outboxId: job._id, status: "queued", at: now, by: userId, chatName: target.chatName, quoteRev: e.quoteRev || 1 };
  await col.enquiries.updateOne({ _id: e._id }, { $set: { waSent } });
  await audit(job._id, "send_queued", userId, { enquiryId: e._id, chat: target.chat });
  return { enquiry: { ...e, waSent } };
}

async function setEnquiry(job, patch) {
  const e = await col.enquiries.findOne({ _id: job.enquiryId });
  if (e?.waSent?.outboxId === job._id) await col.enquiries.updateOne({ _id: e._id }, { $set: { waSent: { ...e.waSent, ...patch } } });
}

// Sends the oldest queued message, if any. send(job) → the sent message's id. Called by the listener every few seconds.
export async function processOutbox(send, now = Date.now()) {
  for (const old of await col.wa_outbox.find({ status: "queued" }).toArray()) {
    if (now - new Date(old.createdAt).getTime() > EXPIRE_MS) {
      const error = "Not sent: WhatsApp wasn't connected within 15 minutes. Press Send again or use Copy.";
      await col.wa_outbox.updateOne({ _id: old._id, status: "queued" }, { $set: { status: "failed", error } });
      await setEnquiry(old, { status: "failed", error });
      await audit(old._id, "send_expired", "whatsapp", { enquiryId: old.enquiryId });
    }
  }
  const next = (await col.wa_outbox.find({ status: "queued" }).sort({ createdAt: 1 }).limit(1).toArray())[0];
  if (!next) return null;
  const job = await col.wa_outbox.findOneAndUpdate({ _id: next._id, status: "queued" }, { $set: { status: "sending", lockedAt: iso(now) } }, { returnDocument: "after" });
  if (!job) return null;
  try {
    const messageId = await send(job);
    const sentAt = iso(now);
    await col.wa_outbox.updateOne({ _id: job._id }, { $set: { status: "sent", messageId, sentAt } });
    await setEnquiry(job, { status: "sent", sentAt, messageId, error: null });
    // So the workshop's reply to this message finds the enquiry (see prices.js → noteWorkshopReplies).
    await col.wa_prices.insertOne({ _id: rid("q"), messageId, chat: job.chat, chatName: job.chatName, sender: "app", senderName: "Sent from the app",
      ts: sentAt, text: job.text, status: "sent_from_app", enquiryId: job.enquiryId, enqNo: job.enqNo, createdAt: sentAt });
    await audit(job._id, "sent", "whatsapp", { enquiryId: job.enquiryId, messageId });
    return "sent";
  } catch (err) {
    const attempts = (job.attempts || 0) + 1, error = String(err?.message || err).slice(0, 300);
    const failed = attempts >= 3;
    await col.wa_outbox.updateOne({ _id: job._id }, { $set: { status: failed ? "failed" : "queued", attempts, error } });
    if (failed) await setEnquiry(job, { status: "failed", error: "Not sent: " + error });
    await audit(job._id, failed ? "send_failed" : "send_retry", "whatsapp", { error, attempts });
    return failed ? "failed" : "retry";
  }
}

// A crash mid-send leaves a message "sending". It may or may not have gone out, so mark it failed instead of
// risking a duplicate in the group, and let someone check and press Send again.
export async function recoverStuckSends(now = Date.now()) {
  for (const j of await col.wa_outbox.find({ status: "sending", lockedAt: { $lt: iso(now - 5 * 60e3) } }).toArray()) {
    const error = "Not sure it was sent (the service restarted). Check the group before sending again.";
    await col.wa_outbox.updateOne({ _id: j._id }, { $set: { status: "failed", error } });
    await setEnquiry(j, { status: "failed", error });
  }
}
