// Runs the API on its own (used by `npm test` and `npm run dev` in api/).
// In production the API runs inside the web service: see web/server.mjs.
import { connect } from "./db.js";
import { createApi } from "./app.js";

const PORT = Number(process.env.PORT || 4000);
await connect();
createApi().listen(PORT, () => console.log(`A2Z Auto Parts API listening on port ${PORT}`));
