// WhatsApp intake end to end, in one process: messages in → batches → worker → enquiry or review → accept.
// Claude and the transcriber are replaced by stubs; the listener (Baileys) is not involved.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.WA_QUIET_SECONDS = "60";
process.env.WA_MAX_WAIT_MINUTES = "10";
process.env.WA_AUTO_CONFIDENCE = "0.85";

const { connect, col } = await import("../src/db.js");
const { createApi } = await import("../src/app.js");
const { ingestMessage } = await import("../src/wa/ingest.js");
const { processDue } = await import("../src/wa/processor.js");
const { setAiStub } = await import("../src/ai.js");
const { setTranscribeStub } = await import("../src/wa/transcribe.js");

let server, BASE, cookie = "", customerId;
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const at = ms => new Date(ms).toISOString();
const T0 = Date.now();
let seen = []; // what the stubbed Claude was sent

before(async () => {
  await connect("memory");
  server = createApi().listen(0);
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  await call("POST", "/auth/signup", { name: "Adil", email: "adil@example.com", password: "correct horse" });
  customerId = (await call("POST", "/customers", { name: "Al Noor Garage", groups: "Al Noor Parts, A2Z – Al Noor", phone: "+971 50 123 4567" })).customer.id;

  setTranscribeStub(async () => "Brother I need the right side mirror for Patrol 2019, used is fine");
  setAiStub(async ({ content }) => {
    const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    seen.push({ text, images: content.filter(c => c.type === "image").length });
    if (/1A 2B/.test(text)) return JSON.stringify({ kind: "quote_reply", confidence: 0.95 });
    if (/headlight/i.test(text)) return JSON.stringify({ kind: "enquiry", confidence: 0.95, sender: "Imran", items: [{ vehicle: "Toyota Land Cruiser 2018", part: "Headlamp LH", qty: 1 }, { vehicle: "Toyota Land Cruiser 2018", part: "Headlamp RH", qty: 1 }] });
    if (/mirror/i.test(text)) return JSON.stringify({ kind: "enquiry", confidence: 0.92, items: [{ vehicle: "Nissan Patrol 2019", part: "Side mirror RH", qty: 1, quality: "used" }] });
    return JSON.stringify({ kind: "enquiry", confidence: 0.5, items: [{ vehicle: "", part: "Bumper", qty: 1 }], notes: "Vehicle not given" });
  });
});
after(() => server?.close());

const msg = (id, chat, chatName, extra) => Object.assign({ id, chat, chatName, isGroup: chat.endsWith("@g.us"), sender: "971501234567@s.whatsapp.net", senderName: "Imran", ts: at(T0), type: "text", text: "" }, extra);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

test("messages close together join one batch; duplicates are dropped", async () => {
  await ingestMessage(msg("m1", "120363@g.us", "Al Noor Parts", { text: "Salam, need both headlights LC 2018" }));
  await ingestMessage(msg("m2", "120363@g.us", "Al Noor Parts", { type: "image", text: "this one", media: { mime: "image/jpeg", data: JPEG } }));
  assert.equal(await ingestMessage(msg("m2", "120363@g.us", "Al Noor Parts", { text: "dup" })), null);
  const batches = await col.wa_batches.find({ chat: "120363@g.us" }).toArray();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].messageIds, ["m1", "m2"]);
  assert.equal(batches[0].status, "open");
});

test("the worker waits for the chat to go quiet", async () => {
  assert.equal(await processDue(Date.now() + 10e3), 0);
});

test("a clear enquiry from a known group becomes an enquiry with its photo", async () => {
  assert.equal(await processDue(Date.now() + 61e3), 1);
  const b = (await col.wa_batches.find({ chat: "120363@g.us" }).toArray())[0];
  assert.equal(b.status, "created");
  assert.equal(b.customerId, customerId, "matched on the workshop's WhatsApp group name");
  assert.equal(seen.at(-1).images, 1, "the photo was sent to Claude");
  const e = await col.enquiries.findOne({ _id: b.enquiryId });
  assert.equal(e.source, "whatsapp");
  assert.equal(e.status, "new");
  assert.equal(e.items.length, 2);
  assert.equal(e.items[0].part, "Headlamp LH");
  assert.equal(e.items[0].options.length, 1, "one option ready for pricing");
  assert.equal(e.photos.length, 1);
  assert.match(e.message, /Imran: Salam, need both headlights/);
  assert.equal(e.sender, "Imran");
  const audit = await col.wa_audit.find({ batchId: b._id }).toArray();
  assert.equal(audit[0].action, "auto_created");
});

test("a voice note from a direct chat is transcribed and matched by phone number", async () => {
  await ingestMessage(msg("v1", "971501234567@s.whatsapp.net", "Imran", { type: "audio", media: { mime: "audio/ogg; codecs=opus", data: Buffer.from("OggS") } }));
  await processDue(Date.now() + 61e3);
  const b = await col.wa_batches.findOne({ chat: "971501234567@s.whatsapp.net" });
  assert.equal(b.status, "created");
  assert.match(seen.at(-1).text, /voice note\): Brother I need the right side mirror/);
  const e = await col.enquiries.findOne({ _id: b.enquiryId });
  assert.equal(e.items[0].part, "Side mirror RH");
});

test("replies to quotes are set aside, not turned into enquiries", async () => {
  await ingestMessage(msg("q1", "120363@g.us", "Al Noor Parts", { text: "1A 2B ok send" }));
  await processDue(Date.now() + 61e3);
  const b = await col.wa_batches.findOne({ chat: "120363@g.us", status: "ignored" });
  assert.ok(b);
  assert.equal(b.extraction.kind, "quote_reply");
});

let reviewId;
test("unclear requests and unknown chats wait for review", async () => {
  await ingestMessage(msg("u1", "999@g.us", "Some New Garage", { text: "need bumper" }));
  await processDue(Date.now() + 61e3);
  const b = await col.wa_batches.findOne({ chat: "999@g.us" });
  assert.equal(b.status, "review");
  assert.equal(b.customerId, null);
  assert.equal(b.extraction.confidence, 0.5);
  reviewId = b._id;
  const boot = await call("GET", "/bootstrap");
  assert.equal(boot.waReview, 1, "counted for the tab badge");
  const inbox = await call("GET", "/wa/inbox?view=review");
  assert.equal(inbox.batches.length, 1);
  assert.equal(inbox.batches[0].messages[0].text, "need bumper");
});

test("accepting needs a workshop, creates the enquiry once, and remembers the chat", async () => {
  let r = await call("POST", `/wa/batches/${reviewId}/accept`, {});
  assert.equal(r.status, 400);
  r = await call("POST", `/wa/batches/${reviewId}/accept`, { customerId, items: [{ vehicle: "Lexus LX 2020", part: "Front bumper", qty: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.enquiry.items[0].vehicle, "Lexus LX 2020", "the edited items are used");
  assert.equal(r.enquiry.source, "whatsapp");
  r = await call("POST", `/wa/batches/${reviewId}/accept`, { customerId });
  assert.equal(r.status, 409, "no second enquiry");
  const chat = await col.wa_chats.findOne({ _id: "999@g.us" });
  assert.equal(chat.customerId, customerId);
  const audit = await call("GET", `/wa/batches/${reviewId}/audit`);
  assert.deepEqual(audit.audit.map(a => a.action), ["review", "accepted"]);
});

test("dismiss and retry", async () => {
  await ingestMessage(msg("u2", "888@g.us", "Another", { text: "bumper pls" }));
  await processDue(Date.now() + 61e3);
  const b = await col.wa_batches.findOne({ chat: "888@g.us" });
  assert.equal((await call("POST", `/wa/batches/${b._id}/dismiss`)).status, 200);
  assert.equal((await col.wa_batches.findOne({ _id: b._id })).status, "dismissed");
  assert.equal((await call("POST", `/wa/batches/${b._id}/retry`)).status, 200);
  await processDue(Date.now() + 1000);
  assert.equal((await col.wa_batches.findOne({ _id: b._id })).status, "review");
});

test("a failing read is retried, then marked failed", async () => {
  setAiStub(async () => { throw new Error("overloaded"); });
  await ingestMessage(msg("f1", "777@g.us", "Fail Garage", { text: "need door" }));
  let now = Date.now();
  for (let i = 0; i < 3; i++) { now += 61e3; await processDue(now); }
  const b = await col.wa_batches.findOne({ chat: "777@g.us" });
  assert.equal(b.status, "failed");
  assert.equal(b.attempts, 3);
  assert.match(b.error, /overloaded/);
});

test("status shows the listener as offline until it reports in", async () => {
  let r = await call("GET", "/wa/status");
  assert.equal(r.running, false);
  await col.wa_state.replaceOne({ _id: "listener" }, { connection: "qr", qr: "data:image/png;base64,xx", seenAt: new Date().toISOString() }, { upsert: true });
  r = await call("GET", "/wa/status");
  assert.equal(r.running, true);
  assert.equal(r.qr, "data:image/png;base64,xx");
  assert.equal(r.counts.review, 2, "the retried one and the failed one");
});
