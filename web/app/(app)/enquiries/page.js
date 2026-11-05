"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/Shell";
import EnqRow from "@/components/EnqRow";
import { deliv, enqNo, qtNo, invNo } from "@/lib/calc";

const FILTERS = [["open", "Open"], ["new", "Needs pricing"], ["quoted", "Quoted"], ["confirmed", "Confirmed"], ["delivery", "Awaiting delivery"], ["invoiced", "Unpaid"], ["paid", "Paid"], ["lost", "Lost"], ["all", "All"]];

function List() {
  const { enquiries, customers, invoices } = useApp();
  const params = useSearchParams();
  const [f, setF] = useState(params.get("f") || "open");
  const [q, setQ] = useState("");
  const [cust, setCust] = useState(params.get("c") || "");
  const name = id => customers.find(c => c.id === id)?.name || "";
  const s = q.trim().toLowerCase();
  const list = enquiries.filter(e => {
    if (f === "delivery") { const d = deliv(e); if (!d || d.done) return false; }
    else if (f === "open") { if (!["new", "quoted", "confirmed"].includes(e.status)) return false; }
    else if (f !== "all" && e.status !== f) return false;
    if (cust && e.customerId !== cust) return false;
    if (s) {
      const hay = [enqNo(e), e.quoteNo ? qtNo(e) : "", ...invoices.filter(x => x.enquiryId === e.id).map(invNo), name(e.customerId), e.sender, e.message,
        ...(e.items || []).map(i => i.vehicle + " " + i.part + " " + (i.options || []).map(o => o.quality).join(" "))].join(" ").toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return (
    <section className="panel">
      <div className="hd"><h2>Enquiries</h2>
        <div className="row" style={{ flex: 1, justifyContent: "flex-end" }}>
          <input className="search" type="search" value={q} onChange={ev => setQ(ev.target.value)} placeholder="Search ENQ, QT or INV no, workshop, car, part" aria-label="Search enquiries" />
          <select value={cust} onChange={ev => setCust(ev.target.value)} aria-label="Filter by workshop" style={{ maxWidth: 220 }}>
            <option value="">All workshops</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div></div>
      <div className="bd" style={{ paddingBottom: 6 }}><div className="filters">
        {FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>)}</div></div>
      <div className="list">{list.length ? list.map(e => <EnqRow key={e.id} e={e} />) : <div className="empty">No enquiries match.</div>}</div>
    </section>
  );
}
export default function EnquiriesPage() { return <Suspense><List /></Suspense>; }
