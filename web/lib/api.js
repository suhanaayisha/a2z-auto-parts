// Calls the A2Z Auto Parts API through this app's /api proxy, so the login cookie stays on one site.
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof Blob) { opts.body = body; opts.headers["Content-Type"] = body.type; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  let res;
  try { res = await fetch("/api" + path, opts); }
  catch { throw new ApiError("Can't reach the server. Check your connection and try again.", 0); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/")) {
    window.location.href = "/login";
  }
  if (!res.ok) throw new ApiError(data.error || "Something went wrong. Try again.", res.status);
  return data;
}

// Shrinks a photo in the browser before upload so it stays small in the database.
export async function shrinkImage(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.82));
  } finally { URL.revokeObjectURL(url); }
}

export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
