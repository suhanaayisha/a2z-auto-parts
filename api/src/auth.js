// Accounts and sessions.
// - Every active user has the same access. There are no roles.
// - The first account is active straight away. Later sign-ups wait as "pending" until any active user approves them.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { col, out } from "./db.js";

const SECRET = process.env.SESSION_SECRET || "";
if (SECRET.length < 32) {
  console.error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  if (process.env.NODE_ENV === "production") process.exit(1);
}
const KEY = SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "pd_session";
const MAX_AGE_DAYS = 30;
const SECURE = process.env.NODE_ENV === "production";

const b64 = s => Buffer.from(s).toString("base64url");
const sign = v => crypto.createHmac("sha256", KEY).update(v).digest("base64url");
function makeToken(user) {
  const body = b64(JSON.stringify({ u: user._id, v: user.tokenVersion || 0, e: Date.now() + MAX_AGE_DAYS * 864e5 }));
  return body + "." + sign(body);
}
function readToken(t) {
  const [body, sig] = String(t || "").split(".");
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.e > Date.now() ? p : null; } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean)
    .map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}
function setSession(res, user) {
  res.append("Set-Cookie", `${COOKIE}=${makeToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_DAYS * 86400}${SECURE ? "; Secure" : ""}`);
}
function clearSession(res) { res.append("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE ? "; Secure" : ""}`); }

export const publicUser = u => ({ id: u._id, name: u.name, email: u.email, status: u.status, createdAt: u.createdAt });

export async function loadUser(req, res, next) {
  const p = readToken(cookies(req)[COOKIE]);
  if (p) {
    const u = await col.users.findOne({ _id: p.u });
    if (u && u.status === "active" && (u.tokenVersion || 0) === p.v) req.user = u;
  }
  next();
}
export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}

const cleanEmail = e => String(e || "").trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const uid = () => "u" + crypto.randomBytes(8).toString("hex");
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(9).toString("hex"), 11);

export const authRoutes = Router();
// Limit by email and address together: requests reach the API through the web app's proxy.
const limiter = rateLimit({
  windowMs: 15 * 60e3, limit: 15, standardHeaders: "draft-8", legacyHeaders: false,
  keyGenerator: req => cleanEmail(req.body?.email) + "|" + ipKeyGenerator(req.ip || ""),
  message: { error: "Too many attempts. Wait 15 minutes and try again." },
});

authRoutes.post("/signup", limiter, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80), email = cleanEmail(req.body?.email), password = String(req.body?.password || "");
  if (!name) return res.status(400).json({ error: "Enter your name." });
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Use a password of at least 8 characters." });
  const first = (await col.users.countDocuments({})) === 0;
  const user = { _id: uid(), name, email, hash: await bcrypt.hash(password, 11), status: first ? "active" : "pending", tokenVersion: 0, createdAt: new Date().toISOString() };
  try { await col.users.insertOne(user); }
  catch (err) { if (err.code === 11000) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." }); throw err; }
  if (first) { setSession(res, user); return res.status(201).json({ user: publicUser(user) }); }
  res.status(201).json({ pending: true });
});

authRoutes.post("/login", limiter, async (req, res) => {
  const email = cleanEmail(req.body?.email), password = String(req.body?.password || "");
  const u = await col.users.findOne({ email });
  const ok = await bcrypt.compare(password, u ? u.hash : DUMMY_HASH); // same work either way, so timing doesn't reveal accounts
  if (!u || !ok) return res.status(401).json({ error: "Email or password is not right." });
  if (u.status === "pending") return res.status(403).json({ error: "Your account is waiting to be approved. Ask someone on the team to approve it in Settings → Team." });
  if (u.status !== "active") return res.status(403).json({ error: "This account has been turned off. Ask someone on the team to turn it back on." });
  setSession(res, u);
  res.json({ user: publicUser(u) });
});

authRoutes.post("/logout", (req, res) => { clearSession(res); res.json({ ok: true }); });

authRoutes.get("/me", requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

authRoutes.post("/password", requireUser, async (req, res) => {
  const current = String(req.body?.current || ""), next = String(req.body?.next || "");
  if (!(await bcrypt.compare(current, req.user.hash))) return res.status(400).json({ error: "Your current password is not right." });
  if (next.length < 8) return res.status(400).json({ error: "Use a new password of at least 8 characters." });
  const v = (req.user.tokenVersion || 0) + 1;
  await col.users.updateOne({ _id: req.user._id }, { $set: { hash: await bcrypt.hash(next, 11), tokenVersion: v } });
  setSession(res, Object.assign({}, req.user, { tokenVersion: v }));
  res.json({ ok: true });
});

// ---------- team (any signed-in user) ----------
export const teamRoutes = Router();
teamRoutes.use(requireUser);

teamRoutes.get("/", async (req, res) => {
  const users = await col.users.find({}).sort({ createdAt: 1 }).toArray();
  res.json({ users: users.map(publicUser) });
});

teamRoutes.patch("/:id", async (req, res) => {
  const u = await col.users.findOne({ _id: req.params.id });
  if (!u) return res.status(404).json({ error: "User not found." });
  const set = {};
  if (req.body?.status !== undefined) {
    if (!["active", "disabled"].includes(req.body.status)) return res.status(400).json({ error: "Status must be active or disabled." });
    set.status = req.body.status;
  }
  if (set.status === "disabled" && u._id === req.user._id) return res.status(400).json({ error: "You can't turn off your own account." });
  if (set.status === "disabled") set.tokenVersion = (u.tokenVersion || 0) + 1; // signs them out
  await col.users.updateOne({ _id: u._id }, { $set: set });
  res.json({ user: publicUser(Object.assign(u, set)) });
});

teamRoutes.post("/:id/reset-password", async (req, res) => {
  const u = await col.users.findOne({ _id: req.params.id });
  if (!u) return res.status(404).json({ error: "User not found." });
  const temp = crypto.randomBytes(6).toString("base64url");
  await col.users.updateOne({ _id: u._id }, { $set: { hash: await bcrypt.hash(temp, 11), tokenVersion: (u.tokenVersion || 0) + 1 } });
  res.json({ tempPassword: temp });
});

export { out };
