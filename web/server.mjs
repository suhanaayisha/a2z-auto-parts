// One server for the whole app: /api/* and /healthz go to the Express API in ../api,
// everything else goes to Next.js. Runs as a single Render service.
import http from "node:http";
import { fileURLToPath } from "node:url";
import next from "next";
import { connect } from "../api/src/db.js";
import { createApi } from "../api/src/app.js";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const nextApp = next({ dev, dir: fileURLToPath(new URL(".", import.meta.url)), port });
const handle = nextApp.getRequestHandler();
const api = createApi();

await Promise.all([connect(), nextApp.prepare()]);

http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/healthz" || path === "/api" || path.startsWith("/api/")) return api(req, res);
  handle(req, res);
}).listen(port, () => console.log(`A2Z Auto Parts running on http://localhost:${port}`));
