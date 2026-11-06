// MongoDB connection and collections.
// Every document uses a short string _id so records travel as plain JSON.
import { MongoClient } from "mongodb";

export const col = {};
let client = null;

export async function connect(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || "partsdesk") {
  if (!uri) throw new Error("MONGODB_URI is not set. Add your MongoDB Atlas connection string.");
  let db;
  if (uri === "memory") {
    // Test-only in-memory stand-in. Never used in production.
    const { memoryDb } = await import("../test/fake-mongo.js");
    db = memoryDb();
  } else {
    client = new MongoClient(uri, { maxPoolSize: 10 });
    await client.connect();
    db = client.db(dbName);
  }
  for (const name of ["users", "settings", "customers", "enquiries", "invoices", "credits", "counters", "photos"]) {
    col[name] = db.collection(name);
  }
  // WhatsApp intake (see README → WhatsApp intake): raw messages, batches waiting to be read, chats, voice notes, audit log,
  // the linked device's login (wa_auth), the listener's status (wa_state) the team's price messages (wa_prices) and quotes sent from the app (wa_outbox).
  for (const name of ["wa_messages", "wa_batches", "wa_chats", "wa_media", "wa_audit", "wa_auth", "wa_state", "wa_prices", "wa_outbox"]) {
    col[name] = db.collection(name);
  }
  await Promise.all([
    col.users.createIndex({ email: 1 }, { unique: true }),
    col.enquiries.createIndex({ customerId: 1 }),
    col.invoices.createIndex({ enquiryId: 1 }),
    col.invoices.createIndex({ invNo: 1 }),
    col.credits.createIndex({ invoiceId: 1 }),
    col.wa_messages.createIndex({ batchId: 1 }),
    col.wa_batches.createIndex({ status: 1, lastAt: 1 }),
    col.wa_batches.createIndex({ chat: 1, status: 1 }),
    col.wa_audit.createIndex({ batchId: 1 }),
    col.wa_prices.createIndex({ status: 1, nextAt: 1 }),
    col.wa_prices.createIndex({ messageId: 1 }),
    col.wa_outbox.createIndex({ status: 1, createdAt: 1 }),
  ]);
  return db;
}

export async function close() { if (client) await client.close(); }

// Sequential numbers (ENQ, QT, INV, CN). $inc is atomic, so two users can never get the same number.
export async function nextSeq(name) {
  const r = await col.counters.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return (r && (r.seq ?? r.value?.seq)) || 1;
}
export async function setSeqAtLeast(name, value) {
  const cur = await col.counters.findOne({ _id: name });
  if (!cur || (cur.seq || 0) < value) await col.counters.updateOne({ _id: name }, { $set: { seq: value } }, { upsert: true });
}

// Strip Mongo's _id into id for the client.
export const out = d => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest }; };
