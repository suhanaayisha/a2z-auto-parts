// Voice notes → text. Uses OpenAI (Whisper) when OPENAI_API_KEY is set, otherwise Deepgram when
// DEEPGRAM_API_KEY is set. Whisper handles Arabic, Urdu, Hindi and Malayalam well, so it is preferred.
// WhatsApp voice notes are Ogg/Opus, which both accept as they are.
let stub = null;
export function setTranscribeStub(fn) { stub = fn; }
export const transcribeEnabled = () => !!(stub || process.env.OPENAI_API_KEY || process.env.DEEPGRAM_API_KEY);

export async function transcribe(data, mime = "audio/ogg") {
  if (stub) return stub(data, mime);
  const type = mime.split(";")[0] || "audio/ogg";
  if (process.env.OPENAI_API_KEY) {
    const form = new FormData();
    form.append("file", new Blob([data], { type }), "voice.ogg");
    form.append("model", process.env.TRANSCRIBE_MODEL || "whisper-1");
    form.append("prompt", "Car parts request from a UAE garage. Toyota, Nissan, Lexus, Land Cruiser, Patrol, headlamp, bumper, LH, RH.");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(60e3),
    });
    if (!r.ok) throw new Error(`OpenAI transcription failed (${r.status})`);
    return String((await r.json()).text || "").trim();
  }
  if (process.env.DEEPGRAM_API_KEY) {
    const model = process.env.TRANSCRIBE_MODEL || "nova-3";
    const r = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&detect_language=true&smart_format=true`, {
      method: "POST", headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": type }, body: data, signal: AbortSignal.timeout(60e3),
    });
    if (!r.ok) throw new Error(`Deepgram transcription failed (${r.status})`);
    const j = await r.json();
    return String(j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
  }
  return null;
}
