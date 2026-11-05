"use client";
import Link from "next/link";
import { useApp, SampleChip } from "@/components/Shell";
import { CustomerDialog } from "@/components/Dialogs";
import { money, live, balOf, n } from "@/lib/calc";

export default function Customers() {
  const { customers, enquiries, invoices, open } = useApp();
  const L = live(invoices);
  const list = customers.slice().sort((a, b) => a.name.localeCompare(b.name));
  return (<>
    <div className="row" style={{ justifyContent: "space-between" }}><h2>Customers</h2><button className="btn primary" onClick={() => open(<CustomerDialog />)}>+ Add workshop</button></div>
    <div className="cards">{list.length ? list.map(c => {
      const openEnq = enquiries.filter(e => e.customerId === c.id && ["new", "quoted", "confirmed"].includes(e.status)).length;
      const ci = L.filter(x => x.customerId === c.id), due = ci.reduce((s, x) => s + balOf(x), 0), sales = ci.reduce((s, x) => s + n(x.total), 0);
      return (<article className="ccard" key={c.id}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}><h3>{c.name}<SampleChip on={c.sample} /></h3><button className="btn sm" onClick={() => open(<CustomerDialog customer={c} />)}>Edit</button></div>
        <dl className="kv"><dt>TRN</dt><dd className="mono">{c.trn || <span className="faint">Not given</span>}</dd><dt>Contact</dt><dd>{c.contact}{c.phone ? " · " + c.phone : ""}</dd>
          <dt>Group</dt><dd>{c.groups || <span className="faint">None</span>}</dd>{c.address && <><dt>Address</dt><dd>{c.address}</dd></>}{c.notes && <><dt>Notes</dt><dd>{c.notes}</dd></>}</dl>
        <div className="stats"><span><b>{openEnq}</b>open</span><span><b>{money(sales)}</b>sales</span><span><b className={due ? "neg" : ""}>{money(due)}</b>unpaid</span>
          <Link className="btn ghost sm" style={{ marginLeft: "auto" }} href={`/enquiries?f=all&c=${c.id}`}>Enquiries →</Link></div>
      </article>);
    }) : <div className="empty panel">No workshops yet. Add the workshops you quote for.</div>}</div>
  </>);
}
