// Forwards /api/* to the Node API service, so the browser only ever talks to this site.
// API_URL is read when the request arrives, so it can be changed on Render without a rebuild.
export const dynamic = "force-dynamic";

const PASS_REQ = ["cookie", "content-type", "accept", "user-agent"];
const PASS_RES = ["content-type", "content-disposition", "cache-control", "ratelimit", "ratelimit-policy", "retry-after"];

async function proxy(req, { params }) {
  const base = (process.env.API_URL || "http://localhost:4000").replace(/\/$/, "");
  const { path } = await params;
  const url = new URL(req.url);
  const target = `${base}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  for (const h of PASS_REQ) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  if (ip) headers.set("x-forwarded-for", ip);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  let res;
  try {
    res = await fetch(target, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined, redirect: "manual", cache: "no-store" });
  } catch {
    return Response.json({ error: "The server is starting up or can't be reached. Wait a moment and try again." }, { status: 502 });
  }
  const out = new Headers();
  for (const h of PASS_RES) { const v = res.headers.get(h); if (v) out.set(h, v); }
  for (const c of res.headers.getSetCookie?.() || []) out.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
