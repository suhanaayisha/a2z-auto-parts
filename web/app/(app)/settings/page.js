"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/components/Shell";
import { api, saveFile } from "@/lib/api";
import { recordsCsv } from "@/lib/docs";
import { n, isoDay, fmtDate, TERMS } from "@/lib/calc";

export default function Settings() {
  return (<>
    <CompanyForm />
    <Team />
    <MyAccount />
    <Records />
  </>);
}

function CompanyForm() {
  const { company, setCompany, toast } = useApp();
  const [sp, setSp] = useState(() => (company.salespeople || []).map(p => ({ ...p })));
  const [busy, setBusy] = useState(false);
  async function submit(ev) {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.currentTarget)); setBusy(true);
    try { const r = await api("PUT", "/settings/company", { ...f, salespeople: sp.filter(p => p.name.trim()) }); setCompany(r.company); toast("Settings saved"); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  return (
    <section className="panel"><div className="hd"><h2>Your company</h2><span className="small faint">Printed on every quote, invoice and credit note</span></div>
      <form className="bd" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="fgrid">
          <label className="field"><span>Company name, exactly as on the trade licence</span><input type="text" name="name" defaultValue={company.name} required /></label>
          <label className="field"><span>Trade licence number</span><input type="text" name="licence" defaultValue={company.licence} placeholder="e.g. 1234567" /></label>
          <label className="field"><span>Issued by</span><input type="text" name="authority" defaultValue={company.authority} placeholder="e.g. Dubai DET" list="authList" /></label>
        </div>
        <datalist id="authList">{["Dubai DET", "Abu Dhabi ADDED", "Sharjah SEDD", "Ajman DED", "RAK DED", "Umm Al Quwain DED", "Fujairah DED"].map(a => <option key={a} value={a} />)}</datalist>
        <label className="field"><span>Address</span><input type="text" name="address" defaultValue={company.address} required placeholder="Unit, building, area, emirate" /></label>
        <div className="fgrid">
          <label className="field"><span>Phone</span><input type="text" name="phone" defaultValue={company.phone} /></label>
          <label className="field"><span>Email</span><input type="text" name="email" defaultValue={company.email} /></label>
          <label className="field"><span>Quote valid for (days)</span><input type="number" name="quoteValidDays" defaultValue={n(company.quoteValidDays) || 7} min="1" /></label>
          <label className="field"><span>Default payment terms</span><select name="payDays" defaultValue={n(company.payDays)}>{TERMS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select></label>
        </div>
        <label className="field"><span>Bank details (printed on invoices)</span><input type="text" name="bank" defaultValue={company.bank} placeholder="Bank · Account name · IBAN" /></label>
        <label className="field"><span>Terms (printed on quotes and invoices)</span><textarea name="terms" rows={3} defaultValue={company.terms} /></label>
        <div className="lockline">Not registered for VAT. Documents are titled &quot;Quotation&quot;, &quot;Invoice&quot; and &quot;Credit note&quot;, show no VAT and no TRN of yours, and say &quot;Supplier not registered for VAT&quot;.</div>
        <div><h3 style={{ marginBottom: 8 }}>Salespeople <span className="pill" style={{ background: "var(--internal-soft)", color: "var(--internal)" }}>Internal only</span></h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{sp.map((p, i) => (
            <div className="row" style={{ flexWrap: "nowrap" }} key={i}>
              <input type="text" value={p.name} onChange={ev => setSp(s => s.map((x, k) => (k === i ? { ...x, name: ev.target.value } : x)))} aria-label="Name" style={{ flex: 2 }} />
              <input type="number" value={p.pct} onChange={ev => setSp(s => s.map((x, k) => (k === i ? { ...x, pct: ev.target.value } : x)))} min="0" step="0.5" aria-label="Default commission percent" style={{ flex: 1, maxWidth: 110 }} />
              <span className="small muted">% of sale</span>
              <button className="btn ghost sm" type="button" aria-label="Remove" onClick={() => setSp(s => s.filter((_, k) => k !== i))}>✕</button>
            </div>))}</div>
          <button className="btn sm" type="button" style={{ marginTop: 8 }} onClick={() => setSp(s => s.concat({ name: "", pct: 5 }))}>+ Add salesperson</button></div>
        <label className="field"><span>Our team&apos;s WhatsApp numbers <span className="faint">(one per line)</span></span>
          <textarea name="teamNumbers" rows={3} defaultValue={(company.teamNumbers || []).join("\n")} placeholder={"+971 50 123 4567\n+971 55 765 4321"} />
          <span className="small faint">Messages from these numbers in workshop groups, such as prices your salespeople send, are never read as parts requests. The linked WhatsApp phone is ignored already.</span></label>
        <div className="row"><button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button></div>
      </form>
    </section>
  );
}

function Team() {
  const { me, toast, open, close } = useApp();
  const [users, setUsers] = useState(null);
  const load = () => api("GET", "/team").then(r => setUsers(r.users)).catch(e => toast(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function patch(u, body, msg) {
    try { const r = await api("PATCH", `/team/${u.id}`, body); setUsers(list => list.map(x => (x.id === u.id ? r.user : x))); toast(msg); }
    catch (e) { toast(e.message); }
  }
  async function reset(u) {
    try {
      const r = await api("POST", `/team/${u.id}/reset-password`);
      open(<><div className="dh"><h2>New password for {u.name}</h2></div>
        <div className="db"><p style={{ margin: 0 }}>Give {u.name} this temporary password. They should change it under Settings → My account after signing in.</p>
          <input type="text" readOnly value={r.tempPassword} className="mono" style={{ fontSize: 18 }} onFocus={e => e.target.select()} autoFocus /></div>
        <div className="df"><button className="btn primary" onClick={close}>Done</button></div></>);
    } catch (e) { toast(e.message); }
  }
  const pending = (users || []).filter(u => u.status === "pending");
  return (
    <section className="panel"><div className="hd"><h2>Team</h2><span className="small faint">Everyone on the team has the same access.</span></div>
      {pending.length > 0 && <div className="bd" style={{ background: "var(--warn-soft)", display: "flex", flexDirection: "column", gap: 8 }}>
        <b>Waiting for approval</b>
        {pending.map(u => <div className="row" key={u.id} style={{ justifyContent: "space-between" }}><span>{u.name} · <span className="muted">{u.email}</span></span>
          <span className="row"><button className="btn sm" onClick={() => patch(u, { status: "active" }, `${u.name} approved`)}>Approve</button>
            <button className="btn ghost sm danger" onClick={() => patch(u, { status: "disabled" }, `${u.name} turned down`)}>Turn down</button></span></div>)}
      </div>}
      <div className="tw"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
        {(users || []).filter(u => u.status !== "pending").map(u => (
          <tr key={u.id}><td>{u.name}{u.id === me.id ? " (you)" : ""}</td><td>{u.email}</td>
            <td>{u.status === "active" ? "Active" : "Turned off"}</td><td>{fmtDate(u.createdAt)}</td>
            <td className="r" style={{ whiteSpace: "nowrap" }}>{u.id !== me.id && <>
              <button className="btn ghost sm" onClick={() => reset(u)}>Reset password</button>
              {u.status === "active" ? <button className="btn ghost sm danger" onClick={() => patch(u, { status: "disabled" }, `${u.name} turned off`)}>Turn off</button>
                : <button className="btn ghost sm" onClick={() => patch(u, { status: "active" }, `${u.name} turned on`)}>Turn on</button>}</>}</td></tr>))}
      </tbody></table></div>
      <div className="bd small faint" style={{ borderTop: "1px solid var(--line)" }}>New people sign up at the sign-up page, then appear here for approval.</div>
    </section>
  );
}

function MyAccount() {
  const { me, toast } = useApp();
  async function submit(ev) {
    ev.preventDefault(); const form = ev.currentTarget, f = Object.fromEntries(new FormData(form));
    if (f.next !== f.confirm) { toast("The new passwords don't match"); return; }
    try { await api("POST", "/auth/password", { current: f.current, next: f.next }); toast("Password changed"); form.reset(); }
    catch (e) { toast(e.message); }
  }
  return (
    <section className="panel"><div className="hd"><h2>My account</h2><span className="small faint">{me.name} · {me.email}</span></div>
      <form className="bd fgrid" onSubmit={submit}>
        <label className="field"><span>Current password</span><input type="password" name="current" autoComplete="current-password" required /></label>
        <label className="field"><span>New password</span><input type="password" name="next" autoComplete="new-password" minLength={8} required /></label>
        <label className="field"><span>Repeat new password</span><input type="password" name="confirm" autoComplete="new-password" minLength={8} required /></label>
        <div className="field" style={{ justifyContent: "flex-end" }}><button className="btn" type="submit">Change password</button></div>
      </form>
    </section>
  );
}

function Records() {
  const { invoices, credits, enquiries, customers, load, toast } = useApp();
  const [busy, setBusy] = useState("");
  const samples = enquiries.filter(e => e.sample).length + invoices.filter(x => x.sample).length + customers.filter(c => c.sample).length;
  async function importData(data, label) {
    setBusy("import");
    try { const r = await api("POST", "/import", data); await load(); toast(`${label}: ${Object.entries(r.imported).map(([k, v]) => `${v} ${k}`).join(", ")}`); }
    catch (e) { toast(e.message); } finally { setBusy(""); }
  }
  async function loadSample() {
    const d = await fetch("/sample-data.json").then(r => r.json());
    await importData(d, "Sample data loaded");
  }
  async function fromFile(file) {
    try { await importData(JSON.parse(await file.text()), "Imported"); } catch { toast("That file is not an A2Z Auto Parts backup."); }
  }
  async function clearSample() {
    setBusy("clear");
    try { await api("POST", "/sample/clear"); await load(); toast("Sample data removed"); } catch (e) { toast(e.message); } finally { setBusy(""); }
  }
  return (
    <section className="panel"><div className="hd"><h2>Records and backups</h2></div>
      <div className="bd" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>Keep a copy of every invoice and credit note for at least 7 years (the Corporate Tax record rule). Export the list each month and keep it with the PDFs.</p>
        <div className="row">
          <button className="btn" onClick={() => saveFile(new Blob([recordsCsv(invoices, credits)], { type: "text/csv" }), `invoices-${isoDay(Date.now())}.csv`)}>Export invoices and credit notes (CSV)</button>
          <a className="btn" href="/api/export" download>Download full backup (JSON)</a>
          <label className="btn">Import a backup<input type="file" accept="application/json,.json" hidden onChange={ev => { if (ev.target.files[0]) fromFile(ev.target.files[0]); ev.target.value = ""; }} /></label>
        </div>
        <div className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <span className="small muted">{samples ? `${samples} sample records are loaded. Your own invoices are numbered separately from INV-0001.` : "Load sample workshops, enquiries and invoices to try every step."}</span>
          {samples ? <button className="btn danger" disabled={!!busy} onClick={clearSample}>Remove sample data</button>
            : <button className="btn" disabled={!!busy} onClick={loadSample}>Load sample data</button>}
        </div>
      </div>
    </section>
  );
}
