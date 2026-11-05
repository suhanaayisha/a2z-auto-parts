// Business rules shared by the routes. The frontend has a matching copy in web/lib/calc.js.
export const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
export const r2 = v => Math.round(n(v) * 100) / 100;
export const pad = (x, l = 4) => String(x).padStart(l, "0");
export const QUAL = { used: "Used", aftermarket: "Aftermarket", original: "Original" };
export const DAY = 864e5;
export const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

export const enqRef = e => "ENQ-" + pad(e.enqNo);
export const qtRef = e => "QT-" + pad(e.quoteNo) + (n(e.quoteRev) > 1 ? "-R" + n(e.quoteRev) : "");
export const invRef = x => "INV-" + pad(x.invNo);
export const cnRef = c => "CN-" + pad(c.cnNo);

export const itemKey = (it, i) => it.k || "i" + i;
export function optOf(it) {
  if (it.chosen === -1) return null;
  const o = it.options || [];
  return o[n(it.chosen) > 0 ? n(it.chosen) : 0] || null;
}
export const isPriced = e => (e.items || []).length > 0 && e.items.every(i => n(i.qty) > 0 && (i.options || []).length > 0 && i.options.every(o => n(o.sell) > 0));

export function invQty(invoices, it, i) {
  const k = itemKey(it, i);
  return invoices.filter(x => x.status !== "cancelled")
    .reduce((s, x) => s + (x.lines || []).filter(l => l.ik === k).reduce((a, l) => a + n(l.qty), 0), 0);
}
export const paidOf = x => (x.payments || []).reduce((s, p) => s + n(p.amount), 0);
export const balOf = x => (x.status === "cancelled" ? 0 : Math.max(0, r2(n(x.total) - paidOf(x))));

// Enquiry status follows its invoices once there are any.
export function statusFromInvoices(e, invoices) {
  const live = invoices.filter(x => x.status !== "cancelled");
  if (!live.length) return ["invoiced", "paid"].includes(e.status) ? (e.confirmDate ? "confirmed" : "quoted") : e.status;
  const full = (e.items || []).every((it, i) => it.chosen === -1 || !(it.options || []).length || invQty(live, it, i) >= n(it.qty));
  if (!full) return "confirmed";
  return live.every(x => balOf(x) <= 0) ? "paid" : "invoiced";
}

