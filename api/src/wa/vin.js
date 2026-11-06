// VINs in WhatsApp messages → make, model, year and engine, so the reader doesn't have to guess.
// Uses the free US government decoder (NHTSA vPIC). If it can't be reached, the model year is still
// worked out from the VIN itself (10th character), and marked as not confirmed.
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789"; // 1980–2009, then the cycle repeats from 2010

let stub = null;
export function setVinStub(fn) { stub = fn; }

// 17 characters, no I, O or Q, with both letters and digits (so long words and phone numbers don't match).
export function findVins(text) {
  const out = new Set();
  for (const m of String(text || "").toUpperCase().matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)) {
    if (/\d/.test(m[0]) && /[A-Z]/.test(m[0])) out.add(m[0]);
  }
  return [...out].slice(0, 3);
}

// Model year from the VIN alone. The 7th character tells the two 30-year cycles apart
// (a letter means 2010 or later). Reliable for North American–standard VINs, which most GCC imports use.
export function yearFromVin(vin) {
  const i = YEAR_CODES.indexOf(vin[9]);
  if (i < 0) return null;
  return 1980 + i + (/[A-Z]/.test(vin[6]) ? 30 : 0);
}

const title = s => String(s || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bBmw\b/, "BMW").replace(/\bGmc\b/, "GMC");

export async function decodeVin(vin) {
  if (stub) return stub(vin);
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const v = (await r.json())?.Results?.[0] || {};
      if (v.Make && v.Model) {
        const engine = [v.DisplacementL && Number(v.DisplacementL).toFixed(1) + "L", v.EngineCylinders && v.EngineCylinders + "-cyl", v.FuelTypePrimary && !/gasoline/i.test(v.FuelTypePrimary) ? v.FuelTypePrimary : ""].filter(Boolean).join(" ");
        return { vin, year: Number(v.ModelYear) || yearFromVin(vin), make: title(v.Make), model: v.Model, trim: v.Trim || "", engine, confirmed: true };
      }
    }
  } catch { /* fall through to the offline year */ }
  return { vin, year: yearFromVin(vin), make: "", model: "", trim: "", engine: "", confirmed: false };
}

// One line per VIN, for the reader and for the enquiry notes.
export function vinLine(d) {
  if (d.confirmed) return `VIN ${d.vin}: ${[d.year, d.make, d.model, d.trim].filter(Boolean).join(" ")}${d.engine ? ", " + d.engine : ""}`;
  return `VIN ${d.vin}: model year ${d.year ? "probably " + d.year : "unknown"} (make and model not confirmed)`;
}
