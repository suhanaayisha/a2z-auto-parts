// Keeps the linked device's WhatsApp login in MongoDB (collection wa_auth) instead of files,
// because Render's disk is wiped on every deploy. Same shape as Baileys' useMultiFileAuthState.
import { BufferJSON, initAuthCreds, proto } from "baileys";

export async function useMongoAuthState(coll) {
  const read = async id => {
    const d = await coll.findOne({ _id: id });
    return d ? JSON.parse(d.v, BufferJSON.reviver) : null;
  };
  const write = (id, value) => coll.replaceOne({ _id: id }, { v: JSON.stringify(value, BufferJSON.replacer) }, { upsert: true });
  const remove = id => coll.deleteOne({ _id: id });

  const creds = (await read("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async data => {
          const tasks = [];
          for (const category in data) for (const id in data[category]) {
            const value = data[category][id];
            tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write("creds", creds),
    clear: () => coll.deleteMany({}),
  };
}
