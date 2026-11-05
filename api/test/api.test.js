// End-to-end API test against the in-memory store: `npm test`
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api`;
let proc;

before(async () => {
  proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, MONGODB_URI: "memory", PORT: String(PORT), SESSION_SECRET: crypto.randomBytes(32).toString("hex"), ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ok, fail) => { proc.stdout.on("data", d => String(d).includes("listening") && ok()); setTimeout(() => fail(new Error("API did not start")), 8000); });
});
after(() => proc?.kill());

function client() {
  let cookie = "";
  return async function call(method, path, body) {
    const r = await fetch(BASE + path, {
      method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ...data };
  };
}

const adil = client(), faisal = client(), stranger = client();
let customerId, enquiry, invoice;

test("first sign-up is active; later sign-ups wait for approval by anyone on the team", async () => {
  let r = await adil("POST", "/auth/signup", { name: "Adil", email: "adil@example.com", password: "correct horse" });
  assert.equal(r.status, 201); assert.equal(r.user.role, undefined, "no roles");
  r = await faisal("POST", "/auth/signup", { name: "Faisal", email: "faisal@example.com", password: "battery staple" });
  assert.equal(r.status, 201); assert.equal(r.pending, true);
  r = await faisal("POST", "/auth/login", { email: "faisal@example.com", password: "battery staple" });
  assert.equal(r.status, 403);
  r = await faisal("POST", "/auth/signup", { name: "Dup", email: "FAISAL@example.com", password: "battery staple" });
  assert.equal(r.status, 409);
  const team = await adil("GET", "/team");
  const f = team.users.find(u => u.email === "faisal@example.com");
  r = await adil("PATCH", "/team/" + f.id, { status: "active" });
  assert.equal(r.user.status, "active");
  r = await faisal("POST", "/auth/login", { email: "faisal@example.com", password: "battery staple" });
  assert.equal(r.status, 200);
  r = await stranger("GET", "/bootstrap");
  assert.equal(r.status, 401);
  r = await faisal("GET", "/team");
  assert.equal(r.status, 200, "every user can manage the team");
  r = await faisal("PATCH", "/team/" + team.users[1].id, { status: "disabled" });
  assert.equal(r.status, 400, "cannot turn off your own account");
});

test("every user can change company settings", async () => {
  let r = await faisal("PUT", "/settings/company", { name: "X" });
  assert.equal(r.status, 200);
  r = await adil("PUT", "/settings/company", { name: "Al Noor Used Auto Parts Trading LLC", address: "Al Aweer, Dubai", licence: "1234567", authority: "Dubai DET", salespeople: [{ name: "Faisal", pct: 5 }] });
  assert.equal(r.company.licence, "1234567");
  r = await faisal("POST", "/customers", { name: "Al Quoz Auto Care", trn: "100345678900003", address: "Al Quoz 3" });
  assert.equal(r.status, 201); customerId = r.customer.id;
  r = await adil("POST", "/customers", { name: "Bad TRN", trn: "123" });
  assert.equal(r.status, 400);
});

test("enquiry → quote; every user sees and keeps cost figures", async () => {
  let r = await adil("POST", "/enquiries", { customerId, sender: "Imran", items: [
    { k: "a", vehicle: "Kia Sportage 2019", part: "Front bumper", qty: 1, options: [{ k: "a1", quality: "used", cost: 500, sell: 820 }, { k: "a2", quality: "aftermarket", cost: 260, sell: 480, lead: 3 }] },
    { k: "b", vehicle: "Kia Sportage 2019", part: "Fog lamps", qty: 2, options: [{ k: "b1", quality: "used", cost: 60, sell: 110, disc: 20 }] },
  ], commAmt: 40 });
  assert.equal(r.status, 201); assert.equal(r.enquiry.enqNo, 1);
  enquiry = r.enquiry;
  const sb = await faisal("GET", "/bootstrap");
  const se = sb.enquiries[0];
  assert.equal(se.items[0].options[0].cost, 500); assert.equal(se.commAmt, 40);
  assert.equal(sb.company.salespeople[0].pct, 5);
  se.items[0].options[0].sell = 800; // another user changes a price
  r = await faisal("PUT", "/enquiries/" + se.id, se);
  assert.equal(r.status, 200);
  const ab = await adil("GET", "/bootstrap");
  assert.equal(ab.enquiries[0].items[0].options[0].cost, 500, "cost kept");
  assert.equal(ab.enquiries[0].items[0].options[0].sell, 800);
  assert.equal(ab.enquiries[0].commAmt, 40, "commission kept");
  r = await faisal("POST", `/enquiries/${se.id}/quote`);
  assert.equal(r.enquiry.quoteNo, 1); assert.equal(r.enquiry.status, "quoted");
  r = await faisal("POST", `/enquiries/${se.id}/revise`);
  assert.equal(r.enquiry.quoteRev, 2);
  r = await faisal("DELETE", "/enquiries/" + se.id);
  assert.equal(r.status, 400, "quoted enquiries cannot be deleted");
});

test("partial invoice from the quote, locked lines, payments, credit note", async () => {
  const id = enquiry.id;
  let r = await faisal("POST", `/enquiries/${id}/invoices`, { lines: [{ ik: "a", opt: 1, qty: 1 }, { ik: "b", opt: 0, qty: 1 }], supplyDate: "2026-11-05", payTerms: 7 });
  assert.equal(r.status, 201, JSON.stringify(r));
  invoice = r.invoice;
  assert.equal(invoice.invNo, 1);
  assert.equal(invoice.total, 480 + 110 - 10, "line discount shared by quantity");
  assert.equal(invoice.lines[0].cost, 260, "cost visible to everyone");
  assert.equal(r.enquiry.status, "confirmed", "one fog lamp still to invoice");
  r = await faisal("POST", `/enquiries/${id}/invoices`, { lines: [{ ik: "b", opt: 0, qty: 2 }] });
  assert.equal(r.status, 400, "cannot invoice more than remains");
  // invoiced item is locked
  const ab = await adil("GET", "/bootstrap");
  const e = ab.enquiries.find(x => x.id === id);
  e.items[0].options[1].sell = 1; e.items[0].part = "Changed";
  await adil("PUT", "/enquiries/" + id, e);
  const ab2 = await adil("GET", "/bootstrap");
  assert.equal(ab2.enquiries.find(x => x.id === id).items[0].options[1].sell, 480);
    // second invoice for the rest
  r = await faisal("POST", `/enquiries/${id}/invoices`, { lines: [{ ik: "b", opt: 0, qty: 1 }] });
  assert.equal(r.invoice.invNo, 2); assert.equal(r.enquiry.status, "invoiced");
  // payments
  r = await faisal("POST", `/invoices/${invoice.id}/payments`, { amount: 9999 });
  assert.equal(r.status, 400);
  r = await faisal("POST", `/invoices/${invoice.id}/payments`, { amount: 300, method: "Cash", date: "2026-11-05" });
  assert.equal(r.invoice.status, "issued");
  r = await faisal("POST", `/invoices/${invoice.id}/payments`, { amount: 280, method: "Bank transfer" });
  assert.equal(r.invoice.status, "paid");
  // any user can cancel
  r = await faisal("POST", `/invoices/${invoice.id}/cancel`, {});
  assert.equal(r.status, 400, "reason required");
  r = await faisal("POST", `/invoices/${invoice.id}/cancel`, { reason: "Wrong option invoiced" });
  assert.equal(r.status, 201);
  assert.equal(r.credit.cnNo, 1); assert.equal(r.invoice.status, "cancelled");
  assert.equal(r.enquiry.status, "confirmed", "cancelled lines are open again");
  r = await faisal("POST", `/enquiries/${id}/invoices`, { lines: [{ ik: "a", opt: 0, qty: 1 }, { ik: "b", opt: 0, qty: 1 }] });
  assert.equal(r.invoice.invNo, 3, "numbers never reused");
});

test("sample data is numbered apart from real invoices", async () => {
  const sample = { customers: [{ id: "c9", name: "Sample Garage", sample: true }],
    enquiries: [{ id: "e9", enqNo: 50, quoteNo: 50, quoteRev: 1, quoteDate: "2026-11-01T10:00:00Z", status: "quoted", customerId: "c9", sample: true,
      items: [{ k: "s", part: "Radiator", vehicle: "Pajero", qty: 1, chosen: 0, options: [{ quality: "used", sell: 380, cost: 220 }] }] }],
    invoices: [{ id: "i9", invNo: 7, enquiryId: "e9", customerId: "c9", status: "issued", total: 1, lines: [], sample: true }] };
  let r = await adil("POST", "/import", sample);
  assert.deepEqual(r.imported, { customers: 1, enquiries: 1, invoices: 1, credits: 0 });
  r = await faisal("POST", `/enquiries/e9/invoices`, { lines: [{ ik: "s", opt: 0, qty: 1 }] });
  assert.equal(r.invoice.invNo, 8); assert.equal(r.invoice.sample, true);
  r = await adil("POST", "/sample/clear");
  assert.equal(r.removed.invoices, 2);
  const e = await adil("POST", "/enquiries", { customerId, items: [{ k: "z", part: "Mirror", vehicle: "Lexus", qty: 1, options: [{ quality: "used", sell: 480 }] }] });
  await adil("POST", `/enquiries/${e.enquiry.id}/quote`);
  r = await adil("POST", `/enquiries/${e.enquiry.id}/invoices`, { lines: [{ ik: "z", opt: 0, qty: 1 }] });
  assert.equal(r.invoice.invNo, 4, "real numbering continues from INV-0003");
});

test("password change signs out other sessions; reset gives a temporary password", async () => {
  let r = await faisal("POST", "/auth/password", { current: "battery staple", next: "new password 1" });
  assert.equal(r.ok, true);
  r = await faisal("GET", "/bootstrap"); assert.equal(r.status, 200, "this session continues");
  const team = await adil("GET", "/team");
  const f = team.users.find(u => u.email === "faisal@example.com");
  r = await adil("POST", `/team/${f.id}/reset-password`);
  assert.ok(r.tempPassword.length >= 8);
  r = await faisal("GET", "/bootstrap"); assert.equal(r.status, 401, "old session ended");
  r = await faisal("POST", "/auth/login", { email: "faisal@example.com", password: r.tempPassword });
});
