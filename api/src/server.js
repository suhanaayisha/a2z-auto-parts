// A2Z Auto Parts API
import express from "express";
import helmet from "helmet";
import { connect } from "./db.js";
import { loadUser, requireUser, authRoutes, teamRoutes } from "./auth.js";
import { records } from "./routes/records.js";
import { invoices } from "./routes/invoices.js";
import { extras } from "./routes/extras.js";

const PORT = Number(process.env.PORT || 4000);
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));

app.get("/healthz", (req, res) => res.send("ok"));

// Changes must come as JSON (or a photo), which a form on another website cannot send.
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const type = String(req.headers["content-type"] || "");
  if (type.startsWith("application/json") || (req.path === "/photos" && type.startsWith("image/"))) return next();
  if (!req.headers["content-length"] || req.headers["content-length"] === "0") return next();
  res.status(415).json({ error: "Send JSON." });
});
app.use("/api", express.json({ limit: "2mb" }));
app.use("/api", loadUser);
app.use("/api/auth", authRoutes);
app.use("/api/team", teamRoutes);
app.use("/api", requireUser, records, invoices, extras);
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That is too large to upload." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request was not valid JSON." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again." });
});

await connect();
app.listen(PORT, () => console.log(`A2Z Auto Parts API listening on port ${PORT}`));
