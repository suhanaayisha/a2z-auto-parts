"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

export default function Login() {
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  async function submit(ev) {
    ev.preventDefault(); setErr(""); setBusy(true);
    const f = new FormData(ev.currentTarget);
    try { await api("POST", "/auth/login", { email: f.get("email"), password: f.get("password") }); window.location.href = "/"; }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <main className="auth">
      <form onSubmit={submit}>
        <h1>A2Z Auto Parts</h1>
        <p className="muted small">Sign in to your account.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <label className="field"><span>Email</span><input type="email" name="email" autoComplete="email" required autoFocus /></label>
        <label className="field"><span>Password</span><input type="password" name="password" autoComplete="current-password" required /></label>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="small muted">New here? <Link href="/signup">Create an account</Link></p>
      </form>
    </main>
  );
}
