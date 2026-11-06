// The WhatsApp service: the listener and the worker in one process (one Render background worker).
// WA_ROLE=listener or WA_ROLE=worker runs just one half, if you ever want them apart.
import { connect } from "../../api/src/db.js";
import { startProcessor } from "../../api/src/wa/processor.js";

const role = process.env.WA_ROLE || "all";
await connect();

if (role === "all" || role === "listener") {
  const { startListener, heartbeat, startOutbox } = await import("./listener.js");
  heartbeat();
  startOutbox();
  await startListener();
  console.log("[wa] listener started");
}
if (role === "all" || role === "worker") {
  startProcessor();
  console.log("[wa] worker started");
}
