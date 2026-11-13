// Viperr · Сообщество: аккаунты (ник + пароль + код восстановления), предложения к «Истории трека»,
// проверка в Telegram и «заметки фанатов» (overlay), которые приложение накладывает на stories.json.
//
// Пароль до сервера не доходит: телефон считает PBKDF2 и присылает 64 hex-символа (pw). Сервер хранит HMAC(pepper, pw),
// pepper создаётся при первом обращении и лежит в таблице meta. Токен сессии хранится только на телефоне, в базе его SHA-256.
// Все маршруты отвечают JSON. Если базы D1 нет, маршруты отвечают {error:"off"} и остальной сервер работает как раньше.

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SECS = ["written", "lyrics", "credits", "live", "quotes", "other"];
const SEC_NAME = {
  written: "Written & recorded", lyrics: "What the lyrics mean", credits: "Who played on it",
  live: "First live performance", quotes: "Interview quotes", other: "Something else"
};
const DAY = 86400, SESSION_TTL = 90 * DAY;
const enc = new TextEncoder();

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** HMAC-ключ («перец») лежит в таблице meta: D1 согласована сразу, в отличие от KV, где новый ключ расходится по миру до минуты. */
const macKeys = new WeakMap();
async function mac(env, msg) {
  let k = macKeys.get(env.DB);
  if (!k) {
    k = (async () => {
      let r = await env.DB.prepare("SELECT v FROM meta WHERE k='pepper'").first();
      if (!r) {
        await env.DB.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('pepper',?)").bind(hex(crypto.getRandomValues(new Uint8Array(32)))).run();
        r = await env.DB.prepare("SELECT v FROM meta WHERE k='pepper'").first();
      }
      return crypto.subtle.importKey("raw", enc.encode(r.v), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    macKeys.set(env.DB, k);
    k.catch(() => macKeys.delete(env.DB));
  }
  return hex(await crypto.subtle.sign("HMAC", await k, enc.encode(msg)));
}
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Код восстановления: 20 символов без похожих (0/O, 1/I/L), подряд как XXXXX-XXXXX-XXXXX-XXXXX. */
function recoveryCode() {
  let s = "";
  while (s.length < 20) {
    for (const x of crypto.getRandomValues(new Uint8Array(32))) {
      if (x < 248 && s.length < 20) s += ALPHA[x % ALPHA.length];
    }
  }
  return s.match(/.{5}/g).join("-");
}
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Счётчик с окном: true, если лимит уже исчерпан (текущее обращение тоже считается). */
async function hit(env, key, max, ttl) {
  const t = now();
  const r = await env.DB.prepare("SELECT n, until FROM throttle WHERE k=?").bind(key).first();
  if (!r || r.until <= t) {
    await env.DB.prepare("INSERT OR REPLACE INTO throttle(k,n,until) VALUES(?,?,?)").bind(key, 1, t + ttl).run();
    return false;
  }
  if (r.n >= max) return true;
  await env.DB.prepare("UPDATE throttle SET n=n+1 WHERE k=?").bind(key).run();
  return false;
}

async function body(req, max = 8192) {
  const raw = await req.text();
  if (raw.length > max) return null;
  try { const o = JSON.parse(raw); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
}

/** Текст пользователя: без управляющих и «невидимых» символов (в том числе подмены направления), не длиннее max символов. */
function clean(v, max) {
  let s = typeof v === "string" ? v : "";
  s = s.normalize("NFC").replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();
  const a = [...s];
  return a.length > max ? a.slice(0, max).join("").trim() : s;
}

const NICK_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{1,18}[\p{L}\p{N}]$/u;
const nickOk = (n) => typeof n === "string" && NICK_RE.test(n) && !/[_.-]{2}/.test(n);
function reserved(lc) {
  const f = lc.replace(/[^\p{L}\p{N}]/gu, "");
  return /admin|moderator|viperr|official|support|staff|system|kaiangel|9mice/.test(f) || ["root", "mod", "null", "undefined"].includes(f);
}
const userJson = (u) => ({ id: u.id, nick: u.nick, role: u.role });

async function newSession(env, uid) {
  const tok = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await env.DB.prepare("INSERT INTO sessions(th,user_id,created,expires) VALUES(?,?,?,?)").bind(await sha256(tok), uid, t, t + SESSION_TTL).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND th NOT IN (SELECT th FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 6)").bind(uid, uid).run();
  return tok;
}

async function authed(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([A-Za-z0-9_-]{40,50})$/);
  if (!m) return null;
  const th = await sha256(m[1]);
  const r = await env.DB.prepare(
    "SELECT u.id, u.nick, u.role, u.banned, u.created, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.th=?"
  ).bind(th).first();
  const t = now();
  if (!r || r.expires <= t) return null;
  if (r.expires - t < SESSION_TTL - DAY) await env.DB.prepare("UPDATE sessions SET expires=? WHERE th=?").bind(t + SESSION_TTL, th).run();
  r.th = th;
  return r;
}

// ───────── Аккаунты ─────────

async function register(req, env, ip) {
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const nick = typeof b.nick === "string" ? b.nick.normalize("NFKC").trim() : "";
  const pw = typeof b.pw === "string" ? b.pw.toLowerCase() : "";
  if (!nickOk(nick) || reserved(nick.toLowerCase())) return J({ error: "nick_bad" }, 400);
  if (!/^[0-9a-f]{64}$/.test(pw)) return J({ error: "pw_bad" }, 400);
  const lc = nick.toLowerCase();
  if (await env.DB.prepare("SELECT 1 AS x FROM users WHERE nick_lc=?").bind(lc).first()) return J({ error: "nick_taken" }, 409);
  if (await hit(env, "reg:ip:" + ip, 10, DAY)) return J({ error: "rate" }, 429);
  if (await hit(env, "reg:all:" + Math.floor(now() / DAY), 200, DAY)) return J({ error: "cap" }, 429);
  const code = recoveryCode(), t = now();
  let id;
  try {
    const r = await env.DB.prepare("INSERT INTO users(nick,nick_lc,pw,rec,created,last_seen) VALUES(?,?,?,?,?,?)")
      .bind(nick, lc, await mac(env, "pw:" + pw), await mac(env, "rec:" + normCode(code)), t, t).run();
    id = r.meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || e))) return J({ error: "nick_taken" }, 409);
    throw e;
  }
  if (Math.random() < 0.05) {
    await env.DB.prepare("DELETE FROM throttle WHERE until < ?").bind(t).run();
    await env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(t).run();
  }
  return J({ token: await newSession(env, id), id, nick, role: "user", recovery: code });
}

async function login(req, env, ip) {
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const nick = typeof b.nick === "string" ? b.nick.normalize("NFKC").trim().toLowerCase() : "";
  const pw = typeof b.pw === "string" ? b.pw.toLowerCase() : "";
  if (!nick || nick.length > 40 || !/^[0-9a-f]{64}$/.test(pw)) return J({ error: "creds" }, 401);
  if (await hit(env, "login:ip:" + ip, 40, 600)) return J({ error: "rate" }, 429);
  const u = await env.DB.prepare("SELECT * FROM users WHERE nick_lc=?").bind(nick).first();
  const t = now();
  if (u && u.locked_until > t) return J({ error: "locked", retry: u.locked_until - t }, 429);
  const h = await mac(env, "pw:" + pw);
  if (!u || !same(u.pw, h)) {
    if (u) {
      const f = u.fails + 1;
      await env.DB.prepare("UPDATE users SET fails=?, locked_until=? WHERE id=?").bind(f >= 5 ? 0 : f, f >= 5 ? t + 900 : 0, u.id).run();
    }
    return J({ error: "creds" }, 401);
  }
  if (u.banned) return J({ error: "banned" }, 403);
  await env.DB.prepare("UPDATE users SET fails=0, locked_until=0, last_seen=? WHERE id=?").bind(t, u.id).run();
  return J({ token: await newSession(env, u.id), ...userJson(u) });
}

/** Новый пароль по коду восстановления; старые сессии закрываются, код заменяется новым. */
async function reset(req, env, ip) {
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const nick = typeof b.nick === "string" ? b.nick.normalize("NFKC").trim().toLowerCase() : "";
  const code = normCode(b.code);
  const pw = typeof b.pw === "string" ? b.pw.toLowerCase() : "";
  if (!nick || nick.length > 40 || code.length !== 20 || !/^[0-9a-f]{64}$/.test(pw)) return J({ error: "creds" }, 401);
  if (await hit(env, "reset:ip:" + ip, 10, 3600)) return J({ error: "rate" }, 429);
  if (await hit(env, "reset:n:" + nick, 5, 3600)) return J({ error: "rate" }, 429);
  const u = await env.DB.prepare("SELECT * FROM users WHERE nick_lc=?").bind(nick).first();
  const h = await mac(env, "rec:" + code);
  if (!u || !same(u.rec, h)) return J({ error: "creds" }, 401);
  if (u.banned) return J({ error: "banned" }, 403);
  const fresh = recoveryCode();
  await env.DB.prepare("UPDATE users SET pw=?, rec=?, fails=0, locked_until=0 WHERE id=?")
    .bind(await mac(env, "pw:" + pw), await mac(env, "rec:" + normCode(fresh)), u.id).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id).run();
  return J({ token: await newSession(env, u.id), ...userJson(u), recovery: fresh });
}

async function me(env, a) {
  const c = await env.DB.prepare(
    "SELECT SUM(status='pending') AS p, SUM(status='approved') AS a, SUM(status='rejected') AS r FROM suggestions WHERE user_id=?"
  ).bind(a.id).first();
  return J({ ...userJson(a), created: a.created, pending: c?.p || 0, approved: c?.a || 0, rejected: c?.r || 0 });
}

async function verifyPw(env, uid, pw) {
  if (typeof pw !== "string" || !/^[0-9a-f]{64}$/i.test(pw)) return false;
  const r = await env.DB.prepare("SELECT pw FROM users WHERE id=?").bind(uid).first();
  return !!r && same(r.pw, await mac(env, "pw:" + pw.toLowerCase()));
}

async function changePassword(req, env, a) {
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  if (await hit(env, "pwchg:" + a.id, 10, 3600)) return J({ error: "rate" }, 429);
  if (!(await verifyPw(env, a.id, b.old))) return J({ error: "creds" }, 401);
  const pw = typeof b.pw === "string" ? b.pw.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(pw)) return J({ error: "pw_bad" }, 400);
  await env.DB.prepare("UPDATE users SET pw=? WHERE id=?").bind(await mac(env, "pw:" + pw), a.id).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND th<>?").bind(a.id, a.th).run();
  return J({ ok: true });
}

async function deleteAccount(req, env, a) {
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  if (await hit(env, "pwchg:" + a.id, 10, 3600)) return J({ error: "rate" }, 429);
  if (!(await verifyPw(env, a.id, b.pw))) return J({ error: "creds" }, 401);
  const hadApproved = await env.DB.prepare("SELECT 1 AS x FROM suggestions WHERE user_id=? AND status='approved' LIMIT 1").bind(a.id).first();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM suggestions WHERE user_id=? AND status<>'approved'").bind(a.id),
    env.DB.prepare("UPDATE suggestions SET user_id=NULL, nick='' WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM users WHERE id=?").bind(a.id)
  ]);
  if (hadApproved) await rebuildOverlay(env);
  return J({ ok: true });
}

// ───────── Предложения ─────────

async function suggest(req, env, ip, ctx, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req, 16384); if (!b) return J({ error: "json" }, 400);
  const k = String(b.k || ""), sec = String(b.sec || "");
  if (!/^[\w.-]{1,40}:\d{1,3}$/.test(k)) return J({ error: "key" }, 400);
  if (!SECS.includes(sec)) return J({ error: "sec" }, 400);
  const text = clean(b.text, 1500);
  if ([...text].length < 10) return J({ error: "short" }, 400);
  const src = typeof b.src === "string" ? b.src.trim() : "";
  if (src && !/^https?:\/\/[^\s<>"]{4,290}$/i.test(src)) return J({ error: "src" }, 400);
  const tt = clean(b.tt, 120).replace(/\n/g, " "), ta = clean(b.ta, 120).replace(/\n/g, " ");
  const day = Math.floor(now() / DAY);
  const fresh = now() - a.created < 7 * DAY;
  if (await hit(env, `sug:u:${a.id}:${day}`, fresh ? 3 : 10, DAY)) return J({ error: "limit" }, 429);
  if (await hit(env, "sug:ip:" + ip + ":" + day, 40, DAY)) return J({ error: "rate" }, 429);
  if (await env.DB.prepare("SELECT 1 AS x FROM suggestions WHERE user_id=? AND k=? AND text=? AND status='pending'").bind(a.id, k, text).first()) {
    return J({ error: "dup" }, 409);
  }
  const r = await env.DB.prepare("INSERT INTO suggestions(user_id,nick,k,tt,ta,section,text,src,created) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(a.id, a.nick, k, tt, ta, sec, text, src, now()).run();
  const id = r.meta.last_row_id;
  const row = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(id).first();
  if (ctx && ctx.waitUntil) ctx.waitUntil(notify(env, row)); else await notify(env, row);
  return J({ ok: true, id, status: "pending" });
}

async function mine(env, a) {
  const rows = (await env.DB.prepare(
    "SELECT id,k,tt,ta,section,text,src,status,final_text,note,created,decided FROM suggestions WHERE user_id=? ORDER BY id DESC LIMIT 50"
  ).bind(a.id).all()).results || [];
  return J({
    items: rows.map(r => ({
      id: r.id, k: r.k, tt: r.tt, ta: r.ta, sec: r.section, text: r.final_text || r.text, src: r.src,
      status: r.status, note: r.note, created: r.created, decided: r.decided
    }))
  });
}

// ───────── Заметки фанатов (одобренные предложения) ─────────

async function rebuildOverlay(env) {
  const rows = (await env.DB.prepare(
    "SELECT id,k,section,text,final_text,src,nick,decided FROM suggestions WHERE status='approved' ORDER BY decided ASC, id ASC LIMIT 3000"
  ).all()).results || [];
  const notes = {};
  for (const r of rows) (notes[r.k] ||= []).push({ id: r.id, s: r.section, t: r.final_text || r.text, u: r.src || "", by: r.nick || "", at: r.decided });
  const prev = await env.DB.prepare("SELECT v FROM meta WHERE k='overlay_v'").first();
  const v = (parseInt(prev?.v || "0", 10) || 0) + 1;
  await env.DB.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('overlay',?)").bind(JSON.stringify(notes)).run();
  await env.DB.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('overlay_v',?)").bind(String(v)).run();
}

async function overlay(env, u) {
  const vr = await env.DB.prepare("SELECT v FROM meta WHERE k='overlay_v'").first();
  const v = parseInt(vr?.v || "0", 10) || 0;
  if (parseInt(u.searchParams.get("v") ?? "-1", 10) === v) return J({ v, same: true });
  const o = await env.DB.prepare("SELECT v FROM meta WHERE k='overlay'").first();
  return new Response(`{"v":${v},"notes":${o?.v || "{}"}}`, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// ───────── Telegram: проверка предложений ─────────

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const admins = (env) => String(env.ADMIN_TG_ID || "").split(/[,\s]+/).filter(Boolean);

async function tg(env, method, payload) {
  if (!env.TG_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    return await r.json();
  } catch { return null; }
}

function card(s) {
  const track = [s.ta, s.tt].filter(Boolean).map(esc).join(" — ");
  let t = `📝 #${s.id} · ${esc(s.nick || "—")}\n🎵 ${track ? track + " " : ""}<code>${esc(s.k)}</code>\n📂 ${esc(SEC_NAME[s.section] || s.section)}\n\n${esc(s.final_text || s.text)}`;
  if (s.src) t += `\n\n🔗 ${esc(s.src)}`;
  if (s.status === "approved") t += "\n\n✅ <b>Approved</b>";
  else if (s.status === "rejected") t += "\n\n❌ <b>Rejected</b>" + (s.note ? ": " + esc(s.note) : "");
  else t += "\n\n<i>Reply with new text to edit and approve, or “/no reason” to reject with a note.</i>";
  return t;
}
const keyboard = (s) => ({
  inline_keyboard: [
    [{ text: "✅ Approve", callback_data: "a:" + s.id }, { text: "❌ Reject", callback_data: "r:" + s.id }],
    ...(s.user_id ? [[{ text: "🚫 Ban author", callback_data: "b:" + s.user_id }]] : [])
  ]
});

async function notify(env, s) {
  for (const id of admins(env)) {
    await tg(env, "sendMessage", { chat_id: id, text: card(s), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard(s) });
  }
}

async function decide(env, id, status, extra = {}) {
  const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(id).first();
  if (!s) return null;
  if (s.status !== "pending") return { s, already: true };
  const fin = extra.final ?? "", note = extra.note ?? "";
  await env.DB.prepare("UPDATE suggestions SET status=?, final_text=?, note=?, decided=? WHERE id=?").bind(status, fin, note, now(), id).run();
  if (status === "approved") await rebuildOverlay(env);
  return { s: { ...s, status, final_text: fin, note } };
}

async function banUser(env, uid, on) {
  await env.DB.prepare("UPDATE users SET banned=? WHERE id=?").bind(on ? 1 : 0, uid).run();
  if (on) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(uid).run();
    await env.DB.prepare("UPDATE suggestions SET status='rejected', note='banned', decided=? WHERE user_id=? AND status='pending'").bind(now(), uid).run();
  }
}

async function handleCallback(env, cq) {
  const ok = admins(env).includes(String(cq.from?.id));
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (!ok) return answer("Not allowed");
  const [op, raw] = String(cq.data || "").split(":");
  const n = parseInt(raw, 10);
  const msg = cq.message;
  const refresh = (s) => msg && tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: card(s), parse_mode: "HTML", disable_web_page_preview: true });
  if (op === "a" || op === "r") {
    const r = await decide(env, n, op === "a" ? "approved" : "rejected");
    if (!r) return answer("Not found");
    await refresh(r.s);
    return answer(r.already ? "Already " + r.s.status : op === "a" ? "Approved" : "Rejected");
  }
  if (op === "b") {
    await banUser(env, n, true);
    return answer("Author banned");
  }
  return answer("?");
}

async function handleMessage(env, m) {
  if (!m || !m.from) return;
  const uid = String(m.from.id), isAdmin = admins(env).includes(uid);
  const text = String(m.text || "").trim();
  const say = (t, extra = {}) => tg(env, "sendMessage", { chat_id: m.chat.id, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  if (/^\/start\b/i.test(text)) {
    return say(`Your Telegram ID: <code>${uid}</code>\n` + (isAdmin ? "You are an admin. /help lists the commands."
      : "This is the moderation bot for Viperr Music. To become an admin, put this ID into the ADMIN_TG_ID secret and redeploy."));
  }
  if (!isAdmin || !text) return;
  // Ответ на карточку: новый текст = «исправить и одобрить», «/no причина» = отклонить
  const replied = String(m.reply_to_message?.text || "");
  const sid = parseInt((replied.match(/^📝 #(\d+)/) || [])[1], 10);
  if (sid && (!text.startsWith("/") || /^\/no\b/i.test(text))) {
    const reject = /^\/no\b/i.test(text);
    const r = reject ? await decide(env, sid, "rejected", { note: clean(text.replace(/^\/no\s*/i, ""), 200) })
      : await decide(env, sid, "approved", { final: clean(text, 1500) });
    if (!r) return say("Suggestion not found.");
    if (r.already) return say(`#${sid} is already ${r.s.status}.`);
    await tg(env, "editMessageText", { chat_id: m.chat.id, message_id: m.reply_to_message.message_id, text: card(r.s), parse_mode: "HTML", disable_web_page_preview: true });
    return say(reject ? "Rejected." : "Approved with your edit.");
  }
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim().toLowerCase();
  const findUser = () => env.DB.prepare("SELECT * FROM users WHERE nick_lc=?").bind(arg).first();
  switch (cmd.toLowerCase().replace(/@\w+$/, "")) {
    case "/help":
      return say("/pending — suggestions waiting for review\n/stats — counters\n/user nick — account info\n/ban nick · /unban nick\n\nOn a suggestion card: Approve, Reject, or reply with new text to edit and approve (“/no reason” rejects with a note).");
    case "/stats": {
      const c = await env.DB.prepare("SELECT SUM(status='pending') AS p, SUM(status='approved') AS a, SUM(status='rejected') AS r FROM suggestions").first();
      const u = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(banned) AS b FROM users").first();
      return say(`Users: ${u?.n || 0} (banned ${u?.b || 0})\nPending: ${c?.p || 0} · Approved: ${c?.a || 0} · Rejected: ${c?.r || 0}`);
    }
    case "/pending": {
      const rows = (await env.DB.prepare("SELECT * FROM suggestions WHERE status='pending' ORDER BY id ASC LIMIT 10").all()).results || [];
      if (!rows.length) return say("Nothing is waiting for review.");
      for (const s of rows) await say(card(s), { reply_markup: keyboard(s) });
      return;
    }
    case "/user": {
      const u = await findUser();
      if (!u) return say("No such nickname.");
      const c = await env.DB.prepare("SELECT SUM(status='pending') AS p, SUM(status='approved') AS a, SUM(status='rejected') AS r FROM suggestions WHERE user_id=?").bind(u.id).first();
      return say(`${esc(u.nick)} (#${u.id})${u.banned ? " · banned" : ""}\nJoined: ${new Date(u.created * 1000).toISOString().slice(0, 10)}\nPending ${c?.p || 0} · Approved ${c?.a || 0} · Rejected ${c?.r || 0}`);
    }
    case "/ban": case "/unban": {
      const u = await findUser();
      if (!u) return say("No such nickname.");
      const on = cmd.toLowerCase().startsWith("/ban");
      await banUser(env, u.id, on);
      return say(`${esc(u.nick)} is ${on ? "banned" : "unbanned"}.`);
    }
    default: return;
  }
}

async function tgHook(req, env) {
  if (!env.TG_BOT_TOKEN) return J({ ok: true });
  const want = await sha256("viperr-tg:" + env.TG_BOT_TOKEN);
  if (!same(req.headers.get("x-telegram-bot-api-secret-token") || "", want)) return J({ error: "no" }, 401);
  let up; try { up = await req.json(); } catch { return J({ ok: true }); }
  try {
    if (up.callback_query) await handleCallback(env, up.callback_query);
    else if (up.message) await handleMessage(env, up.message);
  } catch (e) { /* Telegram не должен ретраить из-за наших ошибок */ }
  return J({ ok: true });
}

// ───────── Маршруты ─────────

/** Возвращает Response для маршрутов сообщества или null, если путь не наш. */
export async function community(req, env, ctx) {
  const u = new URL(req.url), p = u.pathname, m = req.method;
  const ours = p.startsWith("/a/") || p === "/s" || p === "/s/mine" || p === "/tg" || p === "/stories/overlay";
  if (!ours) return null;
  if (!env.DB) return p === "/tg" ? J({ ok: true }) : J({ error: "off" }, 503);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  try {
    if (p === "/tg" && m === "POST") return await tgHook(req, env);
    if (p === "/stories/overlay" && m === "GET") return await overlay(env, u);
    if (m !== "POST" && m !== "GET") return J({ error: "method" }, 405);
    if (m === "POST" && p === "/a/register") return await register(req, env, ip);
    if (m === "POST" && p === "/a/login") return await login(req, env, ip);
    if (m === "POST" && p === "/a/reset") return await reset(req, env, ip);
    const a = await authed(req, env);
    if (!a) return J({ error: "auth" }, 401);
    if (p === "/a/me" && m === "GET") return a.banned ? J({ error: "banned" }, 403) : await me(env, a);
    if (p === "/a/logout" && m === "POST") { await env.DB.prepare("DELETE FROM sessions WHERE th=?").bind(a.th).run(); return J({ ok: true }); }
    if (p === "/a/password" && m === "POST") return await changePassword(req, env, a);
    if (p === "/a/delete" && m === "POST") return await deleteAccount(req, env, a);
    if (p === "/s" && m === "POST") return await suggest(req, env, ip, ctx, a);
    if (p === "/s/mine" && m === "GET") return await mine(env, a);
    return J({ error: "none" }, 404);
  } catch (e) {
    return J({ error: "server" }, 500);
  }
}
