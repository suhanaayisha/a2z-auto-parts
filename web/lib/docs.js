// Quotes, invoices and credit notes: what they contain, the PDF, and the WhatsApp text.
import {
  n, money, fmtDate, isoDay, DAY, QUAL, LET, VAT_LINE, leadText, optOf, multi, calc,
  enqNo, qtNo, invNo, cnNo, balOf, paidOf, invState, amountWords,
} from "./calc";

const descOf = l => [l.part, l.vehicle].filter(Boolean).join(" — ");
const sellerOf = c => ({ name: c.name || "", address: c.address || "", phone: c.phone || "", email: c.email || "", licence: c.licence || "", authority: c.authority || "", bank: c.bank || "", terms: c.terms || "" });

export function quoteModel(e, company, customer) {
  const mul = multi(e), c = calc(e);
  const valid = new Date(new Date(e.quoteDate || Date.now()).getTime() + n(company.quoteValidDays || 7) * DAY);
  const rows = []; let k = 0;
  (e.items || []).forEach(it => {
    const ch = optOf(it); if (!ch) return; k++; const q = n(it.qty);
    (it.options || []).forEach((o, j) => rows.push({ no: k + (it.options.length > 1 ? LET[j] : ""), desc: j === 0 ? descOf(it) : "", qual: QUAL[o.quality] || "", lead: leadText(o.lead), q, unit: n(o.sell), disc: n(o.disc), amt: q * n(o.sell) - n(o.disc), sel: mul && o === ch }));
  });
  const cu = customer || {};
  return {
    kind: "quote", title: "QUOTATION", no: qtNo(e), seller: sellerOf(company),
    buyer: { name: cu.name || "", address: cu.address || "", trn: cu.trn || "", attn: e.sender || cu.contact || "" }, buyerLabel: "Prepared for",
    meta: [["Date", fmtDate(e.quoteDate)], ["Valid until", fmtDate(valid)], ["Reference", enqNo(e)]], lead: true, rows,
    sub: c.sub, extra: c.extra, total: c.total, totalLabel: mul ? "Total AED (options marked ●)" : "Total AED",
    notes: [mul ? "Several options are offered for some items. Reply with the item number and option letter, for example 1A 2B. The total shows the options marked ●." : ""],
    vat: VAT_LINE, terms: company.terms || "", bank: "", stamp: "", sample: e.sample,
  };
}
export function invoiceModel(x, credits) {
  const cn = x.creditId && credits.find(c => c.id === x.creditId);
  const meta = [["Invoice date", fmtDate(x.issueDate)]];
  if (x.supplyDate && fmtDate(x.supplyDate) !== fmtDate(x.issueDate)) meta.push(["Date of supply", fmtDate(x.supplyDate)]);
  meta.push(["Payment due", n(x.payTerms) ? fmtDate(x.dueDate) : "On receipt"], ["Reference", [x.enqRef, x.quoteRef].filter(Boolean).join(" · ")]);
  return {
    kind: "invoice", title: "INVOICE", no: invNo(x), seller: x.seller || {}, buyer: x.buyer || {}, buyerLabel: "Bill to", meta, lead: false,
    rows: (x.lines || []).map((l, i) => ({ no: i + 1, desc: descOf(l), qual: QUAL[l.quality] || "", q: n(l.qty), unit: n(l.unit), disc: n(l.disc), amt: n(l.amount) })),
    sub: n(x.sub), extra: n(x.extraDisc), total: n(x.total), totalLabel: "Total AED", notes: [x.notes || ""],
    vat: VAT_LINE + " This is not a tax invoice.", terms: (x.seller || {}).terms || "", bank: (x.seller || {}).bank || "",
    stamp: x.status === "cancelled" ? "CANCELLED" + (cn ? " · " + cnNo(cn) : "") : balOf(x) <= 0 ? "PAID" : "", sample: x.sample,
  };
}
export function creditModel(c) {
  return {
    kind: "credit", title: "CREDIT NOTE", no: cnNo(c), seller: c.seller || {}, buyer: c.buyer || {}, buyerLabel: "Issued to",
    meta: [["Date", fmtDate(c.date)], ["Against invoice", c.invRef], ["Invoice date", fmtDate(c.invDate)]], lead: false,
    rows: (c.lines || []).map((l, i) => ({ no: i + 1, desc: descOf(l), qual: QUAL[l.quality] || "", q: n(l.qty), unit: n(l.unit), disc: n(l.disc), amt: n(l.amount) })),
    sub: n(c.sub), extra: n(c.extraDisc), total: n(c.total), totalLabel: "Total credited AED", notes: ["Reason: " + (c.reason || "")],
    vat: VAT_LINE + " This is not a tax credit note.", terms: "", bank: "", stamp: "", sample: c.sample,
  };
}
export const sellerLines = s => [s.address, [s.phone, s.email].filter(Boolean).join(" · "), s.licence ? `Trade licence no. ${s.licence}${s.authority ? " · " + s.authority : ""}` : ""].filter(Boolean);
export const buyerLines = b => [b.address, b.trn ? "TRN " + b.trn : "", b.attn ? "Attn: " + b.attn : ""].filter(Boolean);

export async function buildPdf(m) {
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const d = new jsPDF({ unit: "mm", format: "a4" }), L = m.lead;
  const W = 210, Lm = 16, R = W - 16; let y = 18;
  d.setFont("helvetica", "bold"); d.setFontSize(15); d.text(m.seller.name || "", Lm, y);
  d.setFontSize(18); d.text(m.title, R, y, { align: "right" });
  d.setFont("helvetica", "normal"); d.setFontSize(9);
  const sl = sellerLines(m.seller); sl.forEach((t, i) => d.text(String(t), Lm, y + 6 + i * 4.4));
  d.setFont("courier", "bold"); d.setFontSize(11); d.text(m.no, R, y + 7, { align: "right" });
  if (m.stamp) { const paid = m.stamp.startsWith("PAID"); d.setFont("helvetica", "bold"); d.setFontSize(11); d.setTextColor(paid ? 30 : 180, paid ? 116 : 38, paid ? 72 : 30); d.text(m.stamp, R, y + 13, { align: "right" }); d.setTextColor(20); }
  y += Math.max(20, 8 + sl.length * 4.4); d.setLineWidth(0.6); d.line(Lm, y, R, y); y += 7;
  d.setFont("helvetica", "normal"); d.setFontSize(7.5); d.setTextColor(110); d.text(m.buyerLabel.toUpperCase(), Lm, y); d.setTextColor(20);
  d.setFontSize(10); d.setFont("helvetica", "bold"); d.text(m.buyer.name || "", Lm, y + 5); d.setFont("helvetica", "normal"); d.setFontSize(9.5);
  const bl = buyerLines(m.buyer); bl.forEach((t, i) => d.text(String(t), Lm, y + 10 + i * 4.6));
  m.meta.forEach(([k, v], i) => { d.setFontSize(7.5); d.setTextColor(110); d.text(k.toUpperCase(), R - 48, y + i * 5, { align: "right" }); d.setFontSize(9.5); d.setTextColor(20); d.text(String(v), R, y + i * 5, { align: "right" }); });
  y += Math.max(12 + bl.length * 4.6, m.meta.length * 5) + 4;
  const head = L ? ["#", "Description", "Quality", "Lead time", "Qty", "Unit price", "Discount", "Amount"] : ["#", "Description", "Quality", "Qty", "Unit price", "Discount", "Amount"];
  const body = m.rows.map(r => { const a = [(r.sel ? "* " : "") + r.no, r.desc, r.qual]; if (L) a.push(r.lead); a.push(r.q, money(r.unit), r.disc ? money(r.disc) : "-", money(r.amt)); return a; });
  const cs = L ? { 0: { cellWidth: 12 }, 2: { cellWidth: 24 }, 3: { cellWidth: 18 }, 4: { halign: "right", cellWidth: 10 }, 5: { halign: "right", cellWidth: 22 }, 6: { halign: "right", cellWidth: 18 }, 7: { halign: "right", cellWidth: 24 } }
    : { 0: { cellWidth: 10 }, 2: { cellWidth: 26 }, 3: { halign: "right", cellWidth: 12 }, 4: { halign: "right", cellWidth: 24 }, 5: { halign: "right", cellWidth: 20 }, 6: { halign: "right", cellWidth: 26 } };
  autoTable(d, {
    startY: y, margin: { left: Lm, right: W - R }, head: [head], body, theme: "plain", columnStyles: cs,
    styles: { fontSize: 9, cellPadding: 2, lineColor: [215, 215, 215], lineWidth: { bottom: 0.2 } },
    headStyles: { fillColor: [255, 255, 255], textColor: [90, 90, 90], fontStyle: "bold", lineWidth: { bottom: 0.4 }, lineColor: [120, 120, 120] },
    didParseCell: h => { if (h.section === "body" && m.rows[h.row.index]?.sel) h.cell.styles.fontStyle = "bold"; },
  });
  y = d.lastAutoTable.finalY + 7; const X = R - 80;
  if (y > 250) { d.addPage(); y = 20; }
  const line = (l, v, b) => { d.setFont("helvetica", b ? "bold" : "normal"); d.setFontSize(b ? 11 : 9.5); d.text(l, X, y); d.text(v, R, y, { align: "right" }); y += b ? 7 : 5.5; };
  line("Subtotal", money(m.sub)); if (m.extra) line("Additional discount", "-" + money(m.extra));
  d.setLineWidth(0.5); d.line(X, y - 2.5, R, y - 2.5); y += 2; line(m.totalLabel.replace("●", "*"), money(m.total), true);
  d.setFont("helvetica", "italic"); d.setFontSize(9); d.text(d.splitTextToSize(amountWords(m.total), R - Lm), Lm, y + 2); y += 10;
  d.setDrawColor(200); d.setLineWidth(0.2); d.line(Lm, y, R, y); y += 6; d.setFontSize(9);
  const para = (t, bold) => { if (!t) return; d.setFont("helvetica", bold ? "bold" : "normal"); const s = d.splitTextToSize(t.replace(/●/g, "*"), R - Lm); if (y + s.length * 4.4 > 285) { d.addPage(); y = 20; } d.text(s, Lm, y); y += s.length * 4.4 + 1.5; };
  m.notes.forEach(t => para(t)); para(m.vat, true); para(m.terms ? "Terms: " + m.terms : ""); para(m.bank ? "Payment to: " + m.bank : "");
  return d.output("blob");
}

export function quoteText(e, company) {
  const c = calc(e), mul = multi(e), lines = []; let num = 0;
  (e.items || []).forEach(it => {
    if (!optOf(it)) return; num++; const q = n(it.qty);
    const name = `${it.part}${it.vehicle ? " – " + it.vehicle : ""}${q > 1 ? " ×" + q : ""}`;
    if (it.options.length === 1) { const o = it.options[0]; lines.push(`${num}. ${name}\n    ${QUAL[o.quality]} · ${leadText(o.lead)}: AED ${money(q * n(o.sell) - n(o.disc))}`); }
    else { lines.push(`${num}. ${name}`); it.options.forEach((o, j) => lines.push(`    *${num}${LET[j]}* ${QUAL[o.quality]} · ${leadText(o.lead)}: AED ${money(q * n(o.sell) - n(o.disc))}`)); }
  });
  const days = n(company.quoteValidDays || 7);
  const tail = mul ? `Reply with your choice, e.g. *1A 2B*. Valid ${days} days.` : `Valid ${days} days. Reply *OK ${qtNo(e)}* to confirm.`;
  return [`*Quotation ${qtNo(e)}* (${enqNo(e)})`, ...lines, !mul && c.extra ? `Discount: −AED ${money(c.extra)}` : "", mul ? "" : `*Total: AED ${money(c.total)}*`, tail].filter(Boolean).join("\n");
}
export function invoiceText(x) {
  return [`*Invoice ${invNo(x)}* (${x.enqRef})`, ...(x.lines || []).map((l, i) => `${i + 1}. ${descOf(l)}${n(l.qty) > 1 ? " ×" + n(l.qty) : ""} – ${QUAL[l.quality]}: AED ${money(l.amount)}`),
    n(x.extraDisc) ? `Discount: −AED ${money(x.extraDisc)}` : "", `*Total: AED ${money(x.total)}*`,
    balOf(x) > 0 && balOf(x) < n(x.total) ? `Balance due: AED ${money(balOf(x))}` : "",
    n(x.payTerms) ? `Payment due by ${fmtDate(x.dueDate)}.` : "Payment due on receipt.", "PDF attached. Thank you!"].filter(Boolean).join("\n");
}
export const creditText = c => `*Credit note ${cnNo(c)}* cancels invoice ${c.invRef} for AED ${money(c.total)}.\nReason: ${c.reason}\nPDF attached.`;

export function recordsCsv(invoices, credits) {
  const q = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [["Type", "Number", "Date", "Date of supply", "Due date", "Customer", "Customer TRN", "Enquiry", "Quote", "Subtotal", "Additional discount", "Total AED", "Received", "Balance", "Status", "Linked document", "Reason / note", "Sample"]];
  invoices.slice().sort((a, b) => a.invNo - b.invNo).forEach(x => {
    const cn = x.creditId && credits.find(c => c.id === x.creditId);
    rows.push(["Invoice", invNo(x), isoDay(x.issueDate), isoDay(x.supplyDate || x.issueDate), isoDay(x.dueDate || x.issueDate), x.buyer?.name, x.buyer?.trn, x.enqRef, x.quoteRef, n(x.sub).toFixed(2), n(x.extraDisc).toFixed(2), n(x.total).toFixed(2), paidOf(x).toFixed(2), balOf(x).toFixed(2), invState(x).l, cn ? cnNo(cn) : "", x.notes, x.sample ? "yes" : ""]);
  });
  credits.slice().sort((a, b) => a.cnNo - b.cnNo).forEach(c => rows.push(["Credit note", cnNo(c), isoDay(c.date), "", "", c.buyer?.name, c.buyer?.trn, "", "", (-n(c.sub)).toFixed(2), (-n(c.extraDisc)).toFixed(2), (-n(c.total)).toFixed(2), "", "", "Issued", c.invRef, c.reason, c.sample ? "yes" : ""]));
  return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
}
