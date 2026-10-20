// Viperr · Совместимость: код на 24 часа хранит список лучших треков, больше ничего.
const TTL = 86400, ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function limited(env, ip, kind, max) {
  const k = `rl:${kind}:${ip}`;
  const n = parseInt((await env.KV.get(k)) || "0", 10);
  if (n >= max) return true;
  await env.KV.put(k, String(n + 1), { expirationTtl: 3600 });
  return false;
}
const mkCode = () => { let s = ""; const b = crypto.getRandomValues(new Uint8Array(4)); for (const x of b) s += ALPHA[x % ALPHA.length]; return s; };

export default {
  async fetch(req, env) {
    const u = new URL(req.url), ip = req.headers.get("cf-connecting-ip") || "0";
    if (req.method === "POST" && u.pathname === "/c") {
      if (await limited(env, ip, "post", 20)) return J({ error: "rate" }, 429);
      const len = parseInt(req.headers.get("content-length") || "0", 10);
      if (len > 8192) return J({ error: "big" }, 413);
      let b; try { b = await req.json(); } catch { return J({ error: "json" }, 400); }
      const t = Array.isArray(b.t) ? b.t.filter(x => typeof x === "string" && /^[\w.-]{1,40}:\d{1,3}$/.test(x)).slice(0, 200) : [];
      if (t.length < 5) return J({ error: "few" }, 400);
      const n = typeof b.n === "string" ? b.n.slice(0, 24) : "";
      for (let i = 0; i < 6; i++) {
        const c = mkCode();
        if (!(await env.KV.get("c:" + c))) {
          await env.KV.put("c:" + c, JSON.stringify({ t, n }), { expirationTtl: TTL });
          return J({ code: "VPR-" + c, ttl: TTL });
        }
      }
      return J({ error: "busy" }, 503);
    }
    const m = u.pathname.match(/^\/c\/(?:VPR-)?([A-Z0-9]{4})$/i);
    if (req.method === "GET" && m) {
      if (await limited(env, ip, "get", 60)) return J({ error: "rate" }, 429);
      const v = await env.KV.get("c:" + m[1].toUpperCase());
      if (!v) return J({ error: "none" }, 404);
      return new Response(v, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return J({ ok: true });
  }
};
