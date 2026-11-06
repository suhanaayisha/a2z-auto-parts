// Prices your team sends in WhatsApp groups → suggested prices on the enquiry.
//
// Every message from a team number (Settings → Our team's WhatsApp numbers) becomes a "price job" in wa_prices.
// The worker finds its enquiry:
//   1. it's a reply to the workshop's request → the enquiry made from that request (exact);
//   2. it's a reply to an earlier team price message → that message's enquiry (e.g. a revised price);
//   3. otherwise, only if the chat has exactly one open enquiry from the last 14 days;
//   4. or the enquiry someone picked for it in the WhatsApp tab.
// Claude then matches the prices to the enquiry's items. Nothing changes on the enquiry until someone presses Apply.
//
// Job statuses: pending → working → suggested | not_prices | unmatched | skipped, and suggested → applied | dismissed.
import { col, nextSeq } from "../db.js";
import { aiEnabled, readPrices } from "../ai.js";
import { isPriced, n } from "../calc.js";
import { audit } from "./ingest.js";
import { findCustomer } from "./processor.js";
import crypto from "node:crypto";

const DAY = 864e5;
const WAIT_MS = 60e3;            // try again in a minute while the request is still being read or checked
const GIVE_UP_MS = DAY;          // after a day with no enquiry, show it as unmatched
const OPEN = ["new", "quoted", "confirmed"];
const iso = ms => new Date(ms).toISOString();

// Open enquiries for this chat: made from it, or for its workshop (including ones typed in by hand).
async function openEnquiriesOf(chat, now) {
  const since = iso(now - 14 * DAY);
  const customerId = await findCustomer(chat);
  const a = await col.enquiries.find({ waChat: chat }).toArray();
  const b = customerId ? await col.enquiries.find({ customerId }).toArray() : [];
  const all = new Map([...a, ...b].map(e => [e._id, e]));
  return [...all.values()].filter(e => OPEN.includes(e.status) && e.createdAt >= since);
}

// → { enquiry, match } | { wait: true } | { none: true }
export async function findTarget(job, now = Date.now()) {
  if (job.manualEnquiryId) {
    const e = await col.enquiries.findOne({ _id: job.manualEnquiryId });
    return e ? { enquiry: e, match: "manual" } : { none: true };
  }
  if (job.quotedId) {
    const q = await col.wa_messages.findOne({ _id: job.quotedId });
    if (q?.fromTeam) {
      const prev = await col.wa_prices.findOne({ messageId: q._id });
      if (prev?.enquiryId) {
        const e = await col.enquiries.findOne({ _id: prev.enquiryId });
        if (e) return { enquiry: e, match: "reply_to_prices" };
      }
    } else if (q?.batchId) {
      const b = await col.wa_batches.findOne({ _id: q.batchId });
      if (b?.enquiryId) {
        const e = await col.enquiries.findOne({ _id: b.enquiryId });
        if (e) return { enquiry: e, match: "reply" };
      }
      // The request is still being read, or waits in the WhatsApp tab: try again when it's an enquiry.
      if (b && ["open", "processing", "review", "failed"].includes(b.status)) return { wait: true };
    }
    // Replying to something the app never saw (older than the link, say): fall through to the chat's open enquiry.
  }
  const open = await openEnquiriesOf(job.chat, now);
  if (open.length === 1) return { enquiry: open[0], match: "only_open" };
  if (!open.length && (await col.wa_batches.countDocuments({ chat: job.chat, status: { $in: ["open", "processing"] } }))) return { wait: true };
  return { none: true };
}

export async function processPriceJob(job, now = Date.now()) {
  const t = await findTarget(job, now);
  if (t.wait && now - new Date(job.firstAt).getTime() < GIVE_UP_MS) {
    await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "pending", nextAt: iso(now + WAIT_MS) } });
    return "waiting";
  }
  if (!t.enquiry) {
    await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "unmatched", processedAt: iso(now) } });
    return "unmatched";
  }
  const e = t.enquiry;
  if (["invoiced", "paid", "lost"].includes(e.status)) {
    await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "skipped", enquiryId: e._id, enqNo: e.enqNo, processedAt: iso(now) } });
    return "skipped";
  }
  if (!aiEnabled()) {
    await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "unmatched", error: "Message reading is off (no ANTHROPIC_API_KEY).", processedAt: iso(now) } });
    return "unmatched";
  }
  const items = e.items || [];
  const r = await readPrices({ items, message: job.text });
  if (!r.isPrices) {
    // A question or chat. If it was a guess (no reply link), it may belong elsewhere, so don't keep the link.
    await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "not_prices", ...(t.match === "only_open" ? {} : { enquiryId: e._id, enqNo: e.enqNo }), processedAt: iso(now) } });
    return "not_prices";
  }
  const suggestion = {
    jobId: job._id, messageId: job.messageId, at: job.ts, by: job.senderName || job.sender.split("@")[0], match: t.match,
    confidence: r.confidence, text: job.text,
    lines: r.lines.map(l => { const it = items[l.item - 1]; return { k: it.k, vehicle: it.vehicle || "", part: it.part || "", price: l.price, note: l.note }; }),
    extra: r.extra,
  };
  await col.enquiries.updateOne({ _id: e._id }, { $set: { waPrices: suggestion } });
  await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "suggested", enquiryId: e._id, enqNo: e.enqNo, match: t.match, processedAt: iso(now) } });
  await audit(job._id, "prices_suggested", "whatsapp", { enquiryId: e._id, match: t.match, lines: suggestion.lines.length, confidence: r.confidence });
  // An older suggestion on this enquiry is replaced by the newer one.
  if (e.waPrices?.jobId && e.waPrices.jobId !== job._id && !e.waPrices.applied && !e.waPrices.dismissed) {
    await col.wa_prices.updateOne({ _id: e.waPrices.jobId }, { $set: { status: "replaced" } });
  }
  return "suggested";
}

// Claims and handles every price job that is due. Runs after the batches, so new enquiries exist first.
export async function processPricesDue(now = Date.now()) {
  await col.wa_prices.updateMany({ status: "working", lockedAt: { $lt: iso(now - 10 * 60e3) } }, { $set: { status: "pending" } });
  let handled = 0;
  for (;;) {
    const job = await col.wa_prices.findOneAndUpdate({ status: "pending", nextAt: { $lte: iso(now) } },
      { $set: { status: "working", lockedAt: iso(now) } }, { returnDocument: "after" });
    if (!job) break;
    handled++;
    try { await processPriceJob(job, now); }
    catch (err) {
      const attempts = (job.attempts || 0) + 1;
      console.error(`[wa] price message ${job._id} failed (attempt ${attempts}):`, err.message);
      await col.wa_prices.updateOne({ _id: job._id }, { $set: attempts >= 3
        ? { status: "unmatched", attempts, error: err.message.slice(0, 300) }
        : { status: "pending", attempts, nextAt: iso(now + WAIT_MS), error: err.message.slice(0, 300) } });
    }
  }
  return handled;
}

// The workshop answered a team price message ("OK", "1A 2B", "last price?"): note it on the enquiry.
export async function noteWorkshopReplies(msgs, batchId) {
  const hits = [];
  for (const m of msgs) {
    if (!m.quotedId) continue;
    const job = await col.wa_prices.findOne({ messageId: m.quotedId });
    if (!job?.enquiryId) continue;
    const text = (m.body ?? m.text ?? "") || m.transcript || `[${m.type}]`;
    await col.enquiries.updateOne({ _id: job.enquiryId }, { $set: { waReply: { text: String(text).slice(0, 500), at: m.ts, by: m.senderName || "", batchId, messageId: m._id } } });
    await audit(batchId, "workshop_replied", "whatsapp", { enquiryId: job.enquiryId, text: String(text).slice(0, 100) });
    hits.push(job.enquiryId);
  }
  return hits;
}

// Fills in the suggested prices. If every item then has a price, the quote is created (or revised).
export async function applyPrices(enquiryId, userId) {
  const e = await col.enquiries.findOne({ _id: enquiryId });
  if (!e) return { status: 404, error: "Enquiry not found." };
  const s = e.waPrices;
  if (!s || s.applied || s.dismissed) return { status: 400, error: "There are no WhatsApp prices to apply." };
  if (["invoiced", "paid"].includes(e.status)) return { status: 400, error: "This enquiry is invoiced, so its prices are locked." };
  const items = (e.items || []).map(it => ({ ...it, options: (it.options || []).map(o => ({ ...o })) }));
  const notes = [];
  let changed = 0;
  for (const l of s.lines) {
    const it = items.find(x => x.k === l.k);
    if (!it) continue;
    if (l.price) {
      if (!it.options.length) it.options.push({ k: "o" + crypto.randomBytes(5).toString("hex"), quality: "used", lead: 0, cost: 0, sell: 0, disc: 0 });
      const o = it.options[it.chosen > 0 && it.options[it.chosen] ? it.chosen : 0];
      if (n(o.sell) !== l.price) { o.sell = l.price; changed++; }
    }
    if (l.note) notes.push(`${it.part}: ${l.note}`);
  }
  const now = new Date().toISOString();
  const set = { items, waPrices: { ...s, applied: { at: now, by: userId } }, updatedAt: now, updatedBy: userId };
  if (notes.length) set.notes = [e.notes, `From WhatsApp (${s.by}): ${notes.join("; ")}`].filter(Boolean).join("\n").slice(0, 3000);
  const next = { ...e, ...set };
  if (isPriced(next)) {
    if (!e.quoteNo) { set.quoteNo = await nextSeq("quoteNo"); set.quoteRev = 1; set.quoteDate = now; if (e.status === "new") set.status = "quoted"; }
    else if (changed) { set.quoteRev = n(e.quoteRev || 1) + 1; set.quoteDate = now; }
  }
  await col.enquiries.updateOne({ _id: e._id }, { $set: set });
  await col.wa_prices.updateOne({ _id: s.jobId }, { $set: { status: "applied", appliedBy: userId, appliedAt: now } });
  await audit(s.jobId, "prices_applied", userId, { enquiryId: e._id, changed, quoted: !!set.quoteNo || !!set.quoteRev });
  return { enquiry: { ...e, ...set } };
}

export async function dismissPrices(enquiryId, userId) {
  const e = await col.enquiries.findOne({ _id: enquiryId });
  if (!e?.waPrices || e.waPrices.applied || e.waPrices.dismissed) return { status: 400, error: "There are no WhatsApp prices to dismiss." };
  const now = new Date().toISOString();
  const waPrices = { ...e.waPrices, dismissed: { at: now, by: userId } };
  await col.enquiries.updateOne({ _id: e._id }, { $set: { waPrices } });
  await col.wa_prices.updateOne({ _id: e.waPrices.jobId }, { $set: { status: "dismissed" } });
  await audit(e.waPrices.jobId, "prices_dismissed", userId, { enquiryId: e._id });
  return { enquiry: { ...e, waPrices } };
}
