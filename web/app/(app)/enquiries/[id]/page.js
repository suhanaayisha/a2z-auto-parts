"use client";
import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useApp, Pill, SampleChip } from "@/components/Shell";
import { DocView } from "@/components/Docs";
import { InvoiceDialog } from "@/components/Dialogs";
import { api, shrinkImage } from "@/lib/api";
import { quoteText } from "@/lib/docs";
import {
  n, money, aed, fmtDate, fmtDT, DAY, QUAL, LET, STATUS, leadText, newItem, newOpt, optOf, isPriced, multi, calc, deliv,
  enqNo, qtNo, invNo, invQty, canInvoice, live, invState,
} from "@/lib/calc";

const clone = v => JSON.parse(JSON.stringify(v));

function Editor() {
  const app = useApp();
  const { enquiries, customers, invoices, company, config, toast, open, close } = app;
  const { id } = useParams();
  const router = useRouter();
  const params = useSearchParams();
  const isNew = id === "new";
  const stored = enquiries.find(e => e.id === id);
  const [draft, setDraft] = useState(() => isNew
    ? { customerId: params.get("c") || "", sender: "", message: "", items: [newItem()], extraDisc: 0, salesperson: "", commAmt: 0, photos: [], notes: "", status: "new", createdAt: new Date().toISOString() }
    : stored ? clone(stored) : null);
  const [dirty, setDirty] = useState(isNew);
  const [busy, setBusy] = useState("");
  const [aiNote, setAiNote] = useState("");

  useEffect(() => { if (!isNew && stored && !dirty) setDraft(clone(stored)); }, [stored, dirty, isNew]);
  useEffect(() => {
    const h = ev => { if (dirty) { ev.preventDefault(); ev.returnValue = ""; } };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (!draft) return <div className="empty panel">This enquiry could not be found. <Link href="/enquiries">Back to enquiries</Link></div>;
  const e = draft;
  const myInv = invoices.filter(x => x.enquiryId === e.id).sort((a, b) => a.invNo - b.invNo);
  const hasLive = live(myInv).length > 0;
  const L = ["invoiced", "paid"].includes(e.status);
  const c = calc(e), d = deliv(e), st = e.status;
  const cust = customers.find(x => x.id === e.customerId);
  const vehs = [...new Set(enquiries.flatMap(x => (x.items || []).map(i => i.vehicle)).filter(Boolean))];

  const change = fn => { setDraft(prev => { const next = clone(prev); fn(next); return next; }); setDirty(true); };
  const setTop = (k, v) => change(x => { x[k] = v; });
  const setItem = (i, k, v) => change(x => { x.items[i][k] = v; });
  const setOpt = (i, j, k, v) => change(x => { x.items[i].options[j][k] = v; });

  async function save(silent) {
    if (!e.customerId) { toast("Choose the workshop first"); return null; }
    setBusy("save");
    try {
      const body = { ...e, items: e.items.filter(i => i.vehicle || i.part || (i.options || []).some(o => n(o.sell))) };
      const r = isNew ? await api("POST", "/enquiries", body) : await api("PUT", `/enquiries/${e.id}`, body);
      app.upsert("enquiries", r.enquiry); setDraft(clone(r.enquiry)); setDirty(false);
      if (!silent) toast(enqNo(r.enquiry) + " saved");
      if (isNew) router.replace(`/enquiries/${r.enquiry.id}`);
      return r.enquiry;
    } catch (err) { toast(err.message); return null; }
    finally { setBusy(""); }
  }
  const saved = async () => (dirty || isNew ? await save(true) : e);
  async function action(name, after) {
    const cur = await saved(); if (!cur) return;
    setBusy(name);
    try {
      const r = await api("POST", `/enquiries/${cur.id}/${name}`);
      app.upsert("enquiries", r.enquiry); setDraft(clone(r.enquiry)); setDirty(false); after?.(r.enquiry);
    } catch (err) { toast(err.message); }
    finally { setBusy(""); }
  }
  const showQuote = enq => open(<DocView kind="quote" enquiry={enq} wide />);

  function confirmDialog(title, body, label, onYes, danger) {
    open(<>
      <div className="dh"><h2>{title}</h2></div><div className="db">{body}</div>
      <div className="df"><button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" style={danger ? { background: "var(--crit)", borderColor: "var(--crit)" } : undefined} onClick={() => { close(); onYes(); }}>{label}</button></div>
    </>);
  }
  const choices = (
    <div className="tw"><table><tbody>{e.items.map((it, i) => {
      const o = optOf(it), j = (it.options || []).indexOf(o);
      return <tr key={it.k}><td className="mono">{i + 1}{o && it.options.length > 1 ? LET[j] : ""}</td><td>{it.part} <span className="faint">{it.vehicle}</span></td>
        <td>{o ? <span className="q" data-q={o.quality}>{QUAL[o.quality]}</span> : <span className="faint">Not required</span>}</td><td>{o ? leadText(o.lead) : ""}</td>
        <td className="r num">{o ? money(n(it.qty) * n(o.sell) - n(o.disc)) : ""}</td></tr>;
    })}</tbody></table></div>
  );

  async function uploadPhotos(files) {
    for (const f of files) {
      try { const blob = await shrinkImage(f); const r = await api("POST", "/photos", blob); change(x => { x.photos = (x.photos || []).concat(r.id); }); }
      catch (err) { toast(err.message || "Photo could not be uploaded"); }
    }
  }
  async function aiRead() {
    if (!e.message.trim()) { toast("Paste the WhatsApp message first"); return; }
    setAiNote("Reading…");
    try {
      const r = await api("POST", "/ai/read", { message: e.message });
      const got = (r.items || []).map(i => { const it = newItem(String(i.vehicle || "")); it.part = String(i.part); it.qty = n(i.qty) || 1; if (QUAL[i.quality]) it.options[0].quality = i.quality; return it; });
      if (!got.length) { setAiNote("No parts found in that message."); return; }
      change(x => { x.items = x.items.filter(i => i.part || i.vehicle || (i.options || []).some(o => n(o.sell))).concat(got); });
      setAiNote(`Added ${got.length} item${got.length === 1 ? "" : "s"}. Check them before pricing.`);
    } catch (err) { setAiNote(err.message); }
  }
  async function copyWA() {
    const cur = await saved(); if (!cur) return;
    const text = cur.quoteNo ? quoteText(cur, company) : `✅ ${enqNo(cur)} received – ${(cur.items || []).length} item(s). We'll send prices shortly.`;
    try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into the WhatsApp group"); } catch { toast("Copying isn't allowed here. Open the quote and select the text."); }
  }
  async function deliverAll() {
    const now = new Date().toISOString();
    const next = clone(e); next.items.forEach(i => { if (optOf(i) && !i.delivered) { i.delivered = true; i.deliveredDate = now; } });
    setBusy("save");
    try { const r = await api("PUT", `/enquiries/${e.id}`, next); app.upsert("enquiries", r.enquiry); setDraft(clone(r.enquiry)); setDirty(false); toast(enqNo(r.enquiry) + " delivered"); }
    catch (err) { toast(err.message); } finally { setBusy(""); }
  }
  async function waPrices(name) {
    if (dirty) { toast("Save your changes first"); return; }
    setBusy("wa-" + name);
    try {
      const r = await api("POST", `/wa/enquiries/${e.id}/prices/${name}`);
      app.upsert("enquiries", r.enquiry); setDraft(clone(r.enquiry)); setDirty(false);
      toast(name === "apply" ? (r.enquiry.quoteNo && r.enquiry.status === "quoted" ? "Prices applied. " + qtNo(r.enquiry) + " is ready." : "Prices applied") : "WhatsApp prices dismissed");
    } catch (err) { toast(err.message); } finally { setBusy(""); }
  }
  async function del() {
    if (isNew) { router.push("/enquiries"); return; }
    try { await api("DELETE", `/enquiries/${e.id}`); app.remove("enquiries", e.id); setDirty(false); router.push("/enquiries"); }
    catch (err) { toast(err.message); }
  }

  const refs = [
    e.quoteNo && <span key="q">Quote <b>{qtNo(e)}</b> {fmtDate(e.quoteDate)}</span>,
    e.confirmDate && <span key="c">Confirmed {fmtDate(e.confirmDate)}</span>,
    ...myInv.map(x => <button key={x.id} className="btn sm ghost" type="button" onClick={() => open(<DocView kind="invoice" id={x.id} wide />)}><b>{invNo(x)}</b>&nbsp;<Pill s={invState(x).t}>{invState(x).l}</Pill></button>),
  ].filter(Boolean);

  return (<>
    <datalist id="vehList">{vehs.map(v => <option key={v} value={v} />)}</datalist>
    <div className="row"><Link className="btn ghost sm" href="/enquiries">← Enquiries</Link>{dirty && !isNew && <span className="small" style={{ color: "var(--warn)" }}>Unsaved changes</span>}</div>
    <section className="panel">
      <div className="hd">
        <div className="ed-head"><span className="no">{enqNo(e)}</span><Pill s={st}>{STATUS[st]}</Pill>{d && <span className="dchip" data-t={d.t}>{d.label}</span>}<SampleChip on={e.sample} />
          <span className="small faint">Received {fmtDT(e.createdAt)}</span></div>
        {refs.length > 0 && <div className="docs-refs">{refs}</div>}
      </div>
      <div className="bd" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {L ? <div className="lockline">Fully invoiced, so prices are locked. Delivery can still be updated. To change an invoice, open it and cancel it with a credit note.</div>
          : hasLive ? <div className="lockline">Part invoiced. Invoiced items are locked; the rest can still be changed and invoiced later.</div> : null}
        {e.waReply && ["new", "quoted"].includes(st) && <div className="banner" data-tone="info">
          <b>{e.waReply.by || "The workshop"} replied on WhatsApp</b> ({fmtDT(e.waReply.at)}): &ldquo;{e.waReply.text}&rdquo;
          {st === "quoted" && <> · If they accepted, tick the options they chose and press Workshop confirmed.</>}</div>}
        {e.waPrices && !e.waPrices.applied && !e.waPrices.dismissed && !isNew && <WaPrices e={e} busy={busy} onAct={waPrices} />}
        <div className="fgrid">
          <label className="field"><span>Workshop</span>
            <select value={e.customerId} onChange={ev => setTop("customerId", ev.target.value)} disabled={L || hasLive}>
              <option value="">Choose workshop…</option>{customers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label className="field"><span>Sent by (in the group)</span><input type="text" value={e.sender || ""} onChange={ev => setTop("sender", ev.target.value)} placeholder="e.g. Imran" readOnly={L} /></label>
          <div className="field"><span>WhatsApp group</span><input type="text" value={cust?.groups || ""} readOnly tabIndex={-1} /></div>
        </div>
        {!customers.length && <div className="banner">Add a workshop first under <Link href="/customers">Customers</Link>.</div>}
        <label className="field"><span>Original message</span><textarea rows={3} value={e.message || ""} onChange={ev => setTop("message", ev.target.value)} placeholder="Paste the WhatsApp message here" readOnly={L} /></label>
        {config.ai && !L && <div className="row"><button className="btn sm" type="button" onClick={aiRead}>Read message into items</button><span className="small faint">{aiNote || "Turns the message into line items. Check them before pricing."}</span></div>}
        <div className="field"><span>Photos from the group</span><div className="photos">
          {(e.photos || []).map(p => <a key={p} href={`/api/photos/${p}`} target="_blank" rel="noreferrer"><img src={`/api/photos/${p}`} alt="Part photo" /></a>)}
          {!L ? <label className="btn sm" style={{ height: 84, width: 84, flexDirection: "column", fontSize: 12 }}>+ Photo<input type="file" accept="image/*" multiple hidden onChange={ev => { uploadPhotos([...ev.target.files]); ev.target.value = ""; }} /></label>
            : !(e.photos || []).length && <span className="small faint">No photos attached.</span>}
        </div></div>
        <div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}><h3>Items</h3><span className="small faint">Add options to quote used, aftermarket and original side by side. Cost and margin are never printed.</span></div>
          {st === "quoted" && multi(e) && <div className="lockline" style={{ marginBottom: 10 }}>When the workshop replies (e.g. &quot;1A 2B&quot;), tick the option they chose on each item, or &quot;Not required&quot;, then press Workshop confirmed or Create invoice.</div>}
          <div className="items">{e.items.map((it, i) => <ItemCard key={it.k} it={it} i={i} e={e} locked={L || invQty(invoices, e, it, i) > 0} iq={invQty(invoices, e, it, i)}
            setItem={setItem} setOpt={setOpt} change={change} />)}</div>
          {!L && <button className="btn sm" type="button" style={{ marginTop: 10 }} onClick={() => change(x => { x.items.push(newItem(x.items[x.items.length - 1]?.vehicle)); })}>+ Add item</button>}
        </div>
        <div className="totals">
          <div className="tbox"><span className="label">Customer sees{multi(e) ? " · selected options" : ""}</span>
            <div className="tl"><span>Subtotal</span><span className="num">{money(c.gross)}</span></div>
            <div className="tl"><span>Line discounts</span><span className="num">{c.lineDisc ? "−" + money(c.lineDisc) : "0.00"}</span></div>
            <div className="tl"><label htmlFor="fExtra">Additional discount</label><input id="fExtra" type="number" value={n(e.extraDisc) || ""} onChange={ev => setTop("extraDisc", ev.target.value)} min="0" step="0.01" placeholder="0.00" readOnly={L} /></div>
            <div className="tl big"><span>Total AED</span><span className="num">{money(c.total)}</span></div>
            <span className="small faint">No VAT charged: not registered for VAT.</span>
          </div>
          <div className="tbox internal"><span className="label" style={{ color: "var(--internal)" }}>Internal only</span>
            <div className="tl"><span>Total cost</span><span className="num">{money(c.cost)}</span></div>
            <div className="tl"><label htmlFor="fSp">Salesperson</label><select id="fSp" value={e.salesperson || ""} onChange={ev => setTop("salesperson", ev.target.value)} disabled={L}><option value="">None</option>{(company.salespeople || []).map(p => <option key={p.name}>{p.name}</option>)}</select></div>
            <div className="tl"><label htmlFor="fComm">Commission</label><span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
              {!L && <button className="btn ghost sm" type="button" title="Apply the salesperson's default rate" onClick={() => { const p = (company.salespeople || []).find(x => x.name === e.salesperson); if (!p) { toast("Choose a salesperson first"); return; } setTop("commAmt", Math.round(c.total * n(p.pct)) / 100); }}>%</button>}
              <input id="fComm" type="number" value={n(e.commAmt) || ""} onChange={ev => setTop("commAmt", ev.target.value)} min="0" step="0.01" placeholder="0.00" readOnly={L} /></span></div>
            <div className="tl big"><span>Profit</span><span className={"num" + (c.profit < 0 ? " neg" : "")}>{money(c.profit)}</span></div>
            <div className="tl small"><span>Margin</span><span className="num">{(c.margin * 100).toFixed(1)}%</span></div>
            <span className="small faint">Planned commission. The amount is confirmed on each invoice.</span>
          </div>
        </div>
        <label className="field"><span>Notes (internal)</span><textarea rows={2} value={e.notes || ""} onChange={ev => setTop("notes", ev.target.value)} placeholder="Supplier, yard location, condition…" /></label>
      </div>
      <div className="actions">
        <button className={"btn" + (dirty ? " primary" : "")} type="button" onClick={() => save()} disabled={busy === "save"}>{busy === "save" ? "Saving…" : dirty ? "Save changes" : "Saved"}</button>
        {!isNew && <button className="btn sm ghost" type="button" onClick={copyWA}>Copy for WhatsApp</button>}
        <span className="sp" />
        {d && !d.done && <button className="btn" type="button" onClick={deliverAll}>Mark all delivered</button>}
        {st === "new" && <button className="btn primary" type="button" disabled={!!busy} onClick={() => { if (!isPriced(e)) { toast("Add a unit price to every option first"); return; } action("quote", showQuote); }}>Create quote</button>}
        {e.quoteNo && st !== "lost" && <button className="btn" type="button" onClick={async () => { const cur = await saved(); if (cur) showQuote(cur); }}>View quote</button>}
        {st === "quoted" && <>
          <button className="btn" type="button" onClick={() => { if (!isPriced(e)) { toast("Add a unit price to every option first"); return; } confirmDialog("Send a revised quote?", <p style={{ margin: 0 }}>This issues <b className="mono">{qtNo({ ...e, quoteRev: n(e.quoteRev || 1) + 1 })}</b> with today&apos;s date and the current items and prices.</p>, "Issue revision", () => action("revise", showQuote)); }}>Revise quote</button>
          <button className="btn" type="button" onClick={() => {
            const d0 = Math.max(0, ...e.items.filter(i => optOf(i)).map(i => n(optOf(i).lead)));
            confirmDialog(`Confirm order ${enqNo(e)}`, <><p style={{ margin: 0 }}>The workshop takes these options. Check they match their reply.</p>{choices}
              <p style={{ margin: 0 }}><b>{aed(c.total)}</b> · delivery due <b>{d0 ? fmtDate(Date.now() + d0 * DAY) : "today (all in stock)"}</b></p></>, "Confirm order", () => action("confirm", () => toast(enqNo(e) + " confirmed")));
          }}>Workshop confirmed</button>
        </>}
        {canInvoice(invoices, e) && <button className="btn primary" type="button" onClick={async () => { const cur = await saved(); if (cur) open(<InvoiceDialog enquiry={cur} wide onDone={enq => { setDraft(clone(enq)); setDirty(false); }} />); }}>Create invoice</button>}
        {st === "quoted" && !hasLive && <button className="btn ghost danger" type="button" onClick={() => action("lost", () => toast(enqNo(e) + " marked lost"))}>Mark lost</button>}
        {st === "lost" && <button className="btn" type="button" onClick={() => action("reopen")}>Reopen</button>}
        {!e.quoteNo && <button className="btn ghost danger sm" type="button" onClick={() => isNew ? del() : confirmDialog(`Delete ${enqNo(e)}?`, <p style={{ margin: 0 }}>This enquiry has no quote yet. Deleting it cannot be undone.</p>, "Delete", del, true)}>{isNew ? "Discard" : "Delete"}</button>}
      </div>
    </section>
  </>);
}

const MATCH = {
  reply: "a reply to this request",
  reply_to_prices: "a reply to earlier prices for this request",
  only_open: "the only open enquiry in that group, so check it's the right one",
  manual: "picked by hand in the WhatsApp tab",
};
// Prices the team sent in WhatsApp, waiting to be applied.
function WaPrices({ e, busy, onAct }) {
  const w = e.waPrices;
  const byKey = new Map((e.items || []).map(it => [it.k, it]));
  return (
    <div className="wa-prices">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><b>Prices from WhatsApp</b> <span className="small faint">sent by {w.by}, {fmtDT(w.at)} · {MATCH[w.match] || ""}</span></div>
      </div>
      <div className="tw"><table><thead><tr><th>Item</th><th className="r">Now</th><th className="r">From WhatsApp</th><th>Note</th></tr></thead><tbody>
        {w.lines.map(l => {
          const it = byKey.get(l.k), o = it ? optOf(it) || (it.options || [])[0] : null;
          return <tr key={l.k}><td>{l.part} <span className="faint">{l.vehicle}</span></td>
            <td className="r num">{o && n(o.sell) ? money(o.sell) : <span className="faint">–</span>}</td>
            <td className="r num"><b>{l.price ? money(l.price) : <span className="faint">–</span>}</b></td>
            <td>{l.note ? <span className="dchip" data-t="warn">{l.note}</span> : ""}</td></tr>;
        })}
      </tbody></table></div>
      {w.extra?.length > 0 && <p className="small faint" style={{ margin: 0 }}>Not matched to an item: {w.extra.join(" · ")}</p>}
      <details className="small"><summary className="faint">Their message</summary><div className="wa-text" style={{ marginTop: 6 }}>{w.text}</div></details>
      <div className="row">
        <button className="btn primary" type="button" disabled={!!busy} onClick={() => onAct("apply")}>{busy === "wa-apply" ? "Applying…" : "Apply prices"}</button>
        <button className="btn" type="button" disabled={!!busy} onClick={() => onAct("dismiss")}>Dismiss</button>
        <span className="small faint">Fills in the selling prices{(e.items || []).every(it => w.lines.some(l => l.k === it.k && l.price) || (it.options || []).some(o => n(o.sell))) ? " and creates the quote, since every item will have a price" : ""}. Cost prices stay for you to add.</span>
      </div>
    </div>
  );
}

function ItemCard({ it, i, e, locked, iq, setItem, setOpt, change }) {
  const q = n(it.qty), afterConf = ["confirmed", "invoiced", "paid"].includes(e.status), o = optOf(it);
  const sel = j => it.chosen !== -1 && (n(it.chosen) === j || (!(n(it.chosen) > 0) && j === 0));
  const choose = v => change(x => { x.items[i].chosen = v; });
  return (
    <div className="icard" data-skip={it.chosen === -1 ? 1 : 0}>
      <div className="ihead">
        <span className="ix">{i + 1}</span>
        <label className="field f-veh"><span>Vehicle</span><input type="text" value={it.vehicle} onChange={ev => setItem(i, "vehicle", ev.target.value)} placeholder="Make model year" readOnly={locked} list="vehList" /></label>
        <label className="field f-part"><span>Part</span><input type="text" value={it.part} onChange={ev => setItem(i, "part", ev.target.value)} placeholder="e.g. Headlamp RH" readOnly={locked} /></label>
        <label className="field f-qty"><span>Qty</span><input type="number" value={it.qty} onChange={ev => setItem(i, "qty", ev.target.value)} min="1" step="1" readOnly={locked} aria-label="Quantity" /></label>
        <div className="del">{!locked && <button className="btn ghost sm" type="button" aria-label={`Remove item ${i + 1}`} onClick={() => change(x => { x.items.splice(i, 1); })}>✕</button>}</div>
      </div>
      <div className="ohd"><span>Opt.</span><span>Quality</span><span>Lead (days)</span><span className="r priced-internal">Unit cost</span><span className="r">Unit price</span><span className="r">Discount</span><span className="r">Line total</span><span /></div>
      {(it.options || []).map((op, j) => {
        const lt = q * n(op.sell) - n(op.disc), lc = q * n(op.cost);
        return (
          <div className="opt" key={op.k || j} data-sel={sel(j) && it.options.length > 1 ? 1 : 0}>
            <label className="pick" title="The option the workshop takes"><input type="radio" name={`ch${i}`} checked={sel(j)} onChange={() => choose(j)} disabled={locked} aria-label={`Choose option ${LET[j]}`} />{i + 1}{LET[j]}</label>
            <label className="field f-q"><span>Quality</span><select value={op.quality} onChange={ev => setOpt(i, j, "quality", ev.target.value)} disabled={locked}>{Object.entries(QUAL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field f-lead"><span>Lead (days)</span><input type="number" value={n(op.lead)} onChange={ev => setOpt(i, j, "lead", ev.target.value)} min="0" step="1" readOnly={locked} title="0 = in stock" /></label>
            <label className="field f-cost"><span className="priced-internal">Unit cost</span><input type="number" value={n(op.cost) || ""} onChange={ev => setOpt(i, j, "cost", ev.target.value)} min="0" step="0.01" placeholder="0.00" readOnly={locked} /></label>
            <label className="field f-sell"><span>Unit price</span><input type="number" value={n(op.sell) || ""} onChange={ev => setOpt(i, j, "sell", ev.target.value)} min="0" step="0.01" placeholder="0.00" readOnly={locked} /></label>
            <label className="field f-disc"><span>Discount</span><input type="number" value={n(op.disc) || ""} onChange={ev => setOpt(i, j, "disc", ev.target.value)} min="0" step="0.01" placeholder="0.00" readOnly={locked} /></label>
            <div className="lt"><span>{money(lt)}</span><small className="priced-internal">{lt ? "margin " + money(lt - lc) : ""}</small></div>
            <div className="odel">{!locked && it.options.length > 1 && <button className="btn ghost sm" type="button" aria-label={`Remove option ${LET[j]}`} onClick={() => change(x => { const t = x.items[i]; t.options.splice(j, 1); const c = n(t.chosen); if (c === j) t.chosen = 0; else if (c > j) t.chosen = c - 1; })}>✕</button>}</div>
          </div>
        );
      })}
      <div className="ifoot">
        {!locked && <button className="btn sm" type="button" onClick={() => change(x => { const t = x.items[i]; if (t.options.length >= LET.length) return; const used = t.options.map(p => p.quality); t.options.push(newOpt(["used", "aftermarket", "original"].find(v => !used.includes(v)) || "used")); })}>+ Add option</button>}
        {((!locked && (it.options || []).length > 1) || it.chosen === -1) && <label><input type="radio" name={`ch${i}`} checked={it.chosen === -1} onChange={() => choose(-1)} disabled={locked} /> Not required</label>}
        {iq > 0 && <span className="dchip" data-t={iq >= q ? "done" : "ok"}>Invoiced {iq} of {q}</span>}
        <span className="sp" />
        {afterConf && o && <><label><input type="checkbox" checked={!!it.delivered} onChange={ev => change(x => { x.items[i].delivered = ev.target.checked; x.items[i].deliveredDate = ev.target.checked ? new Date().toISOString() : null; })} /> Delivered{it.delivered && it.deliveredDate ? " " + fmtDate(it.deliveredDate) : ""}</label>
          {!it.delivered && <span className="faint">{leadText(o.lead)}</span>}</>}
      </div>
    </div>
  );
}

export default function EnquiryPage() { return <Suspense><Editor /></Suspense>; }
