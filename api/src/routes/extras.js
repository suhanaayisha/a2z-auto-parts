// Photos, message reading, backups and sample data.
import crypto from "node:crypto";
import express, { Router } from "express";
import { col, out, setSeqAtLeast } from "../db.js";
import { n } from "../calc.js";

export const extras = Router();

// ---------- photos (stored in MongoDB; the browser shrinks them before upload) ----------
extras.post("/photos", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "4mb" }), async (req, res) => {
  const mime = String(req.headers["content-type"] || "").split(";")[0];
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Send a JPEG, PNG or WebP photo under 4 MB." });
  const _id = "p" + crypto.randomBytes(7).toString("hex");
  await col.photos.insertOne({ _id, mime, size: req.body.length, data: req.body, createdAt: new Date().toISOString(), by: req.user._id });
  res.status(201).json({ id: _id });
});
extras.get("/photos/:id", async (req, res) => {
  const p = await col.photos.findOne({ _id: req.params.id });
  if (!p) return res.status(404).end();
  const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data.buffer ?? p.data);
  res.set("Content-Type", p.mime).set("Cache-Control", "private, max-age=31536000, immutable").send(buf);
});

// ---------- reading a WhatsApp message into items (optional, needs ANTHROPIC_API_KEY) ----------
let anthropic = null;
extras.post("/ai/read", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Message reading is off. Add ANTHROPIC_API_KEY to the API service." });
  const msg = String(req.body?.message || "").slice(0, 4000).trim();
  if (!msg) return res.status(400).json({ error: "Paste the WhatsApp message first." });
  if (!anthropic) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); anthropic = new Anthropic(); }
  try {
    const r = await anthropic.messages.create({
      model: process.env.AI_MODEL || "claude-haiku-4-5-20251001", max_tokens: 1000,
      system: `You extract used car parts requests from WhatsApp messages sent by UAE garages to a used auto parts supplier. Reply with JSON only:
{"items":[{"vehicle":"Make Model Year","part":"Part name with side (LH/RH) and front/rear where given","qty":1,"quality":"used|aftermarket|original, only if asked"}]}
One entry per distinct part. "Both headlights" = Headlamp LH and Headlamp RH. Expand short names (LC = Toyota Land Cruiser, Patrol = Nissan Patrol). Never invent a year or model. Write items in English.`,
      messages: [{ role: "user", content: msg }],
    });
    const m = r.content.map(c => c.text || "").join("").match(/\{[\s\S]*\}/);
    const items = m ? (JSON.parse(m[0]).items || []).filter(i => i && i.part) : [];
    res.json({ items });
  } catch (err) {
    console.error("[ai]", err.message);
    res.status(502).json({ error: "Could not read the message. Add items by hand." });
  }
});

// ---------- backups ----------
extras.get("/export", async (req, res) => {
  const [company, customers, enquiries, invoices, credits] = await Promise.all([
    col.settings.findOne({ _id: "company" }), col.customers.find({}).toArray(), col.enquiries.find({}).toArray(),
    col.invoices.find({}).toArray(), col.credits.find({}).toArray(),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  res.set("Content-Disposition", `attachment; filename="a2z-auto-parts-backup-${day}.json"`);
  res.json({ exportedAt: new Date().toISOString(), company: out(company), customers: customers.map(out), enquiries: enquiries.map(out), invoices: invoices.map(out), credits: credits.map(out) });
});

// Import a backup or the A2Z Auto Parts sample data. Existing records with the same id are kept as they are.
extras.post("/import", express.json({ limit: "20mb" }), async (req, res) => {
  const d = req.body || {};
  const asList = v => (Array.isArray(v) ? v : Object.entries(v || {}).map(([id, x]) => Object.assign({ id }, x)));
  const counts = {};
  for (const name of ["customers", "enquiries", "invoices", "credits"]) {
    let added = 0;
    for (const rec of asList(d[name])) {
      const { id, ...rest } = rec;
      if (!id || (await col[name].findOne({ _id: String(id) }))) continue;
      await col[name].insertOne(Object.assign({ _id: String(id) }, rest));
      added++;
    }
    counts[name] = added;
  }
  if (d.company && !(await col.settings.findOne({ _id: "company" }))) {
    const { id, ...co } = d.company;
    await col.settings.replaceOne({ _id: "company" }, co, { upsert: true });
  }
  // Keep numbering ahead of imported real records; sample records never move the counters.
  const real = async (name, field) => (await col[name].find({}).toArray()).filter(x => !x.sample).reduce((m, x) => Math.max(m, n(x[field])), 0);
  const all = async (name, field) => (await col[name].find({}).toArray()).reduce((m, x) => Math.max(m, n(x[field])), 0);
  await setSeqAtLeast("enqNo", await all("enquiries", "enqNo"));
  await setSeqAtLeast("quoteNo", await all("enquiries", "quoteNo"));
  await setSeqAtLeast("invNo", await real("invoices", "invNo"));
  await setSeqAtLeast("cnNo", await real("credits", "cnNo"));
  res.json({ imported: counts });
});

extras.post("/sample/clear", async (req, res) => {
  const r = {};
  for (const name of ["credits", "invoices", "enquiries"]) r[name] = (await col[name].deleteMany({ sample: true })).deletedCount;
  const used = new Set((await col.enquiries.find({}).toArray()).map(e => e.customerId).concat((await col.invoices.find({}).toArray()).map(x => x.customerId)));
  let c = 0;
  for (const cu of await col.customers.find({ sample: true }).toArray()) if (!used.has(cu._id)) { await col.customers.deleteOne({ _id: cu._id }); c++; }
  r.customers = c;
  const co = await col.settings.findOne({ _id: "company" });
  if (co?.sample) { const { _id, sample, ...rest } = co; await col.settings.replaceOne({ _id: "company" }, rest); }
  res.json({ removed: r });
});
