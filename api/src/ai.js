// Reading WhatsApp messages into enquiry items with Claude.
// Used by "Read message into items" (/api/ai/read) and by the WhatsApp worker (src/wa/processor.js),
// which also sends photos and voice-note transcripts.
let client = null;

async function anthropic() {
  if (!client) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
  return client;
}
// Tests replace the model call with a stub.
let stub = null;
export function setAiStub(fn) { stub = fn; }
export const aiEnabled = () => !!(stub || process.env.ANTHROPIC_API_KEY);

const RULES = `One entry per distinct part. "Both headlights" = Headlamp LH and Headlamp RH. Expand short names (LC = Toyota Land Cruiser, Patrol = Nissan Patrol). Never invent a year or model. Write items in English, even when the message is in Arabic, Urdu, Hindi or Malayalam.`;

const READ_SYSTEM = `You extract used car parts requests from WhatsApp messages sent by UAE garages to a used auto parts supplier. Reply with JSON only:
{"items":[{"vehicle":"Make Model Year","part":"Part name with side (LH/RH) and front/rear where given","qty":1,"quality":"used|aftermarket|original, only if asked"}]}
${RULES}`;

const CHAT_SYSTEM = `You read a short stretch of a WhatsApp chat between a UAE garage (workshop) and a used auto parts supplier. It can include text, photos (of parts, damaged areas, the car, a registration card / mulkiya or a VIN plate) and voice-note transcripts. Messages sent by the supplier are not included.
Decide what it is and reply with JSON only:
{"kind":"enquiry|quote_reply|other",
 "confidence":0.0,
 "sender":"name of the person asking, if known",
 "items":[{"vehicle":"Make Model Year","part":"Part name with side (LH/RH) and front/rear where given","qty":1,"quality":"used|aftermarket|original, only if asked"}],
 "notes":"one short line on anything unclear, e.g. which side, year missing, photo unclear; empty if nothing"}
kind: "enquiry" = asking for parts or prices. "quote_reply" = answering a quote we sent (codes like "1A 2B", "ok confirm", "too expensive", "send"). "other" = greetings, payment talk, delivery chat, anything else. items only for "enquiry".
Read a vehicle from a registration card or VIN photo when it is legible. When the chat ends with "VIN lookups", use the make, model and year given there for the vehicle the VIN belongs to (a year marked "probably" counts as known); keep the workshop's own wording of the model if it is more specific. Name a part from a photo only when it is clear what it is.
confidence = how sure you are that kind, vehicle and every part are right and complete: 0.9+ only when the vehicle (make and model) and every part are stated or clearly visible; lower it when the vehicle or side is missing, a photo is the only source, or the voice note is unclear.
${RULES}`;

function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}
const cleanItems = items => (Array.isArray(items) ? items : []).filter(i => i && i.part).slice(0, 50).map(i => ({
  vehicle: String(i.vehicle || "").slice(0, 120), part: String(i.part).slice(0, 200),
  qty: Math.max(1, Math.round(Number(i.qty) || 1)), quality: ["used", "aftermarket", "original"].includes(i.quality) ? i.quality : "",
}));

async function call(system, content, maxTokens) {
  if (stub) return stub({ system, content });
  const r = await (await anthropic()).messages.create({
    model: process.env.AI_MODEL || "claude-haiku-4-5-20251001", max_tokens: maxTokens, system,
    messages: [{ role: "user", content }],
  });
  return r.content.map(c => c.text || "").join("");
}

// A single pasted message → items. Same behaviour as before.
export async function readMessage(message) {
  return { items: cleanItems(parse(await call(READ_SYSTEM, message, 1000)).items) };
}

// A batch of WhatsApp messages (text lines plus photos) → kind, items, confidence.
// images: [{ mime, data: Buffer }]
export async function readChat({ transcript, images = [] }) {
  const content = [];
  images.slice(0, 6).forEach((im, i) => {
    content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: im.mime, data: Buffer.from(im.data).toString("base64") } });
  });
  content.push({ type: "text", text: "Chat:\n" + transcript });
  const j = parse(await call(CHAT_SYSTEM, content, 1500));
  const kind = ["enquiry", "quote_reply", "other"].includes(j.kind) ? j.kind : "other";
  const items = kind === "enquiry" ? cleanItems(j.items) : [];
  let confidence = Math.min(1, Math.max(0, Number(j.confidence) || 0));
  if (kind === "enquiry" && (!items.length || items.some(i => !i.vehicle))) confidence = Math.min(confidence, 0.6);
  return { kind, items, confidence, sender: String(j.sender || "").slice(0, 120), notes: String(j.notes || "").slice(0, 500) };
}

const PRICES_SYSTEM = `A used auto parts supplier in the UAE sent prices in a WhatsApp group in reply to a garage's parts request. Match the prices to the numbered items of the request. Reply with JSON only:
{"isPrices":true,"lines":[{"item":1,"price":540,"note":""}],"extra":["lines of the message that match no item"],"confidence":0.0}
- price: the selling price in AED for one unit, as written ("540", "AED 540", "2k" = 2000). null when the line has no price.
- note: a short remark the supplier added for that item, e.g. "NEED SAMPLE", "not available", "original", "2 days". Empty if none.
- Match by meaning, not exact words: "A.c blower assym" = "A.c blower assembly", "Alternantor" = "Alternator". Each item at most once; leave out items the message doesn't mention.
- isPrices false when the message is a question, a greeting or chat with no prices.
- Never invent a price. confidence = how sure you are every price is on the right item.`;

// items: [{ vehicle, part, qty }] → { isPrices, lines: [{ item (1-based), price|null, note }], extra, confidence }
export async function readPrices({ items, message }) {
  const list = items.map((it, i) => `${i + 1}. ${[it.vehicle, it.part].filter(Boolean).join(" – ")} (qty ${it.qty || 1})`).join("\n");
  const j = parse(await call(PRICES_SYSTEM, `Items:\n${list}\n\nSupplier's message:\n${message}`, 1200));
  const seen = new Set();
  const lines = (Array.isArray(j.lines) ? j.lines : []).map(l => ({
    item: Math.round(Number(l?.item)), price: Number.isFinite(Number(l?.price)) && Number(l.price) > 0 ? Math.round(Number(l.price) * 100) / 100 : null,
    note: String(l?.note || "").slice(0, 120),
  })).filter(l => l.item >= 1 && l.item <= items.length && !seen.has(l.item) && seen.add(l.item) && (l.price || l.note));
  return {
    isPrices: !!j.isPrices && lines.length > 0, lines,
    extra: (Array.isArray(j.extra) ? j.extra : []).map(x => String(x).slice(0, 200)).slice(0, 20),
    confidence: Math.min(1, Math.max(0, Number(j.confidence) || 0)),
  };
}
