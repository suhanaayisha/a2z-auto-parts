"use client";
// WhatsApp intake: link the business WhatsApp, and check the requests the reader wasn't sure about.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useApp } from "@/components/Shell";
import { api } from "@/lib/api";
import { fmtDT, enqNo, n } from "@/lib/calc";

const VIEWS = [["review", "To check"], ["waiting", "Being read"], ["created", "Made into enquiries"], ["ignored", "Set aside"]];
const KIND = { enquiry: "Parts request", quote_reply: "Reply to a quote", other: "Not a request" };
const clone = v => JSON.parse(JSON.stringify(v));

export default function WhatsApp() {
  const { load: reloadApp } = useApp();
  const [status, setStatus] = useState(null);
  const [view, setView] = useState("review");
  const [batches, setBatches] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([api("GET", "/wa/status"), api("GET", `/wa/inbox?view=${view}`)]);
      setStatus(s); setBatches(i.batches);
    } catch { /* keep what is shown; the next poll tries again */ }
  }, [view]);
  useEffect(() => {
    setBatches(null); load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 10000);
    return () => clearInterval(t);
  }, [load]);
  const done = () => { load(); reloadApp(); };

  return (<>
    <Connection s={status} />
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="hd"><h2>WhatsApp messages</h2><span className="small faint">Clear requests from known workshops become enquiries by themselves. The rest wait here.</span></div>
      <div className="bd" style={{ paddingBottom: 6 }}><div className="filters">
        {VIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>
          {l}{status?.counts?.[k] ? ` · ${status.counts[k]}` : ""}</button>)}</div></div>
      <div className="wa-list">
        {batches === null ? <div className="empty">Loading…</div>
          : batches.length ? batches.map(b => <Batch key={b.id + b.status} b={b} onDone={done} />)
          : <div className="empty">{view === "review" ? "Nothing to check." : "Nothing here."}</div>}
      </div>
    </section>
  </>);
}

function Connection({ s }) {
  if (!s) return <section className="panel"><div className="bd small faint">Checking the WhatsApp connection…</div></section>;
  if (!s.running) return (
    <section className="panel"><div className="bd">
      <b>The WhatsApp listener isn't running.</b>
      <p className="small muted" style={{ margin: "4px 0 0" }}>Start the <span className="mono">a2z-whatsapp</span> service on Render (see the README). Messages sent while it is off are picked up when it starts, for up to 3 days.</p>
    </div></section>);
  if (s.connection === "open") return (
    <section className="panel"><div className="bd row"><span className="pill" data-s="paid">Connected</span>
      <span>Reading messages for <b>{s.me?.name || ""}</b> <span className="mono faint">+{String(s.me?.id || "").split(/[:@]/)[0]}</span></span></div></section>);
  return (
    <section className="panel"><div className="bd wa-link">
      {s.qr ? <img src={s.qr} alt="QR code to link WhatsApp" width={220} height={220} /> : <div className="wa-qr-wait small faint">Waiting for a code…</div>}
      <div>
        <b>Link the business WhatsApp</b>
        <ol className="small muted">
          <li>On the business phone, open WhatsApp.</li>
          <li>Go to <b>Settings → Linked devices → Link a device</b>.</li>
          <li>Point the phone at this code. It changes every few seconds; that's normal.</li>
        </ol>
        <p className="small faint">The app only reads messages. It never sends anything or marks chats as read.</p>
        {s.error && <p className="small" style={{ color: "var(--warn)" }}>{s.error}</p>}
      </div>
    </div></section>);
}

function Batch({ b, onDone }) {
  const { customers, toast } = useApp();
  const x = b.extraction || {};
  const [customerId, setCustomerId] = useState(b.customerId || "");
  const [items, setItems] = useState(() => clone(x.items || []));
  const [busy, setBusy] = useState("");
  const editable = ["review", "failed", "ignored", "dismissed"].includes(b.status);
  const conf = n(x.confidence);

  const setItem = (i, k, v) => setItems(list => { const next = clone(list); next[i][k] = v; return next; });
  async function act(name, body) {
    setBusy(name);
    try {
      const r = await api("POST", `/wa/batches/${b.id}/${name}`, body);
      if (name === "accept") toast(enqNo(r.enquiry) + " created. Price it under Enquiries.");
      else if (name === "dismiss") toast("Set aside");
      else toast("Reading it again…");
      onDone();
    } catch (err) { toast(err.message); }
    finally { setBusy(""); }
  }
  const accept = () => {
    const list = items.filter(i => String(i.part || "").trim()).map(i => ({ ...i, qty: n(i.qty) || 1 }));
    act("accept", { customerId, items: list });
  };

  return (
    <article className="wa-batch">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><b>{b.chatName || b.chat}</b> <span className="small faint">{b.chat.endsWith("@g.us") ? "group" : "direct"} · {fmtDT(b.lastAt)}</span></div>
        <div className="row">
          {b.status === "failed" && <span className="pill" data-s="new">Couldn't read</span>}
          {x.kind && <span className="pill" data-s={x.kind === "enquiry" ? "quoted" : "lost"}>{KIND[x.kind]}</span>}
          {x.kind === "enquiry" && <span className="pill" data-s={conf >= 0.85 ? "paid" : conf >= 0.6 ? "quoted" : "new"}>{Math.round(conf * 100)}% sure</span>}
          {b.enquiryId && <Link className="btn sm" href={`/enquiries/${b.enquiryId}`}>{b.enqNo ? enqNo(b) : "Open enquiry"} →</Link>}
        </div>
      </div>

      <div className="wa-msgs">
        {b.messages.map(m => (
          <div key={m.id} className="wa-msg">
            <span className="small faint">{m.senderName || m.sender.split("@")[0]} · {fmtDT(m.ts)}</span>
            {m.photoId && <a href={`/api/photos/${m.photoId}`} target="_blank" rel="noreferrer"><img src={`/api/photos/${m.photoId}`} alt="Photo from WhatsApp" /></a>}
            {m.type === "audio" && <>{m.mediaId && <audio controls preload="none" src={`/api/wa/media/${m.mediaId}`} />}
              <div><span className="faint">Voice note: </span>{m.transcript === null ? <i className="faint">not transcribed yet</i> : m.transcript || <i className="faint">no transcription (add OPENAI_API_KEY or DEEPGRAM_API_KEY)</i>}</div></>}
            {m.text && <div className="wa-text">{m.text}</div>}
            {["video", "document"].includes(m.type) && <div className="faint small">A {m.type} was sent; open WhatsApp to see it.</div>}
          </div>))}
      </div>

      {(x.notes || b.error) && <p className="small" style={{ margin: 0, color: "var(--warn)" }}>{b.error ? "Error: " + b.error : x.notes}</p>}

      {editable && x.kind !== "quote_reply" && (<>
        <div className="tw"><table className="wa-items"><thead><tr><th>Vehicle</th><th>Part</th><th style={{ width: 76 }}>Qty</th><th style={{ width: 40 }} /></tr></thead><tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td><input type="text" value={it.vehicle || ""} onChange={e => setItem(i, "vehicle", e.target.value)} placeholder="Make Model Year" aria-label="Vehicle" /></td>
              <td><input type="text" value={it.part || ""} onChange={e => setItem(i, "part", e.target.value)} placeholder="Part" aria-label="Part" /></td>
              <td><input type="number" min="1" value={it.qty || 1} onChange={e => setItem(i, "qty", e.target.value)} style={{ width: 70, minWidth: 0 }} aria-label="Quantity" /></td>
              <td><button className="btn ghost sm" type="button" onClick={() => setItems(l => l.filter((_, j) => j !== i))} aria-label="Remove item">✕</button></td>
            </tr>))}
        </tbody></table></div>
        <div className="row"><button className="btn sm" type="button" onClick={() => setItems(l => l.concat({ vehicle: l.at(-1)?.vehicle || "", part: "", qty: 1 }))}>+ Item</button></div>
        <div className="row wa-actions">
          <select value={customerId} onChange={e => setCustomerId(e.target.value)} aria-label="Workshop" style={{ maxWidth: 260 }}>
            <option value="">Choose the workshop…</option>{customers.slice().sort((a, z) => a.name.localeCompare(z.name)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn primary" type="button" disabled={!!busy || !customerId} onClick={accept}>{busy === "accept" ? "Creating…" : "Create enquiry"}</button>
          {b.status !== "dismissed" && <button className="btn" type="button" disabled={!!busy} onClick={() => act("dismiss")}>Set aside</button>}
          <button className="btn ghost" type="button" disabled={!!busy} onClick={() => act("retry")}>Read again</button>
        </div>
        {!b.customerId && <p className="small faint" style={{ margin: 0 }}>This chat isn't linked to a workshop yet. Once you pick one, its next messages are matched automatically.</p>}
      </>)}
      {editable && x.kind === "quote_reply" && <div className="row wa-actions">
        <span className="small muted">Looks like a reply to a quote. Open the enquiry and confirm the chosen options there.</span>
        <button className="btn ghost sm" type="button" onClick={() => act("retry")}>Read again</button></div>}
    </article>
  );
}
