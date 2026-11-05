"use client";
import Link from "next/link";
import { useApp } from "@/components/Shell";
import EnqRow from "@/components/EnqRow";
import { calc, aed, money, ageOf, deliv, live, balOf, invProfit, isOverdue, n, MONTHS, VAT_MANDATORY, DAY } from "@/lib/calc";

export default function Dashboard() {
  const { enquiries: E, invoices, customers } = useApp();
  const I = live(invoices), now = new Date(), mStart = new Date(now.getFullYear(), now.getMonth(), 1), mName = MONTHS[now.getMonth()];
  const nw = E.filter(e => e.status === "new").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const quoted = E.filter(e => e.status === "quoted"), conf = E.filter(e => e.status === "confirmed");
  const invM = I.filter(x => new Date(x.issueDate) >= mStart);
  const sales = invM.reduce((s, x) => s + n(x.total), 0), profit = invM.reduce((s, x) => s + invProfit(x), 0);
  const open = I.filter(x => balOf(x) > 0), outstanding = open.reduce((s, x) => s + balOf(x), 0), overdue = open.filter(isOverdue);
  const oldest = nw[0] ? ageOf(nw[0].createdAt) : null;
  const awaiting = E.filter(e => { const d = deliv(e); return d && !d.done; }).sort((a, b) => deliv(a).due - deliv(b).due);
  const late = awaiting.filter(e => deliv(e).days < 0);

  const since = new Date(Date.now() - 90 * DAY);
  const rows = customers.map(c => {
    const ce = E.filter(e => e.customerId === c.id && new Date(e.createdAt) >= since);
    const hasInv = e => I.some(x => x.enquiryId === e.id);
    const won = ce.filter(hasInv).length, decided = ce.filter(e => e.status === "lost" || hasInv(e)).length;
    const ci = I.filter(x => x.customerId === c.id);
    return { c, cnt: ce.length, won, conv: decided ? Math.round(won / decided * 100) + "%" : "–",
      s: ci.filter(x => new Date(x.issueDate) >= since).reduce((a, x) => a + n(x.total), 0), due: ci.reduce((a, x) => a + balOf(x), 0) };
  }).sort((a, b) => b.s - a.s);

  const t12 = I.filter(x => new Date(x.issueDate) >= new Date(Date.now() - 365 * DAY)).reduce((s, x) => s + n(x.total), 0);
  const pct = Math.min(100, t12 / VAT_MANDATORY * 100);
  const cm = {};
  I.filter(x => x.salesperson && n(x.commAmt)).forEach(x => {
    const k = x.salesperson; cm[k] = cm[k] || { m: 0, owed: 0, sales: 0 };
    if (new Date(x.issueDate) >= mStart) { cm[k].m += n(x.commAmt); cm[k].sales += n(x.total); }
    if (!x.commPaid) cm[k].owed += n(x.commAmt);
  });

  return (<>
    <div className="kpis">
      <Link className="kpi" href="/enquiries?f=new" data-tone={nw.length ? "crit" : undefined}><span className="label">Needs pricing</span><span className="v">{nw.length}</span><span className="s">{oldest ? "Oldest waiting " + oldest.s : "Nothing waiting"}</span></Link>
      <Link className="kpi" href="/enquiries?f=quoted"><span className="label">Awaiting reply</span><span className="v">{quoted.length}</span><span className="s">{aed(quoted.reduce((s, e) => s + calc(e).total, 0))} quoted</span></Link>
      <Link className="kpi" href="/enquiries?f=confirmed"><span className="label">To invoice</span><span className="v">{conf.length}</span><span className="s">Confirmed, not fully invoiced</span></Link>
      <Link className="kpi" href="/enquiries?f=delivery" data-tone={late.length ? "crit" : undefined}><span className="label">Awaiting delivery</span><span className="v">{awaiting.length}</span><span className="s">{late.length ? late.length + " late" : "None late"}</span></Link>
      <div className="kpi"><span className="label">Sales · {mName}</span><span className="v">{money(sales)}</span><span className="s">{invM.length} invoice{invM.length === 1 ? "" : "s"}, AED</span></div>
      {<div className="kpi"><span className="label">Profit · {mName}</span><span className={"v" + (profit < 0 ? " neg" : "")}>{money(profit)}</span><span className="s">After cost and commission</span></div>}
      <Link className="kpi" href="/documents" data-tone={overdue.length ? "crit" : outstanding ? "warn" : undefined}><span className="label">Unpaid invoices</span><span className="v">{money(outstanding)}</span><span className="s">{open.length} open{overdue.length ? ", " + overdue.length + " overdue" : ""}, AED</span></Link>
    </div>
    <div className="grid2">
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <section className="panel"><div className="hd"><h2>Waiting for a price</h2><span className="small faint">Oldest first</span></div>
          <div className="list">{nw.length ? nw.map(e => <EnqRow key={e.id} e={e} />) : <div className="empty">Every enquiry has been priced.</div>}</div></section>
        <section className="panel"><div className="hd"><h2>Awaiting delivery</h2><span className="small faint">Due date from lead time</span></div>
          <div className="list">{awaiting.length ? awaiting.map(e => <EnqRow key={e.id} e={e} />) : <div className="empty">All confirmed orders are delivered.</div>}</div></section>
        <section className="panel"><div className="hd"><h2>Workshops</h2><span className="small faint">Last 90 days</span></div>
          <div className="tw"><table><thead><tr><th>Workshop</th><th className="r">Enq.</th><th className="r">Won</th><th className="r">Win rate</th><th className="r">Sales</th><th className="r">Unpaid</th></tr></thead>
            <tbody>{rows.length ? rows.map(r => <tr key={r.c.id}><td>{r.c.name}</td><td className="r num">{r.cnt}</td><td className="r num">{r.won}</td><td className="r num">{r.conv}</td><td className="r num">{money(r.s)}</td><td className={"r num" + (r.due ? " neg" : "")}>{money(r.due)}</td></tr>)
              : <tr><td colSpan={6} className="muted">Add your first workshop under Customers.</td></tr>}</tbody></table></div></section>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <section className="panel"><div className="hd"><h2>VAT registration watch</h2><span className="small faint">Rolling 12 months</span></div>
          <div className="bd" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="num" style={{ fontSize: 18, fontWeight: 600 }}>{aed(t12)}</span><span className="small muted">{pct.toFixed(1)}% of mandatory threshold</span></div>
            <div className="meter" role="img" aria-label={`${pct.toFixed(1)} percent of the AED 375,000 threshold`}><i style={{ width: pct + "%" }} /></div>
            <div className="meter-marks"><span style={{ left: "50%" }}>187,500<br />voluntary</span><span style={{ left: "100%" }}>375,000<br />must register</span></div>
            <p className="small muted" style={{ margin: 0 }}>Invoiced sales, less cancelled invoices. Once taxable sales pass AED 375,000 in any 12 months, or are expected to within the next 30 days, you must register with the FTA. Until then, documents say &quot;Invoice&quot;, not &quot;Tax Invoice&quot;, and carry no VAT.</p>
          </div></section>
        {<section className="panel"><div className="hd"><h2>Commission</h2><span className="pill" style={{ background: "var(--internal-soft)", color: "var(--internal)" }}>Internal only</span></div>
          <div className="tw"><table><thead><tr><th>Salesperson</th><th className="r">Sales · {mName}</th><th className="r">Earned · {mName}</th><th className="r">Not yet paid</th></tr></thead>
            <tbody>{Object.keys(cm).length ? Object.entries(cm).map(([k, v]) => <tr key={k}><td>{k}</td><td className="r num">{money(v.sales)}</td><td className="r num">{money(v.m)}</td><td className="r num">{money(v.owed)}</td></tr>)
              : <tr><td colSpan={4} className="muted">No commission on invoices yet.</td></tr>}</tbody></table></div></section>}
      </div>
    </div>
  </>);
}
