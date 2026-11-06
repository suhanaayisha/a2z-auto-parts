// Phase 1: prices the team sends in WhatsApp groups become suggested prices on the enquiry.
// Replays the Car Experts conversation: Jeep request → salesperson replies with prices → revised price → workshop says OK.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.WA_QUIET_SECONDS = "60";

const { connect, col } = await import("../src/db.js");
const { createApi } = await import("../src/app.js");
const { ingestMessage } = await import("../src/wa/ingest.js");
const { processDue } = await import("../src/wa/processor.js");
const { setAiStub } = await import("../src/ai.js");
const { setVinStub } = await import("../src/wa/vin.js");

let server, BASE, cookie = "", carExperts, other;
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
let clock = Date.now();
const tick = s => { clock += s * 1000; return processDue(clock); };

const ITEMS = ["A.c blower assembly", "A.c filter", "Alternator", "E.g.r. sensor", "Auxiliary battery"];
const priceCalls = [];
before(async () => {
  await connect("memory");
  server = createApi().listen(0);
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  await call("POST", "/auth/signup", { name: "Adil", email: "adil@example.com", password: "correct horse" });
  carExperts = (await call("POST", "/customers", { name: "Car Experts", groups: "CAR EXPERTS ~ A2Z" })).customer.id;
  other = (await call("POST", "/customers", { name: "Speedline", groups: "Speedline Orders" })).customer.id;
  await call("PUT", "/settings/team-numbers", { teamNumbers: "+971 50 706 8977" });
  setVinStub(async vin => ({ vin, year: 2018, make: "Jeep", model: "Grand Cherokee", trim: "", engine: "", confirmed: true }));
  setAiStub(async ({ system, content }) => {
    if (system.includes("selling price in AED")) {
      priceCalls.push(content);
      const msg = content.split("Supplier's message:\n")[1];
      if (/what kind/i.test(msg)) return JSON.stringify({ isPrices: false, lines: [] });
      if (/^EGR 420/m.test(msg)) return JSON.stringify({ isPrices: true, lines: [{ item: 4, price: 420 }], confidence: 0.95 });
      if (/bumper/i.test(msg)) return JSON.stringify({ isPrices: true, lines: [{ item: 1, price: 900 }], confidence: 0.9 });
      return JSON.stringify({ isPrices: true, confidence: 0.92, lines: [
        { item: 1, price: 540 }, { item: 2, price: 65 }, { item: 3, price: 2000 }, { item: 4, price: null, note: "NEED SAMPLE" }, { item: 5, price: 350 }] });
    }
    const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (/: OK$/m.test(text)) return JSON.stringify({ kind: "quote_reply", confidence: 0.95 });
    if (/CHEROKEE/.test(text)) return JSON.stringify({ kind: "enquiry", confidence: 0.95, items: ITEMS.map(part => ({ vehicle: "Jeep Grand Cherokee 2018", part, qty: 1 })) });
    if (/bumper/i.test(text)) return JSON.stringify({ kind: "enquiry", confidence: 0.95, items: [{ vehicle: "Nissan Patrol 2019", part: "Front bumper", qty: 1 }] });
    return JSON.stringify({ kind: "other", confidence: 0.9 });
  });
});
after(() => server?.close());

const GROUP = "120363car@g.us";
const say = (id, from, text, extra = {}) => ingestMessage(Object.assign({ id, chat: GROUP, chatName: "CAR EXPERTS ~ A2Z", isGroup: true,
  sender: from === "team" ? "971507068977@s.whatsapp.net" : "971562187411@s.whatsapp.net", senderName: from === "team" ? "A2Z Auto Spare Parts" : "Car Experts",
  ts: new Date(clock).toISOString(), type: "text", text }, extra));
const enquiryOf = async () => col.enquiries.findOne({ waChat: GROUP });

test("a price reply that arrives before the enquiry is ready waits for it, then becomes a suggestion", async () => {
  await say("w1", "shop", "JEEP GRAND CHEROKEE\n1C4RJFBG5JC325647\n\nA.c blower assym\nA.c filter\nAlternantor\nE.g.r. sensor\nAuxiliary battery");
  await say("t1", "team", "EEP GRAND CHEROKEE\n1C4RJFBG5JC325647\n\nA.c blower assym--540\nA.c filter-65\nAlternantor -2000\nE.g.r. sensor -- NEED SAMPLE\nAuxiliary battery 350",
    { quoted: { id: "w1", text: "JEEP GRAND CHEROKEE" } });
  const job = await col.wa_prices.findOne({ messageId: "t1" });
  assert.equal(job.status, "pending");
  assert.equal(await col.wa_batches.countDocuments({ chat: GROUP }), 1, "the team message didn't join the workshop's batch");

  await tick(10);
  assert.equal((await col.wa_prices.findOne({ messageId: "t1" })).status, "pending", "waits: the request is still being read");
  await tick(55);
  const e = await enquiryOf();
  assert.ok(e, "the request became an enquiry");
  assert.equal(e.waPrices, undefined, "prices not matched yet in this round");
  await tick(70);
  const after = await enquiryOf();
  assert.equal((await col.wa_prices.findOne({ messageId: "t1" })).status, "suggested");
  assert.equal(after.waPrices.match, "reply");
  assert.equal(after.waPrices.by, "A2Z Auto Spare Parts");
  assert.deepEqual(after.waPrices.lines.map(l => [l.part, l.price, l.note]), [
    ["A.c blower assembly", 540, ""], ["A.c filter", 65, ""], ["Alternator", 2000, ""], ["E.g.r. sensor", null, "NEED SAMPLE"], ["Auxiliary battery", 350, ""]]);
  assert.equal(after.status, "new", "nothing changes until someone presses Apply");
  assert.ok(after.items.every(it => !it.options[0].sell), "no prices filled in yet");
  assert.match(priceCalls.at(-1), /1\. Jeep Grand Cherokee 2018 – A\.c blower assembly \(qty 1\)/);
});

test("Apply fills in the prices and notes; no quote yet because one item has no price", async () => {
  const e = await enquiryOf();
  const r = await call("POST", `/wa/enquiries/${e._id}/prices/apply`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.enquiry.items.map(it => it.options[0].sell), [540, 65, 2000, 0, 350]);
  assert.match(r.enquiry.notes, /From WhatsApp \(A2Z Auto Spare Parts\): E\.g\.r\. sensor: NEED SAMPLE/);
  assert.ok(r.enquiry.waPrices.applied);
  assert.equal(r.enquiry.status, "new");
  assert.equal(r.enquiry.quoteNo, null);
  assert.equal((await call("POST", `/wa/enquiries/${e._id}/prices/apply`)).status, 400, "only once");
  assert.equal((await col.wa_prices.findOne({ messageId: "t1" })).status, "applied");
});

test("a revised price replying to the price message completes the quote when applied", async () => {
  await say("t2", "team", "EGR 420 sample received", { quoted: { id: "t1", text: "A.c blower assym--540" } });
  await tick(5);
  const e = await enquiryOf();
  assert.equal(e.waPrices.match, "reply_to_prices");
  assert.deepEqual(e.waPrices.lines.map(l => [l.part, l.price]), [["E.g.r. sensor", 420]]);
  const r = await call("POST", `/wa/enquiries/${e._id}/prices/apply`);
  assert.equal(r.enquiry.items[3].options[0].sell, 420);
  assert.equal(r.enquiry.status, "quoted", "every item priced → quoted");
  assert.equal(r.enquiry.quoteNo, 1);
});

test("the workshop's OK in reply to the prices is noted on the enquiry", async () => {
  await say("w2", "shop", "OK", { quoted: { id: "t2", text: "EGR 420 sample received" } });
  await tick(65);
  const e = await enquiryOf();
  assert.equal(e.waReply.text, "OK");
  assert.equal(e.waReply.by, "Car Experts");
  const b = await col.wa_batches.findOne({ chat: GROUP, status: "ignored" });
  assert.ok(b, "the OK itself is not a new request");
  assert.deepEqual(b.repliedTo, [e._id]);
});

test("a question from the team is not read as prices", async () => {
  await say("t3", "team", "Relay? what kind of", { quoted: { id: "w1", text: "JEEP GRAND CHEROKEE" } });
  await tick(5);
  assert.equal((await col.wa_prices.findOne({ messageId: "t3" })).status, "not_prices");
  assert.ok((await enquiryOf()).waPrices.applied, "the applied suggestion is untouched");
});

test("prices sent without replying: one open enquiry → matched; otherwise someone picks it", async () => {
  const G2 = "120363speed@g.us";
  const shop = (id, text) => ingestMessage({ id, chat: G2, chatName: "Speedline Orders", isGroup: true, sender: "971555555555@s.whatsapp.net", senderName: "Faiz", ts: new Date(clock).toISOString(), type: "text", text });
  const team = (id, text) => ingestMessage({ id, chat: G2, chatName: "Speedline Orders", isGroup: true, sender: "971507068977@s.whatsapp.net", senderName: "A2Z", ts: new Date(clock).toISOString(), type: "text", text });
  await shop("s1", "need front bumper patrol 2019");
  await tick(65);
  await team("st1", "bumper 900");
  await tick(5);
  const e1 = (await col.enquiries.find({ waChat: G2 }).toArray())[0];
  assert.equal(e1.waPrices.match, "only_open");

  await shop("s2", "need front bumper patrol 2019 again for another car");
  await tick(65);
  await team("st2", "bumper 900 for the second one");
  await tick(5);
  const job = await col.wa_prices.findOne({ messageId: "st2" });
  assert.equal(job.status, "unmatched", "two open enquiries: don't guess");
  const boot = await call("GET", "/bootstrap");
  assert.equal(boot.waReview, 1, "counted on the WhatsApp tab");
  const list = await call("GET", "/wa/prices");
  assert.equal(list.prices.length, 1);
  assert.equal(list.prices[0].customerId, other, "so the screen can offer that workshop's enquiries");

  const e2 = (await col.enquiries.find({ waChat: G2 }).toArray()).find(e => e._id !== e1._id);
  assert.equal((await call("POST", `/wa/prices/${job._id}/assign`, { enquiryId: e2._id })).status, 200);
  await tick(1);
  const after = await col.enquiries.findOne({ _id: e2._id });
  assert.equal(after.waPrices.match, "manual");
  assert.equal(after.waPrices.lines[0].price, 900);
  const d = await call("POST", `/wa/enquiries/${e2._id}/prices/dismiss`);
  assert.ok(d.enquiry.waPrices.dismissed);
  assert.equal((await col.wa_prices.findOne({ _id: job._id })).status, "dismissed");
});
