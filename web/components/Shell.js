"use client";
// App frame: loads the data, keeps it fresh, and provides dialogs and messages to every screen.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

const TABS = [["/", "Dashboard"], ["/enquiries", "Enquiries"], ["/documents", "Quotes & invoices"], ["/customers", "Customers"], ["/settings", "Settings"]];

export default function Shell({ children }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [msg, setMsg] = useState("");
  const path = usePathname();
  const timer = useRef(null);

  const load = useCallback(async () => {
    try { const d = await api("GET", "/bootstrap"); setData(d); setError(""); }
    catch (e) { if (e.status !== 401) setError(e.message); }
  }, []);
  useEffect(() => {
    load();
    const tick = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30000);
    window.addEventListener("focus", load);
    return () => { clearInterval(tick); window.removeEventListener("focus", load); };
  }, [load]);

  const upsert = useCallback((coll, rec) => setData(d => {
    if (!d || !rec) return d;
    const list = d[coll] || [], i = list.findIndex(x => x.id === rec.id);
    return { ...d, [coll]: i >= 0 ? list.map(x => (x.id === rec.id ? rec : x)) : list.concat(rec) };
  }), []);
  const remove = useCallback((coll, id) => setData(d => (d ? { ...d, [coll]: d[coll].filter(x => x.id !== id) } : d)), []);
  const setCompany = useCallback(company => setData(d => (d ? { ...d, company } : d)), []);
  const toast = useCallback(m => { setMsg(m); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(""), 2800); }, []);
  const open = useCallback(node => setDialog(node), []);
  const close = useCallback(() => setDialog(null), []);

  if (!data) return <div className="loading">{error ? <>{error} <button className="btn sm" onClick={load}>Try again</button></> : "Loading your records…"}</div>;

  const pending = data.enquiries.filter(e => e.status === "new").length;
  const active = href => (href === "/" ? path === "/" : path.startsWith(href));
  async function signOut() { await api("POST", "/auth/logout").catch(() => {}); window.location.href = "/login"; }

  return (
    <Ctx.Provider value={{ ...data, load, upsert, remove, setCompany, toast, open, close }}>
      <header className="top">
        <div className="bar">
          <div className="brand"><b>A2Z Auto Parts</b><span>{data.company.name ? "· " + data.company.name : ""}</span></div>
          <div className="sp" />
          <div className="userchip"><span className="nm"><b>{data.me.name}</b></span>
            <button className="btn ghost sm" type="button" onClick={signOut}>Sign out</button></div>
          <Link className="btn primary" href="/enquiries/new">+ New enquiry</Link>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map(([href, label]) => (
            <Link key={href} href={href} aria-current={active(href) ? "page" : undefined}>
              {label}{href === "/enquiries" && pending ? <span className="count">{pending}</span> : null}
            </Link>
          ))}
        </nav>
      </header>
      <main>
        {error && <div className="banner">{error}</div>}
        {data.enquiries.some(e => e.sample) && !path.startsWith("/settings") &&
          <div className="banner" data-tone="info">Sample workshops, enquiries and invoices are loaded so you can try every step. Remove them in <Link href="/settings">Settings</Link>.</div>}
        {children}
      </main>
      <Dialog node={dialog} onClose={close} />
      {msg && <div className="toast" role="status">{msg}</div>}
    </Ctx.Provider>
  );
}

function Dialog({ node, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (node && !d.open) d.showModal();
    if (!node && d.open) d.close();
  }, [node]);
  const wide = node?.props?.wide;
  return <dialog ref={ref} className={wide ? "doc" : ""} onClose={onClose} onCancel={e => { e.preventDefault(); onClose(); }}>{node}</dialog>;
}

export function Pill({ s, children }) { return <span className="pill" data-s={s}>{children}</span>; }
export function SampleChip({ on }) { return on ? <> <span className="chip-sample">sample</span></> : null; }
