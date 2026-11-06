// Minimal in-memory stand-in for the parts of the MongoDB driver this API uses.
// Only for local tests (MONGODB_URI=memory). Production always uses real MongoDB.
const clone = v => (v === undefined ? v : structuredClone(v));

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), doc);
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date) && Object.keys(cond).some(x => x.startsWith("$"))) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === "$in") return arg.includes(v);
        if (op === "$ne") return v !== arg;
        if (op === "$exists") return arg ? v !== undefined : v === undefined;
        if (op === "$gt") return v > arg;
        if (op === "$lt") return v < arg;
        if (op === "$gte") return v >= arg;
        if (op === "$lte") return v <= arg;
        if (op === "$nin") return !arg.includes(v);
        throw new Error("fake-mongo: unsupported operator " + op);
      });
    }
    return v === cond;
  });
}
function applyUpdate(doc, update, inserting = false) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [k, val] of Object.entries(fields)) {
      if (op === "$setOnInsert") { if (inserting) doc[k] = clone(val); }
      else if (op === "$set") doc[k] = clone(val);
      else if (op === "$inc") doc[k] = (doc[k] || 0) + val;
      else if (op === "$push") (doc[k] = doc[k] || []).push(clone(val));
      else if (op === "$unset") delete doc[k];
      else throw new Error("fake-mongo: unsupported update " + op);
    }
  }
  return doc;
}

function collection(store, uniques) {
  const check = (doc, skipId) => {
    for (const f of uniques) if (doc[f] != null && store.some(d => d._id !== skipId && d[f] === doc[f])) {
      const e = new Error("E11000 duplicate key"); e.code = 11000; throw e;
    }
  };
  return {
    async createIndex(spec, opts = {}) { if (opts.unique) uniques.push(Object.keys(spec)[0]); },
    find(filter) {
      let rows = store.filter(d => matches(d, filter)), sortSpec = null, lim = 0;
      const cur = {
        sort(s) { sortSpec = s; return cur; },
        limit(n) { lim = n; return cur; },
        project() { return cur; },
        async toArray() {
          if (sortSpec) { const [[f, dir]] = Object.entries(sortSpec); rows = rows.slice().sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * dir); }
          return (lim ? rows.slice(0, lim) : rows).map(clone);
        },
      };
      return cur;
    },
    async findOne(filter) { const d = store.find(x => matches(x, filter)); return d ? clone(d) : null; },
    async countDocuments(filter) { return store.filter(x => matches(x, filter)).length; },
    async insertOne(doc) {
      if (store.some(d => d._id === doc._id)) { const e = new Error("E11000 duplicate key _id"); e.code = 11000; throw e; }
      check(doc); store.push(clone(doc)); return { insertedId: doc._id };
    },
    async insertMany(docs) { for (const d of docs) await this.insertOne(d); return { insertedCount: docs.length }; },
    async replaceOne(filter, doc, opts = {}) {
      const i = store.findIndex(x => matches(x, filter));
      if (i < 0) { if (opts.upsert) { store.push(clone(Object.assign({ _id: filter._id }, doc))); return { upsertedCount: 1 }; } return { matchedCount: 0 }; }
      check(doc, store[i]._id); store[i] = clone(Object.assign({ _id: store[i]._id }, doc)); return { matchedCount: 1 };
    },
    async updateOne(filter, update, opts = {}) {
      let d = store.find(x => matches(x, filter));
      const inserting = !d;
      if (!d) { if (!opts.upsert) return { matchedCount: 0 }; d = Object.assign({}, filter); store.push(d); }
      applyUpdate(d, update, inserting); return { matchedCount: 1 };
    },
    async updateMany(filter, update) {
      const rows = store.filter(x => matches(x, filter));
      rows.forEach(d => applyUpdate(d, update)); return { matchedCount: rows.length };
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      let d = store.find(x => matches(x, filter));
      const before = d ? clone(d) : null;
      const inserting = !d;
      if (!d) { if (!opts.upsert) return null; d = Object.fromEntries(Object.entries(filter).filter(([, v]) => !(v && typeof v === "object"))); store.push(d); }
      applyUpdate(d, update, inserting);
      return opts.returnDocument === "after" ? clone(d) : before;
    },
    async deleteOne(filter) { const i = store.findIndex(x => matches(x, filter)); if (i >= 0) store.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
    async deleteMany(filter) { let n = 0; for (let i = store.length - 1; i >= 0; i--) if (matches(store[i], filter)) { store.splice(i, 1); n++; } return { deletedCount: n }; },
  };
}

export function memoryDb() {
  const data = {};
  return { collection(name) { if (!data[name]) data[name] = collection([], []); return data[name]; } };
}
