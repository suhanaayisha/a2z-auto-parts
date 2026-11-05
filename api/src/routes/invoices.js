// Invoices and credit notes.
// An invoice is a fixed record: seller, buyer and lines are copied in when it is issued,
// it is never edited or deleted, and corrections are made with a credit note.
import { Router } from "express";
import { col, out, nextSeq } from "../db.js";
import { n, r2, DAY, sod, enqRef, qtRef, invRef, itemKey, invQty, balOf, paidOf, statusFromInvoices } from "../calc.js";
import { viewInvoice, viewEnquiry, uid, now, str, invoicesOf } from "./records.js";

export const invoices = Router();

const sellerSnap = co => ({ name: co.name || "", address: co.address || "", phone: co.phone || "", email: co.email || "",
  licence: co.licence || "", authority: co.authority || "", bank: co.bank || "", terms: co.terms || "" });
const buyerSnap = (cu, e) => ({ name: cu.name || "", address: cu.address || "", trn: cu.trn || "", attn: e.sender || cu.contact || "" });

async function syncEnquiry(id) {
  const e = await col.enquiries.findOne({ _id: id });
  if (!e) return null;
  const st = statusFromInvoices(e, await invoicesOf(id));
  if (st !== e.status) { await col.enquiries.updateOne({ _id: id }, { $set: { status: st, updatedAt: now() } }); e.status = st; }
  return e;
}
// Sample records (from the demo import) are numbered separately so real invoices start at INV-0001.
async function sampleNo(coll, field) {
  const all = await col[coll].find({}).toArray();
  return all.reduce((m, x) => Math.max(m, n(x[field])), 0) + 1;
}

// Issue an invoice from an enquiry's quote.
// body: {lines:[{ik, opt, qty}], extraDisc, supplyDate(YYYY-MM-DD), payTerms, notes, salesperson, commAmt}
invoices.post("/enquiries/:id/invoices", async (req, res) => {
  const e = await col.enquiries.findOne({ _id: req.params.id });
  if (!e) return res.status(404).json({ error: "Enquiry not found." });
  if (!["quoted", "confirmed"].includes(e.status)) return res.status(400).json({ error: "Invoices are created from a quoted or confirmed enquiry." });
  const co = (await col.settings.findOne({ _id: "company" })) || {};
  if (!co.name || !co.address) return res.status(400).json({ error: "Add your company name and address in Settings before issuing invoices." });
  const cu = await col.customers.findOne({ _id: e.customerId });
  if (!cu) return res.status(400).json({ error: "The workshop for this enquiry no longer exists." });
  const b = req.body || {};
  const existing = await invoicesOf(e._id);
  const live = existing.filter(x => x.status !== "cancelled");
  const lines = [], chosen = {};
  for (const req_ of Array.isArray(b.lines) ? b.lines : []) {
    const i = (e.items || []).findIndex((it, idx) => itemKey(it, idx) === req_.ik);
    if (i < 0) return res.status(400).json({ error: "An item on this invoice is no longer on the enquiry. Reload and try again." });
    const it = e.items[i], j = Math.round(n(req_.opt)), o = (it.options || [])[j];
    if (!o) return res.status(400).json({ error: `Item ${i + 1} has no option ${j + 1}.` });
    if (n(o.sell) <= 0) return res.status(400).json({ error: `Item ${i + 1} needs a unit price.` });
    const rem = n(it.qty) - invQty(live, it, i);
    const q = Math.round(n(req_.qty));
    if (q < 1 || q > rem) return res.status(400).json({ error: `Item ${i + 1}: you can invoice 1 to ${rem}.` });
    const disc = r2(n(o.disc) * q / Math.max(1, n(it.qty)));
    lines.push({ ik: itemKey(it, i), part: it.part, vehicle: it.vehicle, quality: o.quality, qty: q, unit: n(o.sell), disc, amount: r2(q * n(o.sell) - disc), cost: n(o.cost), lead: n(o.lead) });
    chosen[i] = j;
  }
  if (!lines.length) return res.status(400).json({ error: "Tick at least one item to invoice." });
  const sub = r2(lines.reduce((s, l) => s + l.amount, 0));
  const extra = r2(Math.min(sub, Math.max(0, n(b.extraDisc))));
  const total = r2(sub - extra);
  const issued = new Date();
  const supply = /^\d{4}-\d{2}-\d{2}$/.test(b.supplyDate || "") ? new Date(b.supplyDate + "T12:00:00") : issued;
  const terms = Math.max(0, Math.min(365, Math.round(n(b.payTerms))));
  const inv = {
    _id: uid("i"),
    invNo: e.sample ? await sampleNo("invoices", "invNo") : await nextSeq("invNo"),
    enquiryId: e._id, enqRef: enqRef(e), quoteRef: e.quoteNo ? qtRef(e) : "", customerId: e.customerId,
    issueDate: issued.toISOString(), supplyDate: supply.toISOString(), payTerms: terms, dueDate: new Date(sod(issued).getTime() + terms * DAY).toISOString(),
    seller: sellerSnap(co), buyer: buyerSnap(cu, e), lines, sub, extraDisc: extra, total,
    salesperson: str(b.salesperson, 80), commAmt: r2(Math.max(0, n(b.commAmt))),
    commPaid: false, status: "issued", payments: [], notes: str(b.notes, 300), issuedBy: req.user._id,
  };
  if (e.sample) inv.sample = true;
  await col.invoices.insertOne(inv);
  const set = { updatedAt: now() };
  const items = structuredClone(e.items);
  for (const [i, j] of Object.entries(chosen)) items[i].chosen = j;
  set.items = items;
  if (!e.confirmDate) set.confirmDate = issued.toISOString();
  if (!e.salesperson && inv.salesperson) set.salesperson = inv.salesperson;
  await col.enquiries.updateOne({ _id: e._id }, { $set: set });
  const fresh = await syncEnquiry(e._id);
  res.status(201).json({ invoice: viewInvoice(req, inv), enquiry: viewEnquiry(req, fresh) });
});

invoices.post("/invoices/:id/payments", async (req, res) => {
  const x = await col.invoices.findOne({ _id: req.params.id });
  if (!x) return res.status(404).json({ error: "Invoice not found." });
  if (x.status === "cancelled") return res.status(400).json({ error: "This invoice is cancelled." });
  const b = req.body || {}, amt = r2(b.amount), bal = balOf(x);
  if (amt <= 0 || amt > bal + 0.001) return res.status(400).json({ error: `Enter an amount up to the balance of AED ${bal.toFixed(2)}.` });
  const method = ["Cash", "Bank transfer", "Cheque", "Card"].includes(b.method) ? b.method : "Cash";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? new Date(b.date + "T12:00:00").toISOString() : now();
  const payments = (x.payments || []).concat({ amount: amt, date, method, ref: str(b.ref, 80), by: req.user._id });
  const set = { payments };
  if (r2(n(x.total) - payments.reduce((s, p) => s + n(p.amount), 0)) <= 0) { set.status = "paid"; set.paidDate = date; }
  await col.invoices.updateOne({ _id: x._id }, { $set: set });
  const fresh = Object.assign(x, set);
  const e = await syncEnquiry(x.enquiryId);
  res.json({ invoice: viewInvoice(req, fresh), enquiry: e && viewEnquiry(req, e) });
});

invoices.patch("/invoices/:id/commission", async (req, res) => {
  const x = await col.invoices.findOne({ _id: req.params.id });
  if (!x) return res.status(404).json({ error: "Invoice not found." });
  await col.invoices.updateOne({ _id: x._id }, { $set: { commPaid: !!req.body?.commPaid } });
  res.json({ invoice: viewInvoice(req, Object.assign(x, { commPaid: !!req.body?.commPaid })) });
});

// Cancelling issues a credit note for the full amount. The invoice stays on record.
invoices.post("/invoices/:id/cancel", async (req, res) => {
  const x = await col.invoices.findOne({ _id: req.params.id });
  if (!x) return res.status(404).json({ error: "Invoice not found." });
  if (x.status === "cancelled") return res.status(400).json({ error: "This invoice is already cancelled." });
  const reason = str(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: "Enter the reason. It is printed on the credit note." });
  const cn = {
    _id: uid("c"), cnNo: x.sample ? await sampleNo("credits", "cnNo") : await nextSeq("cnNo"),
    invoiceId: x._id, invRef: invRef(x), invDate: x.issueDate, customerId: x.customerId, enquiryId: x.enquiryId,
    date: now(), reason, seller: x.seller, buyer: x.buyer, lines: x.lines.map(({ cost, ...l }) => l),
    sub: x.sub, extraDisc: x.extraDisc, total: x.total, receivedBefore: paidOf(x), issuedBy: req.user._id,
  };
  if (x.sample) cn.sample = true;
  await col.credits.insertOne(cn);
  await col.invoices.updateOne({ _id: x._id }, { $set: { status: "cancelled", creditId: cn._id, cancelledDate: cn.date } });
  const e = await syncEnquiry(x.enquiryId);
  res.status(201).json({ credit: out(cn), invoice: viewInvoice(req, Object.assign(x, { status: "cancelled", creditId: cn._id })), enquiry: e && viewEnquiry(req, e) });
});
