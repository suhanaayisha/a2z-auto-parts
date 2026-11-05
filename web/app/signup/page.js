"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

export default function Signup() {
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false), [pending, setPending] = useState(false);
  async function submit(ev) {
    ev.preventDefault(); setErr("");
    const f = new FormData(ev.currentTarget);
    if (f.get("password") !== f.get("confirm")) { setErr("The two passwords don't match."); return; }
    setBusy(true);
    try {
      const r = await api("POST", "/auth/signup", { name: f.get("name"), email: f.get("email"), password: f.get("password") });
      if (r.pending) { setPending(true); setBusy(false); } else window.location.href = "/settings";
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  if (pending) return (
    <main className="auth"><form onSubmit={e => e.preventDefault()}>
      <h1>Account created</h1>
      <p className="ok">Someone on the team needs to approve your account before you can sign in. Ask them to open Settings → Team.</p>
      <Link className="btn" href="/login">Back to sign in</Link>
    </form></main>
  );
  return (
    <main className="auth">
      <form onSubmit={submit}>
        <h1>Create an account</h1>
        <p className="muted small">The first account is ready to use straight away. Later accounts need approval from someone already on the team.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <label className="field"><span>Your name</span><input type="text" name="name" autoComplete="name" required autoFocus /></label>
        <label className="field"><span>Email</span><input type="email" name="email" autoComplete="email" required /></label>
        <label className="field"><span>Password (at least 8 characters)</span><input type="password" name="password" autoComplete="new-password" minLength={8} required /></label>
        <label className="field"><span>Repeat password</span><input type="password" name="confirm" autoComplete="new-password" minLength={8} required /></label>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <p className="small muted">Already have an account? <Link href="/login">Sign in</Link></p>
      </form>
    </main>
  );
}
