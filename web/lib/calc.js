// Formatting and business rules used by the screens. Mirrors api/src/calc.js.
export const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
export const r2 = v => Math.round(n(v) * 100) / 100;
export const money = v => n(v).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const aed = v => "AED " + money(v);
export const pad = (x, l = 4) => String(x).padStart(l, "0");
export const DAY = 864e5;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = d => { if (!d) return ""; const x = new Date(d); return x.getDate() + " " + MONTHS[x.getMonth()] + " " + x.getFullYear(); };
export const fmtShort = d => { if (!d) return ""; const x = new Date(d); return x.getDate() + " " + MONTHS[x.getMonth()]; };
export const fmtDT = d => { if (!d) return ""; const x = new Date(d); return fmtDate(d) + ", " + pad(x.getHours(), 2) + ":" + pad(x.getMinutes(), 2); };
export const isoDay = d => { const x = new Date(d); return x.getFullYear() + "-" + pad(x.getMonth() + 1, 2) + "-" + pad(x.getDate(), 2); };
export const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const key = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const STATUS = { new: "Needs pricing", quoted: "Quoted", confirmed: "Confirmed", invoiced: "Invoiced", paid: "Paid", lost: "Lost" };
export const QUAL = { used: "Used", aftermarket: "Aftermarket", original: "Original" };
export const LET = "ABCDEFGH";
export const VAT_MANDATORY = 375000;
export const VAT_LINE = "Supplier not registered for VAT. No VAT charged.";
export const TERMS = [[0, "On receipt"], [7, "7 days"], [15, "15 days"], [30, "30 days"], [45, "45 days"], [60, "60 days"]];

export const enqNo = e => (e.enqNo ? "ENQ-" + pad(e.enqNo) : "New enquiry");
export const qtNo = e => "QT-" + pad(e.quoteNo) + (n(e.quoteRev) > 1 ? "-R" + n(e.quoteRev) : "");
export const invNo = x => "INV-" + pad(x.invNo);
export const cnNo = c => "CN-" + pad(c.cnNo);
export const leadText = d => { d = n(d); return d <= 0 ? "In stock" : d === 1 ? "1 day" : d + " days"; };

export const newOpt = q => ({ k: key("o"), quality: q || "used", lead: 0, cost: 0, sell: 0, disc: 0 });
export const newItem = v => ({ k: key("k"), vehicle: v || "", part: "", qty: 1, chosen: 0, delivered: false, deliveredDate: null, options: [newOpt()] });
export const itemKey = (it, i) => it.k || "i" + i;
export function optOf(it) { if (it.chosen === -1) return null; const o = it.options || []; return o[n(it.chosen) > 0 ? n(it.chosen) : 0] || null; }
export const optIndex = it => (it.chosen === -1 ? -1 : Math.max(0, n(it.chosen)));
export const isPriced = e => (e.items || []).length > 0 && e.items.every(i => n(i.qty) > 0 && (i.options || []).length > 0 && i.options.every(o => n(o.sell) > 0));
export const multi = e => (e.items || []).some(i => (i.options || []).length > 1);
export const vehicles = e => [...new Set((e.items || []).map(i => i.vehicle).filter(Boolean))].join(", ");

export function calc(e) {
  let gross = 0, lineDisc = 0, cost = 0;
  for (const it of e.items || []) { const o = optOf(it); if (!o) continue; const q = n(it.qty); gross += q * n(o.sell); lineDisc += n(o.disc); cost += q * n(o.cost); }
  const sub = gross - lineDisc, extra = n(e.extraDisc), total = sub - extra, comm = n(e.commAmt), profit = total - cost - comm;
  return { gross, lineDisc, sub, extra, total, cost, comm, profit, margin: total ? profit / total : 0 };
}

export function ageOf(d) {
  const m = Math.max(0, (Date.now() - new Date(d)) / 60000);
  return { t: m < 30 ? "ok" : m < 120 ? "warn" : "crit", s: m < 60 ? Math.round(m) + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d" };
}

export function deliv(e) {
  if (!["confirmed", "invoiced", "paid"].includes(e.status)) return null;
  const act = (e.items || []).filter(it => optOf(it)); if (!act.length) return null;
  const pend = act.filter(it => !it.delivered);
  if (!pend.length) { const last = act.map(it => it.deliveredDate).filter(Boolean).sort().pop(); return { done: true, t: "done", label: "Delivered" + (last ? " " + fmtShort(last) : "") }; }
  const base = new Date(e.confirmDate || e.quoteDate || e.createdAt);
  const due = new Date(sod(base).getTime() + Math.max(0, ...pend.map(it => n(optOf(it).lead))) * DAY);
  const days = Math.round((sod(due) - sod(Date.now())) / DAY);
  const t = days < 0 ? "crit" : days <= 1 ? "warn" : "ok";
  const label = days < 0 ? `Delivery ${-days}d late` : days === 0 ? "Delivery due today" : days === 1 ? "Delivery due tomorrow" : "Delivery due " + fmtShort(due);
  return { done: false, due, days, t, label: label + (pend.length < act.length ? ` · ${act.length - pend.length}/${act.length} in` : "") };
}

// ---------- invoices ----------
export const live = list => list.filter(x => x.status !== "cancelled");
export function invQty(invoices, e, it, i) {
  const k = itemKey(it, i);
  return live(invoices).filter(x => x.enquiryId === e.id).reduce((s, x) => s + (x.lines || []).filter(l => l.ik === k).reduce((a, l) => a + n(l.qty), 0), 0);
}
export const remQty = (invoices, e, it, i) => Math.max(0, n(it.qty) - invQty(invoices, e, it, i));
export const canInvoice = (invoices, e) => ["quoted", "confirmed"].includes(e.status) && (e.items || []).some((it, i) => it.chosen !== -1 && (it.options || []).length && remQty(invoices, e, it, i) > 0);
export const paidOf = x => (x.payments || []).reduce((s, p) => s + n(p.amount), 0);
export const balOf = x => (x.status === "cancelled" ? 0 : Math.max(0, r2(n(x.total) - paidOf(x))));
export const invCost = x => (x.lines || []).reduce((s, l) => s + n(l.cost) * n(l.qty), 0);
export const invProfit = x => n(x.total) - invCost(x) - n(x.commAmt);
export const isOverdue = x => balOf(x) > 0 && x.dueDate && sod(x.dueDate) < sod(Date.now());
export function invState(x) {
  if (x.status === "cancelled") return { t: "lost", l: "Cancelled" };
  if (balOf(x) <= 0) return { t: "paid", l: "Paid" };
  if (paidOf(x) > 0) return { t: "quoted", l: isOverdue(x) ? "Part paid · overdue" : "Part paid" };
  return isOverdue(x) ? { t: "new", l: "Overdue" } : { t: "invoiced", l: "Unpaid" };
}

export function amountWords(v) {
  const a = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const t = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const h = x => { let s = ""; if (x >= 100) { s += a[Math.floor(x / 100)] + " hundred"; x %= 100; if (x) s += " and "; } if (x >= 20) { s += t[Math.floor(x / 10)]; if (x % 10) s += "-" + a[x % 10]; } else if (x) s += a[x]; return s; };
  const w = x => { if (!x) return "zero"; const parts = []; [[1e6, "million"], [1e3, "thousand"]].forEach(([d, l]) => { if (x >= d) { parts.push(h(Math.floor(x / d)) + " " + l); x %= d; } }); if (x) parts.push(h(x)); return parts.join(" "); };
  const d = Math.floor(n(v) + 1e-9), f = Math.round((n(v) - d) * 100);
  let s = "UAE Dirhams " + w(d); if (f) s += " and fils " + w(f); s += " only";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
