// Phase 2: price in the app, then Send to WhatsApp as a reply to the workshop's request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.WA_QUIET_SECONDS = "60";

const { connect, col } = await import("../src/db.js");
const { createApi } = await import("../src/app.js");
const { ingestMessage } = await import("../src/wa/ingest.js");
const { processDue } = await import("../src/wa/processor.js");
const { processOutbox, recoverStuckSends } = await import("../src/wa/outbox.js");
const { setAiStub } = await import("../src/ai.js");

let server, BASE, cookie = "", carExperts, enq;
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const GROUP = "120363car@g.us";
const connected = on => col.wa_state.replaceOne({ _id: "listener" }, { connection: on ? "open" : "qr", seenAt: new Date().toISOString() }, { upsert: true });
const sent = [];
const fakeSend = async job => { sent.push(job); return "SENT" + sent.length; };

before(async () => {
  await connect("memory");
  server = createApi().listen(0);
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  await call("POST", "/auth/signup", { name: "Adil", email: "adil@example.com", password: "correct horse" });
  carExperts = (await call("POST", "/customers", { name: "Car Experts", groups: "CAR EXPERTS ~ A2Z" })).customer.id;
  setAiStub(async ({ content }) => {
    const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (/: OK/.test(text)) return JSON.stringify({ kind: "quote_reply", confidence: 0.95 });
    return JSON.stringify({ kind: "enquiry", confidence: 0.95, items: [{ vehicle: "Toyota Land Cruiser 2018", part: "Headlamp LH", qty: 1 }] });
  });
  await ingestMessage({ id: "w1", chat: GROUP, chatName: "CAR EXPERTS ~ A2Z", isGroup: true, sender: "971562187411@s.whatsapp.net",
    participant: "123456789012345@lid", senderName: "Car Experts", ts: new Date().toISOString(), type: "text", text: "need LC 2018 headlight LH" });
  await processDue(Date.now() + 61e3);
  enq = await col.enquiries.findOne({ waChat: GROUP });
  // Priced and quoted in the app, the normal way.
  enq.items[0].options[0].sell = 450;
  let r = await call("PUT", `/enquiries/${enq._id}`, { ...enq, id: enq._id });
  r = await call("POST", `/enquiries/${enq._id}/quote`);
  assert.equal(r.enquiry.status, "quoted");
});
after(() => server?.close());

test("the Send dialog knows where the quote goes and which message it replies to", async () => {
  const r = await call("GET", `/wa/enquiries/${enq._id}/send-target`);
  assert.equal(r.target.chat, GROUP);
  assert.equal(r.target.chatName, "CAR EXPERTS ~ A2Z");
  assert.deepEqual(r.target.quoted, { id: "w1", participant: "123456789012345@lid", text: "need LC 2018 headlight LH", by: "Car Experts" });
  assert.equal(r.enabled, true, "on unless turned off");
  assert.equal(r.connected, false);
});

test("won't send while WhatsApp is disconnected, or with sending turned off", async () => {
  let r = await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "Quotation QT-0001" });
  assert.equal(r.status, 409);
  await connected(true);
  await call("PUT", "/settings/whatsapp", { sending: false });
  r = await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "Quotation QT-0001" });
  assert.equal(r.status, 403);
  await call("PUT", "/settings/whatsapp", { sending: true });
  r = await call("PUT", "/settings/company", { name: "A2Z", address: "Sharjah" });
  assert.equal(r.company.waSending, true, "saving company details keeps the setting");
});

test("Send queues it once; the listener sends it as a reply and records it", async () => {
  let r = await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "*Quotation QT-0001*\n1. Headlamp LH: AED 450.00" });
  assert.equal(r.status, 202);
  assert.equal(r.enquiry.waSent.status, "queued");
  assert.equal((await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "again" })).status, 409, "no double send");

  assert.equal(await processOutbox(fakeSend), "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, GROUP);
  assert.deepEqual(sent[0].quoted, { id: "w1", participant: "123456789012345@lid", text: "need LC 2018 headlight LH" });
  const e = await col.enquiries.findOne({ _id: enq._id });
  assert.equal(e.waSent.status, "sent");
  assert.equal(e.waSent.messageId, "SENT1");
  assert.equal(await processOutbox(fakeSend), null, "nothing else to send");
});

test("the workshop's OK in reply to the sent quote is noted on the enquiry", async () => {
  await ingestMessage({ id: "w2", chat: GROUP, chatName: "CAR EXPERTS ~ A2Z", isGroup: true, sender: "971562187411@s.whatsapp.net",
    senderName: "Car Experts", ts: new Date().toISOString(), type: "text", text: "OK", quoted: { id: "SENT1", text: "*Quotation QT-0001*" } });
  await processDue(Date.now() + 61e3);
  const e = await col.enquiries.findOne({ _id: enq._id });
  assert.equal(e.waReply.text, "OK");
});

test("a failed send is retried, then shown on the enquiry", async () => {
  await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "revised" });
  const boom = async () => { throw new Error("not connected"); };
  assert.equal(await processOutbox(boom), "retry");
  assert.equal(await processOutbox(boom), "retry");
  assert.equal(await processOutbox(boom), "failed");
  const e = await col.enquiries.findOne({ _id: enq._id });
  assert.equal(e.waSent.status, "failed");
  assert.match(e.waSent.error, /not connected/);
});

test("a message that couldn't go out within 15 minutes is not sent late", async () => {
  await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "late one" });
  assert.equal(await processOutbox(fakeSend, Date.now() + 16 * 60e3), null);
  const e = await col.enquiries.findOne({ _id: enq._id });
  assert.equal(e.waSent.status, "failed");
  assert.match(e.waSent.error, /15 minutes/);
  assert.equal(sent.length, 1, "never sent");
});

test("a crash mid-send is marked as unsure rather than sent twice", async () => {
  await call("POST", `/wa/enquiries/${enq._id}/send`, { text: "stuck" });
  await col.wa_outbox.updateOne({ status: "queued" }, { $set: { status: "sending", lockedAt: new Date(Date.now() - 10 * 60e3).toISOString() } });
  await recoverStuckSends();
  const e = await col.enquiries.findOne({ _id: enq._id });
  assert.equal(e.waSent.status, "failed");
  assert.match(e.waSent.error, /Check the group/);
});

test("an enquiry typed in by hand goes to the workshop's group, not as a reply", async () => {
  let r = await call("POST", "/enquiries", { customerId: carExperts, items: [{ vehicle: "Nissan Patrol", part: "Mirror RH", qty: 1, options: [{ quality: "used", sell: 300 }] }] });
  const id = r.enquiry.id;
  await call("POST", `/enquiries/${id}/quote`);
  r = await call("GET", `/wa/enquiries/${id}/send-target`);
  assert.equal(r.target.chat, GROUP, "found by the workshop's group name");
  assert.equal(r.target.quoted, null);
  r = await call("POST", `/wa/enquiries/${id}/send`, { text: "Quotation QT-0002" });
  assert.equal(r.status, 202);
  await processOutbox(fakeSend);
  assert.equal(sent.at(-1).quoted, null);
});
