// Company settings, customers and enquiries (including quote actions).
import crypto from "node:crypto";
import { Router } from "express";
import { col, out, nextSeq } from "../db.js";
import {
  n, isPriced, statusFromInvoices, invQty, itemKey,
} from "../calc.js";

export const records = Router();
const uid = p => p + crypto.randomBytes(7).toString("hex");
const now = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

const viewEnquiry = (req, e) => out(e);
const viewInvoice = (req, x) => out(x);

// ---------- everything the screens need in one call ----------
records.get("/bootstrap", async (req, res) => {
  const [company, customers, enquiries, invoices, credits] = await Promise.all([
    col.settings.findOne({ _id: "company" }),
    col.customers.find({}).toArray(),
    col.enquiries.find({}).toArray(),
    col.invoices.find({}).toArray(),
    col.credits.find({}).toArray(),
  ]);
  const co = out(company) || { name: "", salespeople: [], quoteValidDays: 7, payDays: 0 };
  res.json({
    me: { id: req.user._id, name: req.user.name, email: req.user.email },
    config: { ai: !!process.env.ANTHROPIC_API_KEY },
    company: co,
    customers: customers.map(out),
    enquiries: enquiries.map(e => viewEnquiry(req, e)),
    invoices: invoices.map(x => viewInvoice(req, x)),
    credits: credits.map(out),
  });
});

// ---------- company settings ----------
records.put("/settings/company", async (req, res) => {
  const b = req.body || {};
  const co = {
    name: str(b.name, 160), licence: str(b.licence, 60), authority: str(b.authority, 80), address: str(b.address, 300),
    phone: str(b.phone, 60), email: str(b.email, 120), bank: str(b.bank, 300), terms: str(b.terms, 1500),
    quoteValidDays: Math.max(1, Math.round(n(b.quoteValidDays) || 7)), payDays: Math.max(0, Math.round(n(b.payDays))),
    salespeople: (Array.isArray(b.salespeople) ? b.salespeople : []).map(p => ({ name: str(p.name, 80), pct: n(p.pct) })).filter(p => p.name).slice(0, 50),
    vatRegistered: false, updatedAt: now(),
  };
  await col.settings.replaceOne({ _id: "company" }, co, { upsert: true });
  res.json({ company: Object.assign({ id: "company" }, co) });
});

// ---------- customers ----------
function cleanCustomer(b) {
  const trn = str(b.trn, 15).replace(/\D/g, "");
  return { name: str(b.name, 160), trn, contact: str(b.contact, 120), phone: str(b.phone, 60), groups: str(b.groups, 160), address: str(b.address, 300), notes: str(b.notes, 1000) };
}
records.post("/customers", async (req, res) => {
  const c = cleanCustomer(req.body || {});
  if (!c.name) return res.status(400).json({ error: "Enter the workshop name." });
  if (c.trn && c.trn.length !== 15) return res.status(400).json({ error: "A TRN has 15 digits." });
  const doc = Object.assign({ _id: uid("c"), createdAt: now() }, c);
  await col.customers.insertOne(doc);
  res.status(201).json({ customer: out(doc) });
});
records.put("/customers/:id", async (req, res) => {
  const old = await col.customers.findOne({ _id: req.params.id });
  if (!old) return res.status(404).json({ error: "Workshop not found." });
  const c = cleanCustomer(req.body || {});
  if (!c.name) return res.status(400).json({ error: "Enter the workshop name." });
  if (c.trn && c.trn.length !== 15) return res.status(400).json({ error: "A TRN has 15 digits." });
  const doc = Object.assign({}, old, c, { updatedAt: now() });
  delete doc._id;
  await col.customers.replaceOne({ _id: old._id }, doc);
  res.json({ customer: out(Object.assign({ _id: old._id }, doc)) });
});
records.delete("/customers/:id", async (req, res) => {
  const id = req.params.id;
  if ((await col.enquiries.countDocuments({ customerId: id })) || (await col.invoices.countDocuments({ customerId: id }))) {
    return res.status(400).json({ error: "This workshop has enquiries or invoices, so it can't be deleted." });
  }
  await col.customers.deleteOne({ _id: id });
  res.json({ ok: true });
});

// ---------- enquiries ----------
const STATUSES = ["new", "quoted", "confirmed", "invoiced", "paid", "lost"];
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 100).map((it, i) => ({
    k: str(it.k, 40) || "k" + crypto.randomBytes(5).toString("hex"),
    vehicle: str(it.vehicle, 120), part: str(it.part, 200), qty: Math.max(1, Math.round(n(it.qty) || 1)),
    chosen: it.chosen === -1 ? -1 : Math.max(0, Math.round(n(it.chosen))),
    delivered: !!it.delivered, deliveredDate: it.delivered ? (it.deliveredDate || now()) : null,
    options: (Array.isArray(it.options) ? it.options : []).slice(0, 8).map(o => ({
      k: str(o.k, 40) || "o" + crypto.randomBytes(5).toString("hex"),
      quality: ["used", "aftermarket", "original"].includes(o.quality) ? o.quality : "used",
      lead: Math.max(0, Math.round(n(o.lead))), cost: Math.max(0, n(o.cost)), sell: Math.max(0, n(o.sell)), disc: Math.max(0, n(o.disc)),
    })),
  }));
}
function cleanEnquiry(b) {
  return {
    customerId: str(b.customerId, 40), sender: str(b.sender, 120), message: str(b.message, 5000), notes: str(b.notes, 3000),
    items: cleanItems(b.items), extraDisc: Math.max(0, n(b.extraDisc)), salesperson: str(b.salesperson, 80), commAmt: Math.max(0, n(b.commAmt)),
    photos: (Array.isArray(b.photos) ? b.photos : []).map(p => str(p, 40)).filter(p => /^p[0-9a-f]{14}$/.test(p)).slice(0, 30),
  };
}
async function invoicesOf(id) { return col.invoices.find({ enquiryId: id }).toArray(); }

records.post("/enquiries", async (req, res) => {
  const e = cleanEnquiry(req.body || {});
  if (!e.customerId || !(await col.customers.findOne({ _id: e.customerId }))) return res.status(400).json({ error: "Choose the workshop first." });
  const doc = Object.assign({ _id: uid("e"), enqNo: await nextSeq("enqNo"), status: "new", createdAt: now(), createdBy: req.user._id,
    quoteNo: null, quoteRev: 1, quoteDate: null, confirmDate: null }, e);
  await col.enquiries.insertOne(doc);
  res.status(201).json({ enquiry: viewEnquiry(req, doc) });
});

records.put("/enquiries/:id", async (req, res) => {
  const old = await col.enquiries.findOne({ _id: req.params.id });
  if (!old) return res.status(404).json({ error: "Enquiry not found." });
  const e = cleanEnquiry(req.body || {});
  const invs = await invoicesOf(old._id);
  const live = invs.filter(x => x.status !== "cancelled");
  if (live.length) {
    // Invoiced items are fixed: only delivery can change. The workshop can't change either.
    e.customerId = old.customerId;
    const oldByKey = new Map((old.items || []).map((it, i) => [itemKey(it, i), it]));
    for (const [k, it] of oldByKey) {
      const i = old.items.indexOf(it);
      if (invQty(live, it, i) > 0) {
        const idx = e.items.findIndex(x => x.k === k);
        const kept = Object.assign({}, it, idx >= 0 ? { delivered: e.items[idx].delivered, deliveredDate: e.items[idx].deliveredDate } : {});
        if (idx >= 0) e.items[idx] = kept; else e.items.push(kept);
      }
    }
  }
  if (!e.customerId || !(await col.customers.findOne({ _id: e.customerId }))) return res.status(400).json({ error: "Choose the workshop first." });
  const doc = Object.assign({}, old, e, { updatedAt: now(), updatedBy: req.user._id });
  doc.status = statusFromInvoices(doc, invs);
  await col.enquiries.replaceOne({ _id: old._id }, doc);
  res.json({ enquiry: viewEnquiry(req, doc) });
});

records.delete("/enquiries/:id", async (req, res) => {
  const e = await col.enquiries.findOne({ _id: req.params.id });
  if (!e) return res.json({ ok: true });
  if (e.quoteNo) return res.status(400).json({ error: "Quoted enquiries can't be deleted. Mark it lost instead." });
  await col.enquiries.deleteOne({ _id: e._id });
  res.json({ ok: true });
});

// Quote actions. Numbers and dates are set here so they can't be edited later.
records.post("/enquiries/:id/:action", async (req, res, next) => {
  const { action } = req.params;
  if (!["quote", "revise", "confirm", "lost", "reopen"].includes(action)) return next();
  const e = await col.enquiries.findOne({ _id: req.params.id });
  if (!e) return res.status(404).json({ error: "Enquiry not found." });
  const set = {};
  if (action === "quote") {
    if (!isPriced(e)) return res.status(400).json({ error: "Add a unit price to every option first." });
    if (!e.quoteNo) { set.quoteNo = await nextSeq("quoteNo"); set.quoteRev = 1; set.quoteDate = now(); }
    if (e.status === "new") set.status = "quoted";
  } else if (action === "revise") {
    if (!e.quoteNo) return res.status(400).json({ error: "Create the quote first." });
    if (!isPriced(e)) return res.status(400).json({ error: "Add a unit price to every option first." });
    set.quoteRev = n(e.quoteRev || 1) + 1; set.quoteDate = now();
  } else if (action === "confirm") {
    if (e.status !== "quoted") return res.status(400).json({ error: "Only a quoted enquiry can be confirmed." });
    if (!(e.items || []).some(it => it.chosen !== -1 && (it.options || []).length)) return res.status(400).json({ error: "Pick at least one option the workshop wants." });
    set.status = "confirmed"; set.confirmDate = now();
  } else if (action === "lost") {
    if ((await invoicesOf(e._id)).some(x => x.status !== "cancelled")) return res.status(400).json({ error: "This enquiry has invoices, so it can't be marked lost." });
    set.status = "lost";
  } else if (action === "reopen") {
    if (e.status !== "lost") return res.status(400).json({ error: "Only a lost enquiry can be reopened." });
    set.status = e.quoteNo ? "quoted" : "new";
  }
  set.updatedAt = now();
  await col.enquiries.updateOne({ _id: e._id }, { $set: set });
  res.json({ enquiry: viewEnquiry(req, Object.assign(e, set)) });
});

export { STATUSES, viewInvoice, viewEnquiry, uid, now, str, invoicesOf };
