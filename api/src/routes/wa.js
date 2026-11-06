// WhatsApp intake for the screens: listener status and pairing QR, the inbox of read batches,
// and the review actions. Every action is written to the wa_audit log.
import { Router } from "express";
import { col, out } from "../db.js";
import { enquiryFromBatch, linkChat, findCustomer } from "../wa/processor.js";
import { audit } from "../wa/ingest.js";
import { applyPrices, dismissPrices } from "../wa/prices.js";
import { sendTarget, queueSend, listenerConnected, sendingEnabled } from "../wa/outbox.js";

export const wa = Router();

const VIEWS = {
  review: ["review", "failed"],
  waiting: ["open", "processing"],
  created: ["created"],
  ignored: ["ignored", "dismissed"],
};

// The listener writes its state every 30 seconds; older than 2 minutes means it isn't running.
wa.get("/wa/status", async (req, res) => {
  const s = await col.wa_state.findOne({ _id: "listener" });
  const fresh = s && Date.now() - new Date(s.seenAt).getTime() < 120e3;
  res.json({
    running: !!fresh, connection: fresh ? s.connection : "offline", qr: fresh && s.connection !== "open" ? s.qr || null : null,
    me: s?.me || null, seenAt: s?.seenAt || null, error: s?.error || null,
    counts: {
      ...Object.fromEntries(await Promise.all(Object.entries(VIEWS).map(async ([k, v]) => [k, await col.wa_batches.countDocuments({ status: { $in: v } })]))),
      prices: await col.wa_prices.countDocuments({ status: "unmatched" }),
    },
  });
});

wa.get("/wa/inbox", async (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : "review";
  const batches = (await col.wa_batches.find({ status: { $in: VIEWS[view] } }).sort({ lastAt: -1 }).limit(100).toArray());
  const msgs = batches.length ? await col.wa_messages.find({ batchId: { $in: batches.map(b => b._id) } }).toArray() : [];
  const by = new Map();
  for (const m of msgs) { if (!by.has(m.batchId)) by.set(m.batchId, []); by.get(m.batchId).push(out(m)); }
  res.json({
    view,
    batches: batches.map(b => Object.assign(out(b), { messages: (by.get(b._id) || []).sort((a, z) => (a.ts < z.ts ? -1 : 1)) })),
  });
});

async function batchOr404(req, res) {
  const b = await col.wa_batches.findOne({ _id: req.params.id });
  if (!b) res.status(404).json({ error: "That WhatsApp message is no longer here." });
  return b;
}

// Make it an enquiry. The chat is remembered for that workshop, so its next messages go straight through.
wa.post("/wa/batches/:id/accept", async (req, res) => {
  const b = await batchOr404(req, res); if (!b) return;
  if (b.status === "created" && b.enquiryId) return res.status(409).json({ error: "This one is already an enquiry.", enquiryId: b.enquiryId });
  if (!["review", "failed", "ignored", "dismissed"].includes(b.status)) return res.status(400).json({ error: "This is still being read. Try again in a minute." });
  const customerId = String(req.body?.customerId || b.customerId || "");
  if (!customerId || !(await col.customers.findOne({ _id: customerId }))) return res.status(400).json({ error: "Choose the workshop first." });
  // Claim it first so two people pressing at once make one enquiry.
  const claimed = await col.wa_batches.findOneAndUpdate({ _id: b._id, status: b.status }, { $set: { status: "processing", lockedAt: new Date().toISOString() } }, { returnDocument: "after" });
  if (!claimed) return res.status(409).json({ error: "Someone else just handled this one." });
  let enq;
  try { enq = await enquiryFromBatch(b, customerId, req.user._id, Array.isArray(req.body?.items) ? req.body.items : undefined); }
  catch (err) { await col.wa_batches.updateOne({ _id: b._id }, { $set: { status: b.status } }); throw err; }
  if (!enq) {
    await col.wa_batches.updateOne({ _id: b._id }, { $set: { status: b.status } });
    return res.status(400).json({ error: "Choose the workshop first." });
  }
  await linkChat(b.chat, customerId);
  await col.wa_batches.updateOne({ _id: b._id }, { $set: { status: "created", customerId, enquiryId: enq._id, enqNo: enq.enqNo, reviewedBy: req.user._id, reviewedAt: new Date().toISOString() } });
  await audit(b._id, "accepted", req.user._id, { enquiryId: enq._id, customerId });
  res.status(201).json({ enquiry: out(enq) });
});

wa.post("/wa/batches/:id/dismiss", async (req, res) => {
  const b = await batchOr404(req, res); if (!b) return;
  if (["open", "processing", "created"].includes(b.status)) return res.status(400).json({ error: "This one can't be dismissed now." });
  await col.wa_batches.updateOne({ _id: b._id }, { $set: { status: "dismissed", reviewedBy: req.user._id, reviewedAt: new Date().toISOString() } });
  await audit(b._id, "dismissed", req.user._id);
  res.json({ ok: true });
});

// Read it again (e.g. after a failure or after adding the API key).
wa.post("/wa/batches/:id/retry", async (req, res) => {
  const b = await batchOr404(req, res); if (!b) return;
  if (!["review", "failed", "ignored", "dismissed"].includes(b.status)) return res.status(400).json({ error: "This one can't be read again now." });
  await col.wa_batches.updateOne({ _id: b._id }, { $set: { status: "open", attempts: 0, lastAt: new Date(0).toISOString() } });
  await audit(b._id, "retry", req.user._id);
  res.json({ ok: true });
});

wa.get("/wa/batches/:id/audit", async (req, res) => {
  const rows = await col.wa_audit.find({ batchId: req.params.id }).sort({ at: 1 }).toArray();
  res.json({ audit: rows.map(out) });
});

// Voice notes, for playback on the review screen.
wa.get("/wa/media/:id", async (req, res) => {
  const m = await col.wa_media.findOne({ _id: req.params.id });
  if (!m) return res.status(404).end();
  const buf = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data.buffer ?? m.data);
  res.set("Content-Type", m.mime || "audio/ogg").set("Cache-Control", "private, max-age=31536000, immutable").send(buf);
});

// ---------- the team's prices (see wa/prices.js) ----------
wa.post("/wa/enquiries/:id/prices/:action", async (req, res, next) => {
  const fn = { apply: applyPrices, dismiss: dismissPrices }[req.params.action];
  if (!fn) return next();
  const r = await fn(req.params.id, req.user._id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ enquiry: out(r.enquiry) });
});

// Price messages from the team. "unmatched" ones need someone to pick their enquiry.
wa.get("/wa/prices", async (req, res) => {
  const statuses = req.query.view === "all"
    ? ["pending", "working", "suggested", "applied", "dismissed", "unmatched", "skipped", "replaced"]
    : ["unmatched"];
  const jobs = await col.wa_prices.find({ status: { $in: statuses } }).sort({ ts: -1 }).limit(100).toArray();
  const customers = new Map();
  for (const j of jobs) if (!customers.has(j.chat)) customers.set(j.chat, await findCustomer(j.chat, j.chatName));
  res.json({ prices: jobs.map(j => Object.assign(out(j), { customerId: customers.get(j.chat) || null })) });
});

wa.post("/wa/prices/:id/assign", async (req, res) => {
  const job = await col.wa_prices.findOne({ _id: req.params.id });
  if (!job) return res.status(404).json({ error: "That price message is no longer here." });
  if (!["unmatched", "not_prices", "skipped"].includes(job.status)) return res.status(400).json({ error: "This one is already matched." });
  const e = await col.enquiries.findOne({ _id: String(req.body?.enquiryId || "") });
  if (!e) return res.status(400).json({ error: "Choose the enquiry first." });
  const now = new Date().toISOString();
  await col.wa_prices.updateOne({ _id: job._id }, { $set: { status: "pending", manualEnquiryId: e._id, nextAt: now, firstAt: now, attempts: 0 } });
  await audit(job._id, "prices_assigned", req.user._id, { enquiryId: e._id });
  res.json({ ok: true });
});

wa.post("/wa/prices/:id/ignore", async (req, res) => {
  const r = await col.wa_prices.updateOne({ _id: req.params.id, status: "unmatched" }, { $set: { status: "ignored", reviewedBy: req.user._id } });
  if (!r.matchedCount) return res.status(400).json({ error: "This one can't be set aside now." });
  await audit(req.params.id, "prices_ignored", req.user._id);
  res.json({ ok: true });
});

// ---------- sending quotes from the app (see wa/outbox.js) ----------
// What the Send dialog shows: where it goes, which message it replies to, and whether it can go now.
wa.get("/wa/enquiries/:id/send-target", async (req, res) => {
  const e = await col.enquiries.findOne({ _id: req.params.id });
  if (!e) return res.status(404).json({ error: "Enquiry not found." });
  const co = await col.settings.findOne({ _id: "company" });
  res.json({ target: await sendTarget(e), enabled: sendingEnabled(co), connected: await listenerConnected() });
});

wa.post("/wa/enquiries/:id/send", async (req, res) => {
  const e = await col.enquiries.findOne({ _id: req.params.id });
  if (!e) return res.status(404).json({ error: "Enquiry not found." });
  if (!sendingEnabled(await col.settings.findOne({ _id: "company" }))) return res.status(403).json({ error: "Sending from the app is turned off in Settings. Use Copy instead." });
  if (!e.quoteNo) return res.status(400).json({ error: "Create the quote first." });
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "The message is empty." });
  if (["queued", "sending"].includes(e.waSent?.status)) return res.status(409).json({ error: "This quote is already being sent." });
  if (!(await listenerConnected())) return res.status(409).json({ error: "WhatsApp isn't connected right now. Check the WhatsApp tab, or use Copy." });
  const r = await queueSend(e, text, req.user._id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(202).json({ enquiry: out(r.enquiry) });
});
