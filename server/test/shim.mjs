// Локальная замена D1 и KV для проверки сервера на Node (node:sqlite), без Cloudflare.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeDB(schemaPath) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; }
  });
  return {
    prepare: (sql) => wrap(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    raw: db
  };
}

export function makeKV() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, m };
}
