"use client";
import Link from "next/link";
import { useApp, Pill, SampleChip } from "./Shell";
import { calc, ageOf, deliv, enqNo, money, vehicles, STATUS, live } from "@/lib/calc";

export default function EnqRow({ e }) {
  const { customers, invoices } = useApp();
  const c = calc(e), a = ageOf(e.createdAt), items = (e.items || []).length, d = deliv(e);
  const parts = (e.items || []).map(i => i.part).filter(Boolean).slice(0, 3).join(", ");
  const part = e.status === "confirmed" && live(invoices).some(x => x.enquiryId === e.id);
  const name = customers.find(x => x.id === e.customerId)?.name || "Unknown workshop";
  const waP = e.waPrices && !e.waPrices.applied && !e.waPrices.dismissed;
  const waR = e.waReply && e.status === "quoted";
  return (
    <Link className="li" href={`/enquiries/${e.id}`}>
      <span className="no">{enqNo(e)}</span><span className="who">{name}<SampleChip on={e.sample} />{e.source === "whatsapp" ? <span className="small faint"> · via WhatsApp</span> : null}</span>
      <span className="rt"><Pill s={e.status}>{STATUS[e.status]}</Pill>
        {e.status === "new" ? <span className="age" data-t={a.t}>{a.s}</span> : <span className="amt">{c.total ? money(c.total) : "–"}</span>}</span>
      <span className="what" style={{ gridColumn: "1/3" }}>{vehicles(e) || "Vehicle not set"} · {items} item{items === 1 ? "" : "s"}{parts ? ": " + parts : ""}</span>
      {((d && !d.done) || part || waP || waR) && <span style={{ gridColumn: "1/-1", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {d && !d.done && <span className="dchip" data-t={d.t}>{d.label}</span>}{part && <span className="dchip" data-t="ok">Part invoiced</span>}
        {waP && <span className="dchip" data-t="warn">WhatsApp prices to apply</span>}
        {waR && <span className="dchip" data-t="done">Replied: {e.waReply.text.length > 24 ? e.waReply.text.slice(0, 24) + "…" : e.waReply.text}</span>}</span>}
    </Link>
  );
}
