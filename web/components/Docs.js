"use client";
// Viewing, sharing and acting on quotes, invoices and credit notes.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApp, Pill, SampleChip } from "./Shell";
import { api, saveFile } from "@/lib/api";
import { quoteModel, invoiceModel, creditModel, buildPdf, sellerLines, buyerLines, quoteText, invoiceText, creditText } from "@/lib/docs";
import { money, fmtDate, isoDay, amountWords, balOf, paidOf, invCost, invProfit, invState, cnNo, invNo, n, r2 } from "@/lib/calc";

export function Paper({ m }) {
  return (
    <div className="paper">
      <div className="ph">
        <div className="co"><b>{m.seller.name}</b>{sellerLines(m.seller).map((l, i) => <span key={i}>{l}<br /></span>)}</div>
        <div className="dt"><div className="t">{m.title}</div><div className="n">{m.no}</div>
          {m.stamp && <div className="stamp" data-k={m.stamp.startsWith("PAID") ? "paid" : "void"}>{m.stamp}</div>}</div>
      </div>
      <div className="meta">
        <div><div className="lb">{m.buyerLabel}</div><b>{m.buyer.name}</b>{buyerLines(m.buyer).map((l, i) => <span key={i}><br />{l}</span>)}</div>
        <div className="mt">{m.meta.map(([k, v]) => <div key={k}><span className="lb">{k}</span> {v}</div>)}</div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Description</th><th>Quality</th>{m.lead && <th>Lead time</th>}<th className="r">Qty</th><th className="r">Unit price</th><th className="r">Discount</th><th className="r">Amount</th></tr></thead>
        <tbody>{m.rows.map((r, i) => (
          <tr key={i}><td className="mono" style={{ whiteSpace: "nowrap" }}>{r.sel ? "● " : ""}{r.no}</td><td>{r.desc}</td><td>{r.qual}</td>{m.lead && <td>{r.lead}</td>}
            <td className="r num">{r.q}</td><td className="r num">{money(r.unit)}</td><td className="r num">{r.disc ? money(r.disc) : "–"}</td><td className="r num">{money(r.amt)}</td></tr>
        ))}</tbody>
      </table>
      <div className="pt">
        <div><span>Subtotal</span><span className="num">{money(m.sub)}</span></div>
        {m.extra ? <div><span>Additional discount</span><span className="num">−{money(m.extra)}</span></div> : null}
        <div className="g"><span>{m.totalLabel}</span><span className="num">{money(m.total)}</span></div>
      </div>
      <div className="words">{amountWords(m.total)}</div>
      <div className="foot">
        {m.notes.filter(Boolean).map((t, i) => <div key={i}>{t}</div>)}
        <div><b>{m.vat}</b></div>
        {m.terms && <div><b>Terms:</b> {m.terms}</div>}
        {m.bank && <div><b>Payment to:</b> {m.bank}</div>}
      </div>
    </div>
  );
}

async function copy(text, toast, open) {
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into the WhatsApp group"); }
  catch { open(<CopyBox text={text} />); }
}
function CopyBox({ text }) {
  const { close } = useApp();
  return (<>
    <div className="dh"><h2>Copy this text</h2><button className="btn ghost sm" onClick={close} aria-label="Close">✕</button></div>
    <div className="db"><textarea rows={10} defaultValue={text} autoFocus onFocus={e => e.target.select()} /></div>
  </>);
}

// kind: "quote" (pass enquiry) | "invoice" | "credit" (pass id)
export function DocView({ kind, id, enquiry }) {
  const app = useApp();
  const { company, customers, invoices, credits, toast, open, close } = app;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  let m, text, inv = null, cn = null;
  if (kind === "quote") {
    const e = enquiry || app.enquiries.find(x => x.id === id);
    m = quoteModel(e, company, customers.find(c => c.id === e.customerId)); text = quoteText(e, company);
  } else if (kind === "invoice") {
    inv = invoices.find(x => x.id === id); if (!inv) return null;
    m = invoiceModel(inv, credits); text = invoiceText(inv);
  } else {
    cn = credits.find(x => x.id === id); if (!cn) return null;
    m = creditModel(cn); text = creditText(cn);
  }
  async function pdf() {
    setBusy(true);
    try { saveFile(await buildPdf(m), `${m.no} ${String(m.buyer.name || "").replace(/[^\w\- ]+/g, "").trim().slice(0, 40)}.pdf`); }
    catch { toast("The PDF could not be made. Try again."); }
    setBusy(false);
  }
  async function toggleComm(ev) {
    try { const r = await api("PATCH", `/invoices/${inv.id}/commission`, { commPaid: ev.target.checked }); app.upsert("invoices", r.invoice); toast(ev.target.checked ? "Commission marked paid" : "Commission marked unpaid"); }
    catch (e) { toast(e.message); }
  }
  const st = inv && invState(inv);
  return (<>
    <div className="dh"><h2>{m.no}<SampleChip on={m.sample} /></h2><button className="btn ghost sm" onClick={close} aria-label="Close">✕</button></div>
    <div className="db" style={{ background: "var(--surface-2)" }}>
      <div className="tw"><Paper m={m} /></div>
      {inv && (
        <div className="totals" style={{ marginTop: 12 }}>
          <div className="tbox"><span className="label">Payments · <Pill s={st.t}>{st.l}</Pill></span>
            {(inv.payments || []).length ? inv.payments.map((p, i) => <div className="tl small" key={i}><span>{fmtDate(p.date)} · {p.method}{p.ref ? " · " + p.ref : ""}</span><span className="num">{money(p.amount)}</span></div>)
              : <span className="small faint">No payments recorded.</span>}
            <div className="tl big"><span>Balance AED</span><span className="num">{money(balOf(inv))}</span></div>
          </div>
          {<div className="tbox internal"><span className="label" style={{ color: "var(--internal)" }}>Internal only · not printed</span>
            <div className="tl"><span>Cost</span><span className="num">{money(invCost(inv))}</span></div>
            <div className="tl"><span>Commission{inv.salesperson ? " · " + inv.salesperson : ""}</span><span className="num">{money(inv.commAmt)}</span></div>
            <div className="tl big"><span>Profit</span><span className={"num" + (invProfit(inv) < 0 ? " neg" : "")}>{money(invProfit(inv))}</span></div>
            {n(inv.commAmt) > 0 && <label className="tl small" style={{ justifyContent: "flex-start", gap: 8 }}><input type="checkbox" checked={!!inv.commPaid} onChange={toggleComm} /> Commission paid</label>}
          </div>}
        </div>
      )}
    </div>
    <div className="df">
      {inv && inv.status !== "cancelled" && <><button className="btn ghost danger" onClick={() => open(<CancelDialog inv={inv} />)}>Cancel invoice</button><span style={{ flex: 1 }} /></>}
      {inv && <button className="btn" onClick={() => { close(); router.push(`/enquiries/${inv.enquiryId}`); }}>Open {inv.enqRef}</button>}
      {cn && <button className="btn" onClick={() => open(<DocView kind="invoice" id={cn.invoiceId} wide />)}>View {cn.invRef}</button>}
      {inv && balOf(inv) > 0 && <button className="btn" onClick={() => open(<PaymentDialog inv={inv} />)}>Record payment</button>}
      <button className="btn" onClick={() => copy(text, toast, open)}>Copy for WhatsApp</button>
      <button className="btn primary" onClick={pdf} disabled={busy}>{busy ? "Making PDF…" : "Download PDF"}</button>
    </div>
  </>);
}

export function PaymentDialog({ inv }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  async function submit(ev) {
    ev.preventDefault(); const f = new FormData(ev.currentTarget); setBusy(true);
    try {
      const r = await api("POST", `/invoices/${inv.id}/payments`, { amount: r2(f.get("amount")), date: f.get("date"), method: f.get("method"), ref: f.get("ref") });
      app.upsert("invoices", r.invoice); if (r.enquiry) app.upsert("enquiries", r.enquiry);
      app.toast("Payment recorded"); app.open(<DocView kind="invoice" id={inv.id} wide />);
    } catch (e) { app.toast(e.message); setBusy(false); }
  }
  return (<form onSubmit={submit}>
    <div className="dh"><h2>Record payment · {invNo(inv)}</h2><button type="button" className="btn ghost sm" onClick={app.close} aria-label="Close">✕</button></div>
    <div className="db"><p className="small muted" style={{ margin: 0 }}>Balance due AED {money(balOf(inv))}</p>
      <div className="fgrid">
        <label className="field"><span>Amount (AED)</span><input type="number" name="amount" defaultValue={balOf(inv).toFixed(2)} min="0.01" max={balOf(inv)} step="0.01" required /></label>
        <label className="field"><span>Date received</span><input type="date" name="date" defaultValue={isoDay(Date.now())} required /></label>
        <label className="field"><span>Method</span><select name="method"><option>Cash</option><option>Bank transfer</option><option>Cheque</option><option>Card</option></select></label>
        <label className="field"><span>Reference (optional)</span><input type="text" name="ref" placeholder="Cheque or transfer no." /></label>
      </div></div>
    <div className="df"><button type="button" className="btn" onClick={app.close}>Cancel</button><button className="btn primary" type="submit" disabled={busy}>Save payment</button></div>
  </form>);
}

export function CancelDialog({ inv }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  async function submit(ev) {
    ev.preventDefault(); const reason = new FormData(ev.currentTarget).get("reason"); setBusy(true);
    try {
      const r = await api("POST", `/invoices/${inv.id}/cancel`, { reason });
      app.upsert("credits", r.credit); app.upsert("invoices", r.invoice); if (r.enquiry) app.upsert("enquiries", r.enquiry);
      app.toast(cnNo(r.credit) + " issued"); app.open(<DocView kind="credit" id={r.credit.id} wide />);
    } catch (e) { app.toast(e.message); setBusy(false); }
  }
  return (<form onSubmit={submit}>
    <div className="dh"><h2>Cancel {invNo(inv)}?</h2><button type="button" className="btn ghost sm" onClick={app.close} aria-label="Close">✕</button></div>
    <div className="db">
      <p style={{ margin: 0 }}>The invoice stays in your records marked cancelled, and a credit note is issued for the full AED {money(inv.total)}. The items become available to invoice again.</p>
      {paidOf(inv) > 0 && <div className="banner">AED {money(paidOf(inv))} has been received on this invoice. Refund it or use it against the corrected invoice, and keep a note of which.</div>}
      <label className="field"><span>Reason (printed on the credit note)</span><input type="text" name="reason" required placeholder="e.g. Wrong part invoiced, price corrected" autoFocus /></label>
    </div>
    <div className="df"><button type="button" className="btn" onClick={app.close}>Keep invoice</button>
      <button className="btn primary" type="submit" disabled={busy} style={{ background: "var(--crit)", borderColor: "var(--crit)" }}>Cancel invoice and issue credit note</button></div>
  </form>);
}
