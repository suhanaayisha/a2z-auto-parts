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
  await Promise.all([
    col.users.createIndex({ email: 1 }, { unique: true }),
    col.enquiries.createIndex({ customerId: 1 }),
    col.invoices.createIndex({ enquiryId: 1 }),
    col.invoices.createIndex({ invNo: 1 }),
    col.credits.createIndex({ invoiceId: 1 }),
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
