"use client";
import { useState } from "react";
import { useApp, Pill, SampleChip } from "@/components/Shell";
import { DocView } from "@/components/Docs";
import { saveFile } from "@/lib/api";
import { recordsCsv } from "@/lib/docs";
import { money, fmtDate, isoDay, calc, live, balOf, paidOf, isOverdue, invState, invNo, cnNo, qtNo, enqNo, STATUS, n } from "@/lib/calc";

export default function Documents() {
  const { invoices, credits, enquiries, customers, open } = useApp();
  const [tab, setTab] = useState("invoices");
  const I = invoices.slice().sort((a, b) => b.invNo - a.invNo), C = credits.slice().sort((a, b) => b.cnNo - a.cnNo);
  const Q = enquiries.filter(e => e.quoteNo).sort((a, b) => b.quoteNo - a.quoteNo);
  const L = live(invoices), tot = L.reduce((s, x) => s + n(x.total), 0), got = L.reduce((s, x) => s + paidOf(x), 0), out = L.reduce((s, x) => s + balOf(x), 0), od = L.filter(isOverdue);
  const cname = x => x.buyer?.name || customers.find(c => c.id === x.customerId)?.name || "";
  const Tab = ({ k, children }) => <button type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{children}</button>;
  return (<>
    <div className="kpis">
      <div className="kpi"><span className="label">Invoiced, all time</span><span className="v">{money(tot)}</span><span className="s">{L.length} invoices, AED</span></div>
      <div className="kpi"><span className="label">Received</span><span className="v">{money(got)}</span><span className="s">AED</span></div>
      <div className="kpi" data-tone={od.length ? "crit" : out ? "warn" : undefined}><span className="label">Outstanding</span><span className="v">{money(out)}</span><span className="s">{L.filter(x => balOf(x) > 0).length} unpaid{od.length ? ", " + od.length + " overdue" : ""}, AED</span></div>
    </div>
    <section className="panel">
      <div className="hd"><div className="filters"><Tab k="invoices">Invoices</Tab><Tab k="credits">Credit notes{C.length ? ` (${C.length})` : ""}</Tab><Tab k="quotes">Quotes</Tab></div>
        <button className="btn sm" onClick={() => saveFile(new Blob([recordsCsv(invoices, credits)], { type: "text/csv" }), `invoices-${isoDay(Date.now())}.csv`)}>Export for records (CSV)</button></div>
      <div className="tw"><table className="stack">
        {tab === "invoices" && <><thead><tr><th>No.</th><th>Date</th><th>Customer</th><th>Enquiry</th><th className="r">Total</th><th className="r">Balance</th><th>Status</th></tr></thead>
          <tbody>{I.length ? I.map(x => { const s = invState(x); return <tr key={x.id} className="click" onClick={() => open(<DocView kind="invoice" id={x.id} wide />)}>
            <td className="mono">{invNo(x)}<SampleChip on={x.sample} /></td><td className="nw r">{fmtDate(x.issueDate)}</td><td className="full">{cname(x)}</td><td className="mono small">{x.enqRef}</td>
            <td className="r num" data-l="Total">{money(x.total)}</td><td className="r num" data-l="Balance">{x.status === "cancelled" ? "–" : money(balOf(x))}</td><td className="r"><Pill s={s.t}>{s.l}</Pill></td></tr>; })
            : <tr><td colSpan={7} className="muted">No invoices yet. Invoices are created from a quote: open the enquiry and press Create invoice.</td></tr>}</tbody></>}
        {tab === "credits" && <><thead><tr><th>No.</th><th>Date</th><th>Customer</th><th>Cancels</th><th className="r">Amount</th><th>Reason</th></tr></thead>
          <tbody>{C.length ? C.map(c => <tr key={c.id} className="click" onClick={() => open(<DocView kind="credit" id={c.id} wide />)}>
            <td className="mono">{cnNo(c)}<SampleChip on={c.sample} /></td><td className="nw r">{fmtDate(c.date)}</td><td className="full">{cname(c)}</td><td className="mono small" data-l="Cancels">{c.invRef}</td><td className="r num">{money(c.total)}</td><td className="full muted">{c.reason}</td></tr>)
            : <tr><td colSpan={6} className="muted">No credit notes.</td></tr>}</tbody></>}
        {tab === "quotes" && <><thead><tr><th>No.</th><th>Date</th><th>Customer</th><th>Enquiry</th><th className="r">Total</th><th>Status</th></tr></thead>
          <tbody>{Q.length ? Q.map(e => <tr key={e.id} className="click" onClick={() => open(<DocView kind="quote" enquiry={e} wide />)}>
            <td className="mono">{qtNo(e)}<SampleChip on={e.sample} /></td><td className="nw r">{fmtDate(e.quoteDate)}</td><td className="full">{cname(e)}</td><td className="mono small">{enqNo(e)}</td><td className="r num">{money(calc(e).total)}</td><td className="full"><Pill s={e.status}>{STATUS[e.status]}</Pill></td></tr>)
            : <tr><td colSpan={6} className="muted">No quotes yet.</td></tr>}</tbody></>}
      </table></div>
      <div className="bd small faint" style={{ borderTop: "1px solid var(--line)" }}>Invoice and credit note numbers run in sequence and are never reused. Issued invoices can&apos;t be edited or deleted; to correct one, cancel it with a credit note instead.</div>
    </section>
  </>);
}
