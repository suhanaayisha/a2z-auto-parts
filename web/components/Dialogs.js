"use client";
// Creating an invoice from a quote, and adding or editing a workshop.
import { useMemo, useState } from "react";
import { useApp } from "./Shell";
import { DocView } from "./Docs";
import { api } from "@/lib/api";
import { n, r2, money, isoDay, QUAL, LET, TERMS, remQty, invQty, live, enqNo, qtNo, invNo, pad } from "@/lib/calc";

export function InvoiceDialog({ enquiry: e, onDone }) {
  const app = useApp();
  const { company, invoices } = app;
  const prior = live(invoices).filter(x => x.enquiryId === e.id);
  const blocked = !company.name || !company.address || /your company name/i.test(company.name);
  const rows = (e.items || []).map((it, i) => ({ it, i, rem: remQty(invoices, e, it, i) })).filter(r => r.rem > 0 && (r.it.options || []).length);
  const [sel, setSel] = useState(() => Object.fromEntries(rows.map(r => [r.i, { on: r.it.chosen !== -1, opt: Math.max(0, n(r.it.chosen)), qty: r.rem }])));
  const [extra, setExtra] = useState(prior.length ? "" : (n(e.extraDisc) || ""));
  const [supply, setSupply] = useState(isoDay(Date.now()));
  const [terms, setTerms] = useState(n(company.payDays));
  const [note, setNote] = useState("");
  const [sp, setSp] = useState(e.salesperson || "");
  const planned = Math.max(0, n(e.commAmt) - prior.reduce((s, x) => s + n(x.commAmt), 0));
  const [comm, setComm] = useState(planned ? planned.toFixed(2) : "");
  const [busy, setBusy] = useState(false);

  const lines = useMemo(() => rows.flatMap(({ it, i, rem }) => {
    const s = sel[i]; if (!s?.on) return [];
    const o = it.options[s.opt]; const q = Math.min(rem, Math.max(0, Math.floor(n(s.qty)))); if (!o || !q) return [];
    const disc = r2(n(o.disc) * q / Math.max(1, n(it.qty)));
    return [{ i, ik: it.k, opt: s.opt, qty: q, amount: r2(q * n(o.sell) - disc), cost: n(o.cost) * q }];
  }), [rows, sel]);
  const sub = lines.reduce((s, l) => s + l.amount, 0), ex = Math.min(sub, n(extra)), total = r2(sub - ex);
  const profit = total - lines.reduce((s, l) => s + l.cost, 0) - n(comm);
  const nextNo = (e.sample ? invoices : invoices.filter(x => !x.sample)).reduce((m, x) => Math.max(m, n(x.invNo)), 0) + 1;
  const upd = (i, patch) => setSel(s => ({ ...s, [i]: { ...s[i], ...patch } }));

  async function issue() {
    setBusy(true);
    try {
      const r = await api("POST", `/enquiries/${e.id}/invoices`, {
        lines: lines.map(l => ({ ik: l.ik, opt: l.opt, qty: l.qty })), extraDisc: ex, supplyDate: supply, payTerms: terms, notes: note, salesperson: sp, commAmt: n(comm),
      });
      app.upsert("invoices", r.invoice); app.upsert("enquiries", r.enquiry); onDone?.(r.enquiry);
      app.toast(invNo(r.invoice) + " issued"); app.open(<DocView kind="invoice" id={r.invoice.id} wide />);
    } catch (err) { app.toast(err.message); setBusy(false); }
  }
  function pct() {
    const p = (company.salespeople || []).find(x => x.name === sp);
    if (!p || p.pct == null) { app.toast("Choose a salesperson with a default rate"); return; }
    setComm((Math.round(total * n(p.pct)) / 100).toFixed(2));
  }

  return (<>
    <div className="dh"><h2>Invoice {enqNo(e)}{e.quoteNo ? " · from " + qtNo(e) : ""}</h2><button className="btn ghost sm" onClick={app.close} aria-label="Close">✕</button></div>
    <div className="db">
      {blocked && <div className="banner" style={{ background: "var(--crit-soft)" }}>Add your company name and address in Settings before issuing invoices. They are printed on every invoice.</div>}
      {!blocked && !company.licence && <div className="banner">Your trade licence number is not set. Add it in Settings so it prints on invoices.</div>}
      <p className="small muted" style={{ margin: 0 }}>Tick the items to invoice now. Items left out stay open for a later invoice.</p>
      <div className="tw"><table><thead><tr><th></th><th>Item</th><th>Option</th><th>Qty</th><th className="r">Amount</th></tr></thead><tbody>
        {rows.map(({ it, i, rem }) => {
          const s = sel[i], l = lines.find(x => x.i === i), done = invQty(invoices, e, it, i);
          return (<tr key={it.k}>
            <td><input type="checkbox" checked={s.on} onChange={ev => upd(i, { on: ev.target.checked })} aria-label={`Invoice item ${i + 1}`} /></td>
            <td>{it.part}<div className="small faint">{it.vehicle}{done ? ` · ${done} already invoiced` : ""}</div></td>
            <td>{it.options.length > 1
              ? <select value={s.opt} onChange={ev => upd(i, { opt: n(ev.target.value) })} style={{ minWidth: 170 }} aria-label={`Option for item ${i + 1}`}>
                  {it.options.map((o, j) => <option key={j} value={j}>{i + 1}{LET[j]} · {QUAL[o.quality]} · {money(o.sell)}</option>)}</select>
              : <><span className="q" data-q={it.options[0].quality}>{QUAL[it.options[0].quality]}</span> <span className="num small">{money(it.options[0].sell)}</span></>}</td>
            <td><input type="number" value={s.qty} min="1" max={rem} step="1" style={{ width: 64 }} onChange={ev => upd(i, { qty: ev.target.value })} aria-label="Quantity" /></td>
            <td className="r num">{l ? money(l.amount) : "–"}</td>
          </tr>);
        })}
      </tbody></table></div>
      <div className="fgrid">
        <label className="field"><span>Additional discount (AED)</span><input type="number" value={extra} onChange={ev => setExtra(ev.target.value)} min="0" step="0.01" placeholder="0.00" /></label>
        <label className="field"><span>Date of supply</span><input type="date" value={supply} onChange={ev => setSupply(ev.target.value)} /></label>
        <label className="field"><span>Payment terms</span><select value={terms} onChange={ev => setTerms(n(ev.target.value))}>{TERMS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select></label>
      </div>
      <label className="field"><span>Note printed on the invoice (optional)</span><input type="text" value={note} onChange={ev => setNote(ev.target.value)} placeholder="e.g. Delivered to Al Quoz workshop" /></label>
      <div className="tbox internal"><span className="label" style={{ color: "var(--internal)" }}>Internal only · not printed</span>
        <div className="fgrid">
          <label className="field"><span>Salesperson</span><select value={sp} onChange={ev => setSp(ev.target.value)}><option value="">None</option>{(company.salespeople || []).map(p => <option key={p.name}>{p.name}</option>)}</select></label>
          {<label className="field"><span>Commission (AED)</span><span className="row" style={{ flexWrap: "nowrap", gap: 6 }}><button className="btn ghost sm" type="button" onClick={pct} title="Apply the salesperson's default rate">%</button><input type="number" value={comm} onChange={ev => setComm(ev.target.value)} min="0" step="0.01" placeholder="0.00" /></span></label>}
        </div>
        {<div className="tl small"><span>Profit on this invoice</span><span className={"num" + (profit < 0 ? " neg" : "")}>{money(profit)}</span></div>}
      </div>
      <div className="tl big" style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16 }}><span>Invoice total AED</span><span className="num">{money(total)}</span></div>
      <p className="small faint" style={{ margin: 0 }}>Once issued, the invoice cannot be edited or deleted. To correct it, cancel it with a credit note and issue a new one.</p>
    </div>
    <div className="df"><button className="btn" onClick={app.close}>Cancel</button>
      <button className="btn primary" onClick={issue} disabled={busy || blocked || !lines.length}>{busy ? "Issuing…" : lines.length ? `Issue INV-${pad(nextNo)} · AED ${money(total)}` : "Select items to invoice"}</button></div>
  </>);
}

export function CustomerDialog({ customer }) {
  const app = useApp();
  const c = customer || { name: "", trn: "", contact: "", phone: "", groups: "", address: "", notes: "" };
  const [busy, setBusy] = useState(false);
  async function submit(ev) {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.currentTarget)); setBusy(true);
    try {
      const r = c.id ? await api("PUT", `/customers/${c.id}`, f) : await api("POST", "/customers", f);
      app.upsert("customers", r.customer); app.toast("Workshop saved"); app.close();
    } catch (e) { app.toast(e.message); setBusy(false); }
  }
  async function del() {
    try { await api("DELETE", `/customers/${c.id}`); app.remove("customers", c.id); app.toast("Workshop deleted"); app.close(); }
    catch (e) { app.toast(e.message); }
  }
  return (<form onSubmit={submit}>
    <div className="dh"><h2>{c.id ? "Edit workshop" : "Add workshop"}</h2><button type="button" className="btn ghost sm" onClick={app.close} aria-label="Close">✕</button></div>
    <div className="db">
      <label className="field"><span>Workshop name</span><input type="text" name="name" defaultValue={c.name} required autoFocus /></label>
      <div className="fgrid">
        <label className="field"><span>TRN (15 digits, if registered)</span><input type="text" name="trn" defaultValue={c.trn} inputMode="numeric" maxLength={15} pattern="[0-9]{15}" title="15 digits" /></label>
        <label className="field"><span>Contact person</span><input type="text" name="contact" defaultValue={c.contact} /></label>
        <label className="field"><span>Phone</span><input type="text" name="phone" defaultValue={c.phone} /></label>
        <label className="field"><span>WhatsApp group name</span><input type="text" name="groups" defaultValue={c.groups} /></label>
      </div>
      <label className="field"><span>Address</span><input type="text" name="address" defaultValue={c.address} /></label>
      <label className="field"><span>Notes</span><textarea name="notes" rows={2} defaultValue={c.notes} /></label>
    </div>
    <div className="df">{c.id && <><button type="button" className="btn ghost danger" onClick={del}>Delete</button><span style={{ flex: 1 }} /></>}
      <button type="button" className="btn" onClick={app.close}>Cancel</button><button className="btn primary" type="submit" disabled={busy}>Save workshop</button></div>
  </form>);
}
