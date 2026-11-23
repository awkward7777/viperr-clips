// Viperr · Сообщество: аккаунты (ник + пароль + код восстановления), предложения к «Истории трека»,
// проверка в Telegram и «заметки фанатов» (overlay), которые приложение накладывает на stories.json.
// К аккаунту относятся ещё облачная копия библиотеки (/a/backup) и «Входящие» автора (/a/inbox): решения модератора по его заметкам.
// Доверенные авторы (после трёх одобренных заметок новые без ссылок выходят сразу), голоса «Полезно» (/a/vote) и жалобы на заметки (/a/report).
// Публичные плейлисты с кодом (/a/pl, читать можно без аккаунта: /pl и /pl/КОД) и необязательный профиль (/a/profile, чужой: /u/ник).
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

/** Изредка убирает просроченные счётчики (в их ключах есть IP-адреса) и закончившиеся сессии, чтобы ничего не копилось. */
async function sweep(env, t) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM throttle WHERE until <= ?").bind(t),
    env.DB.prepare("DELETE FROM sessions WHERE expires <= ?").bind(t)
  ]);
}

/** Счётчик с окном: true, если лимит уже исчерпан (текущее обращение тоже считается). */
async function hit(env, key, max, ttl) {
  const t = now();
  const r = await env.DB.prepare("SELECT n, until FROM throttle WHERE k=?").bind(key).first();
  if (!r || r.until <= t) {
    await env.DB.prepare("INSERT OR REPLACE INTO throttle(k,n,until) VALUES(?,?,?)").bind(key, 1, t + ttl).run();
    if (Math.random() < 0.04) await sweep(env, t);
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

// ───────── Входящие: что стало с вашими заметками ─────────

const INBOX_KEEP = 100;

/** Кладёт запись во «Входящие» автора. Если автора уже нет (аккаунт удалён), молча ничего не делает. Хранит последние INBOX_KEEP. */
async function addInbox(env, uid, kind, s, text = "") {
  if (!uid) return;
  try {
    await env.DB.prepare("INSERT INTO inbox(user_id,kind,ref,k,tt,ta,text,created) VALUES(?,?,?,?,?,?,?,?)")
      .bind(uid, kind, s.id || 0, s.k || "", s.tt || "", s.ta || "", clean(text, 400), now()).run();
    await env.DB.prepare("DELETE FROM inbox WHERE user_id=? AND id NOT IN (SELECT id FROM inbox WHERE user_id=? ORDER BY id DESC LIMIT ?)")
      .bind(uid, uid, INBOX_KEEP).run();
  } catch { /* «Входящие» второстепенны: из-за них решение модератора не должно срываться */ }
}

async function inbox(env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const rows = (await env.DB.prepare("SELECT id,kind,ref,k,tt,ta,text,created,seen FROM inbox WHERE user_id=? ORDER BY id DESC LIMIT 50").bind(a.id).all()).results || [];
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE user_id=? AND seen=0").bind(a.id).first())?.n || 0;
  return J({
    unread: n,
    items: rows.map(r => ({ id: r.id, kind: r.kind, ref: r.ref, k: r.k, tt: r.tt, ta: r.ta, text: r.text, at: r.created, seen: !!r.seen }))
  });
}

/** Отмечает прочитанным всё до номера upTo (без него: всё). */
async function inboxSeen(req, env, a) {
  const b = (await body(req)) || {};
  const up = Number.isSafeInteger(b.upTo) ? b.upTo : Number.MAX_SAFE_INTEGER;
  await env.DB.prepare("UPDATE inbox SET seen=1 WHERE user_id=? AND seen=0 AND id<=?").bind(a.id, up).run();
  return J({ ok: true });
}

// ───────── Облачная копия библиотеки ─────────

const BACKUP_MAX = 1_500_000;           // байт; строка в D1 не должна быть больше 2 МБ
const BACKUP_POOL = 2_500_000_000;      // всего на сервере; когда место заканчивается, новые копии не принимаются
const INFO_KEYS = ["pl", "fav", "ph"];  // сколько плейлистов, лайков и своих обложек внутри

/** Только небольшие целые под известными именами: это подпись к копии в окне «Восстановить», а не данные. */
function cleanInfo(v) {
  const o = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of INFO_KEYS) {
      const n = Number(v[k]);
      if (Number.isFinite(n) && n >= 0) o[k] = Math.min(Math.floor(n), 1000000);
    }
  }
  return o;
}
const parseInfo = (s) => { try { return cleanInfo(JSON.parse(s)); } catch { return {}; } };
const backupMeta = (r) => ({ updated: r.updated, size: r.size, device: r.device, info: parseInfo(r.info) });

/** Сведения о копии; с full=1 ещё и сама копия (поле d). */
async function getBackup(env, a, full) {
  if (a.banned) return J({ error: "banned" }, 403);
  if (full && await hit(env, "bkget:" + a.id, 20, 3600)) return J({ error: "rate" }, 429);
  const r = await env.DB.prepare("SELECT " + (full ? "data," : "") + "size,info,device,updated FROM backups WHERE user_id=?").bind(a.id).first();
  if (!r) return J({ has: false });
  return J({ has: true, ...backupMeta(r), ...(full ? { d: r.data } : {}) });
}

/**
 * Сохраняет копию. base — «updated» той копии, на которую телефон опирался (0: телефон копию ещё не видел).
 * Если в облаке уже лежит другая копия, а force не передан, отвечаем 409 stale: приложение спросит человека,
 * чтобы с нового телефона пустая библиотека случайно не затёрла настоящую.
 */
async function putBackup(req, env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req, 4 * BACKUP_MAX); if (!b) return J({ error: "json" }, 400);
  const d = b.d;
  if (typeof d !== "string" || d.length < 20) return J({ error: "bad" }, 400);
  const size = enc.encode(d).length;
  if (size > BACKUP_MAX) return J({ error: "big" }, 413);
  let o; try { o = JSON.parse(d); } catch { return J({ error: "bad" }, 400); }
  if (!o || typeof o !== "object" || o.app !== "viperr-backup" || !o.prefs || typeof o.prefs !== "object") return J({ error: "bad" }, 400);
  const day = Math.floor(now() / DAY);
  if (await hit(env, `bk:${a.id}:${day}`, 30, DAY)) return J({ error: "limit" }, 429);
  const cur = await env.DB.prepare("SELECT updated FROM backups WHERE user_id=?").bind(a.id).first();
  if (cur && Number(b.base) !== cur.updated && b.force !== true) {
    const c = await env.DB.prepare("SELECT size,info,device,updated FROM backups WHERE user_id=?").bind(a.id).first();
    return J({ error: "stale", ...backupMeta(c) }, 409);
  }
  if (!cur) {
    if (await hit(env, "bk:new:" + day, 300, DAY)) return J({ error: "cap" }, 429);
    const used = (await env.DB.prepare("SELECT SUM(size) AS s FROM backups").first())?.s || 0;
    if (used + size > BACKUP_POOL) return J({ error: "cap" }, 429);
  }
  const t = Math.max(Date.now(), (cur?.updated || 0) + 1);
  const device = clean(b.device, 40).replace(/\n/g, " ");
  await env.DB.prepare("INSERT OR REPLACE INTO backups(user_id,data,size,info,device,updated) VALUES(?,?,?,?,?,?)")
    .bind(a.id, d, size, JSON.stringify(cleanInfo(b.info)), device, t).run();
  return J({ ok: true, updated: t, size, device });
}

async function delBackup(env, a) {
  await env.DB.prepare("DELETE FROM backups WHERE user_id=?").bind(a.id).run();
  return J({ ok: true });
}

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
  if (!nickOk(nick)) return J({ error: "nick_bad" }, 400);
  // error остаётся прежним ради старых версий приложения; новое приложение по "why" объясняет, что слово зарезервировано, а не «нужны цифры и знаки»
  if (reserved(nick.toLowerCase())) return J({ error: "nick_bad", why: "reserved" }, 400);
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
  const un = await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE user_id=? AND seen=0").bind(a.id).first();
  const bk = await env.DB.prepare("SELECT size,info,device,updated FROM backups WHERE user_id=?").bind(a.id).first();
  const tr = await trustOf(env, a.id, c?.a || 0);
  const pr = await env.DB.prepare("SELECT public, av FROM profiles WHERE user_id=?").bind(a.id).first();
  const pn = (await env.DB.prepare("SELECT COUNT(*) AS n FROM pubpl WHERE user_id=?").bind(a.id).first())?.n || 0;
  return J({
    ...userJson(a), created: a.created, pending: c?.p || 0, approved: c?.a || 0, rejected: c?.r || 0,
    unread: un?.n || 0, backup: bk ? backupMeta(bk) : null, trust: { state: tr.state, have: tr.have, need: tr.need },
    prof: { public: !!pr?.public, av: pr?.av || 0 }, pl: pn
  });
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
  const hadVotes = await env.DB.prepare("SELECT 1 AS x FROM votes WHERE user_id=? LIMIT 1").bind(a.id).first();
  const hadSaves = await env.DB.prepare("SELECT 1 AS x FROM pl_saves WHERE user_id=? LIMIT 1").bind(a.id).first();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM backups WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM inbox WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM reports WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM trust WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM votes WHERE user_id=?").bind(a.id),
    // счётчики голосов пересобираются целиком (редкая операция), чтобы они сошлись с оставшимися голосами
    ...(hadVotes ? [env.DB.prepare("DELETE FROM vote_n"), env.DB.prepare("INSERT INTO vote_n(sid,n) SELECT sid, COUNT(*) FROM votes GROUP BY sid")] : []),
    // публичные плейлисты уходят вместе с аккаунтом (с их сохранениями, жалобами и скрытием), его же сохранения и жалобы тоже
    env.DB.prepare("DELETE FROM pl_saves WHERE code IN (SELECT code FROM pubpl WHERE user_id=?)").bind(a.id),
    env.DB.prepare("DELETE FROM pl_reports WHERE code IN (SELECT code FROM pubpl WHERE user_id=?)").bind(a.id),
    env.DB.prepare("DELETE FROM pl_hidden WHERE code IN (SELECT code FROM pubpl WHERE user_id=?)").bind(a.id),
    env.DB.prepare("DELETE FROM pubpl WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM pl_reports WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM pl_saves WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM profiles WHERE user_id=?").bind(a.id),
    ...(hadSaves ? [env.DB.prepare("UPDATE pubpl SET saves=(SELECT COUNT(*) FROM pl_saves s WHERE s.code=pubpl.code)")] : []),
    env.DB.prepare("DELETE FROM suggestions WHERE user_id=? AND status<>'approved'").bind(a.id),
    env.DB.prepare("UPDATE suggestions SET user_id=NULL, nick='' WHERE user_id=?").bind(a.id),
    env.DB.prepare("DELETE FROM users WHERE id=?").bind(a.id)
  ]);
  if (hadApproved) await rebuildOverlay(env);
  return J({ ok: true });
}

// ───────── Доверие, голоса «Полезно» и жалобы ─────────

const TRUST_AFTER = 3;    // сколько одобренных заметок делают автора доверенным: его новые заметки без ссылок выходят сразу
const LIVE_PER_DAY = 5;   // сколько таких заметок в сутки выходит без проверки, остальные ждут модератора
const HIDE_AT = 3;        // столько разных жалоб прячут заметку из приложения, пока модератор не решит
const WHY = ["spam", "offensive", "wrong", "other"];
const MILESTONES = [5, 10, 25, 50, 100];   // на скольких голосах автору приходит запись во «Входящие»
/** Заметку со ссылкой всегда сначала смотрит модератор, даже у доверенного автора. */
const LINK_RE = /https?:\/\/|www\.|t\.me\/|\b[\w-]+\.(?:com|ru|net|org|io|me|gg|ly|co|app|dev|xyz|top|club|link|site|online)\b/i;

const approvedCount = async (env, uid) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE user_id=? AND status='approved'").bind(uid).first())?.n || 0;

/** Доверие автора: yes, paused (модератор приостановил) или no (пока нет). Запись в trust есть, только если модератор решил сам
 *  (1 — доверен, -1 — приостановлено), иначе всё считается по числу одобренных заметок. */
async function trustOf(env, uid, have) {
  const row = await env.DB.prepare("SELECT level FROM trust WHERE user_id=?").bind(uid).first();
  const n = have ?? await approvedCount(env, uid);
  const lv = row ? row.level : 0;
  return { state: lv < 0 ? "paused" : lv > 0 || n >= TRUST_AFTER ? "yes" : "no", have: n, need: TRUST_AFTER, manual: lv > 0 };
}

/** Модератор включает (1) или приостанавливает (-1) доверие вручную; автор узнаёт об этом во «Входящих». */
async function setTrust(env, uid, level) {
  await env.DB.prepare("INSERT OR REPLACE INTO trust(user_id,level,since) VALUES(?,?,?)").bind(uid, level, now()).run();
  await addInbox(env, uid, level > 0 ? "trusted" : "paused", { id: 0 });
}

/** После одобрения: третья одобренная заметка (при нетронутом модератором доверии) делает автора доверенным. */
async function trustCheck(env, uid) {
  if (!uid) return false;
  const t = await trustOf(env, uid);
  if (t.state !== "yes" || t.manual || t.have !== TRUST_AFTER) return false;
  await addInbox(env, uid, "trusted", { id: 0 });
  return true;
}

/** Пересчитывает готовый счётчик голосов одной заметки: одной пачкой, чтобы он не разошёлся с самими голосами. */
async function recount(env, sid) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vote_n WHERE sid=?").bind(sid),
    env.DB.prepare("INSERT INTO vote_n(sid,n) SELECT sid, COUNT(*) FROM votes WHERE sid=? GROUP BY sid").bind(sid)
  ]);
}

/** Номер заметки из тела запроса или 0, если он не годится. */
const noteId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

/** «Полезно»: один голос на аккаунт и заметку, за свою заметку голосовать нельзя; on:false снимает голос. */
async function vote(req, env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const id = noteId(b.id);
  if (!id) return J({ error: "bad" }, 400);
  if (await hit(env, "vote:" + a.id, 120, 3600)) return J({ error: "rate" }, 429);
  const s = await env.DB.prepare("SELECT id,user_id,k,tt,ta FROM suggestions WHERE id=? AND status='approved' AND id NOT IN (SELECT sid FROM hidden)").bind(id).first();
  if (!s) return J({ error: "gone" }, 404);
  if (s.user_id === a.id) return J({ error: "own" }, 403);
  const on = b.on !== false;
  const r = on
    ? await env.DB.prepare("INSERT OR IGNORE INTO votes(sid,user_id,created) VALUES(?,?,?)").bind(id, a.id, now()).run()
    : await env.DB.prepare("DELETE FROM votes WHERE sid=? AND user_id=?").bind(id, a.id).run();
  const changed = !!r.meta.changes;
  if (changed) await recount(env, id);
  const n = (await env.DB.prepare("SELECT n FROM vote_n WHERE sid=?").bind(id).first())?.n || 0;
  // Автору приходит запись, когда голосов становится 5, 10, 25, 50 и 100 (повторно на тех же числах, если голос сняли и поставили, не приходит)
  if (on && changed && s.user_id && MILESTONES.includes(n)
    && !(await env.DB.prepare("SELECT 1 AS x FROM inbox WHERE user_id=? AND kind='helpful' AND ref=? AND text=?").bind(s.user_id, id, String(n)).first())) {
    await addInbox(env, s.user_id, "helpful", s, String(n));
  }
  return J({ ok: true, id, n, mine: on });
}

/** За какие заметки голосовал этот аккаунт (последние 1000). */
async function myVotes(env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const rows = (await env.DB.prepare("SELECT sid FROM votes WHERE user_id=? ORDER BY created DESC LIMIT 1000").bind(a.id).all()).results || [];
  return J({ ids: rows.map(r => r.sid) });
}

/** Готовые счётчики голосов: {номер заметки: сколько голосов}. Только заметки, у которых они есть. */
async function voteMap(env) {
  const rows = (await env.DB.prepare("SELECT sid,n FROM vote_n WHERE n>0").all()).results || [];
  const o = {};
  for (const r of rows) o[r.sid] = r.n;
  return o;
}

/** Жалоба на опубликованную заметку: одна на аккаунт и заметку. Модератору приходит карточка (на первую жалобу
 *  и на ту, после которой заметка скрыта), после HIDE_AT разных жалоб заметка пропадает из приложения до его решения. */
async function report(req, env, ip, ctx, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const id = noteId(b.id), why = WHY.includes(b.why) ? b.why : "";
  if (!id || !why) return J({ error: "bad" }, 400);
  const day = Math.floor(now() / DAY);
  if (await hit(env, `rep:u:${a.id}:${day}`, 10, DAY)) return J({ error: "limit" }, 429);
  if (await hit(env, `rep:ip:${ip}:${day}`, 40, DAY)) return J({ error: "rate" }, 429);
  if (await hit(env, "rep:all:" + day, 500, DAY)) return J({ error: "cap" }, 429);
  const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=? AND status='approved'").bind(id).first();
  if (!s) return J({ error: "gone" }, 404);
  if (s.user_id === a.id) return J({ error: "own" }, 403);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO reports(sid,user_id,why,created) VALUES(?,?,?,?)").bind(id, a.id, why, now()).run();
  if (!r.meta.changes) return J({ ok: true, dup: true });
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE sid=? AND resolved=0").bind(id).first())?.n || 0;
  let hide = false;
  if (n >= HIDE_AT) {
    const h = await env.DB.prepare("INSERT OR IGNORE INTO hidden(sid,at) VALUES(?,?)").bind(id, now()).run();
    if (h.meta.changes) { await rebuildOverlay(env); hide = true; }
  }
  if (n === 1 || hide) {
    const job = notifyReport(env, s, hide);
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  }
  return J({ ok: true });
}

// ───────── Публичные плейлисты ─────────

const PL_MAX = 5;                          // публичных плейлистов на аккаунт
const PL_MIN_ITEMS = 3, PL_MAX_ITEMS = 300;
const PL_PAGE = 20;
const PUBLISH_PER_DAY = 12, PUBLISH_PER_DAY_FRESH = 4;   // публикаций и правок в сутки; у аккаунта младше недели меньше
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

const mkPlCode = () => {
  let s = "";
  for (const x of crypto.getRandomValues(new Uint8Array(32))) if (x < 248 && s.length < 8) s += ALPHA[x % ALPHA.length];
  return s.length === 8 ? s : mkPlCode();
};
const fmtCode = (c) => "VPP-" + c.slice(0, 4) + "-" + c.slice(4);

/** Код из любой записи («VPP-ABCD-2345», «abcd2345», с пробелами) в 8 символов, а если не годится, пустая строка. */
function plCode(v) {
  let c = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length === 11 && c.startsWith("VPP")) c = c.slice(3);
  return CODE_RE.test(c) ? c : "";
}

/** Состав: пары [id релиза, номер трека]. Повторы убираются. Возвращает {list} или {error}. */
function plItems(v) {
  if (!Array.isArray(v)) return { error: "items" };
  if (v.length > PL_MAX_ITEMS) return { error: "many" };
  const seen = new Set(), list = [];
  for (const it of v) {
    if (!Array.isArray(it) || it.length !== 2) return { error: "items" };
    const [r, i] = it;
    if (typeof r !== "string" || !/^[\w.-]{1,40}$/.test(r) || !Number.isInteger(i) || i < 0 || i > 999) return { error: "items" };
    const k = r + ":" + i;
    if (!seen.has(k)) { seen.add(k); list.push([r, i]); }
  }
  return list.length < PL_MIN_ITEMS ? { error: "few" } : { list };
}

const parseList = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Плейлист, который можно показывать всем: автор не забанен и жалобы его не спрятали. */
const livePl = (env, code) => env.DB.prepare(
  "SELECT p.*, u.nick, COALESCE(pr.public,0) AS ppub, COALESCE(pr.av,0) AS av FROM pubpl p JOIN users u ON u.id=p.user_id AND u.banned=0 "
  + "LEFT JOIN profiles pr ON pr.user_id=p.user_id WHERE p.code=? AND p.code NOT IN (SELECT code FROM pl_hidden)"
).bind(code).first();

/** Опубликовать плейлист или (с code) обновить свой. Приложение присылает название, описание, состав и номер обложки. */
async function plPublish(req, env, ip, ctx, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req, 40000); if (!b) return J({ error: "json" }, 400);
  const upd = b.code !== undefined && b.code !== null && b.code !== "";
  let cur = null, code = "";
  if (upd) {
    code = plCode(b.code);
    cur = code ? await env.DB.prepare("SELECT * FROM pubpl WHERE code=? AND user_id=?").bind(code, a.id).first() : null;
    if (!cur) return J({ error: "gone" }, 404);
  }
  const name = clean(b.name, 40).replace(/\s*\n\s*/g, " "), descr = clean(b.desc, 140);
  if ([...name].length < 2) return J({ error: "name" }, 400);
  if (LINK_RE.test(name) || LINK_RE.test(descr)) return J({ error: "link" }, 400);
  const its = plItems(b.items);
  if (its.error) return J({ error: its.error, min: PL_MIN_ITEMS, max: PL_MAX_ITEMS }, 400);
  const items = its.list;
  const cvi = Number.isInteger(b.cvi) && b.cvi >= 0 && b.cvi < 64 ? b.cvi : 0;
  if (!cur) {
    const have = (await env.DB.prepare("SELECT COUNT(*) AS n FROM pubpl WHERE user_id=?").bind(a.id).first())?.n || 0;
    if (have >= PL_MAX) return J({ error: "max", max: PL_MAX }, 409);
  }
  const day = Math.floor(now() / DAY), fresh = now() - a.created < 7 * DAY;
  if (await hit(env, `pub:u:${a.id}:${day}`, fresh ? PUBLISH_PER_DAY_FRESH : PUBLISH_PER_DAY, DAY)) return J({ error: "limit" }, 429);
  if (await hit(env, `pub:ip:${ip}:${day}`, 40, DAY)) return J({ error: "rate" }, 429);
  const t = now(), prev = JSON.stringify(items.slice(0, 4)), all = JSON.stringify(items);
  if (cur) {
    await env.DB.prepare("UPDATE pubpl SET name=?,descr=?,n=?,cvi=?,updated=?,prev=?,items=? WHERE code=? AND user_id=?")
      .bind(name, descr, items.length, cvi, t, prev, all, code, a.id).run();
  } else {
    for (let tries = 0; ; tries++) {
      code = mkPlCode();
      try {
        await env.DB.prepare("INSERT INTO pubpl(code,user_id,name,descr,n,cvi,created,updated,prev,items) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .bind(code, a.id, name, descr, items.length, cvi, t, t, prev, all).run();
        break;
      } catch (e) {
        if (tries < 5 && /UNIQUE|PRIMARY/i.test(String((e && e.message) || e))) continue;
        throw e;
      }
    }
  }
  // Модератору приходит карточка о новом плейлисте и о смене названия или описания (правки только состава его не беспокоят)
  if (!cur || cur.name !== name || cur.descr !== descr) {
    const job = notifyPl(env, { code, name, descr, n: items.length, nick: a.nick, user_id: a.id }, cur ? "updated" : "new");
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  }
  return J({ ok: true, code, created: !cur, updated: t });
}

/** Убирает плейлист и всё, что к нему привязано. */
const dropPl = (env, code) => env.DB.batch([
  env.DB.prepare("DELETE FROM pl_saves WHERE code=?").bind(code),
  env.DB.prepare("DELETE FROM pl_reports WHERE code=?").bind(code),
  env.DB.prepare("DELETE FROM pl_hidden WHERE code=?").bind(code),
  env.DB.prepare("DELETE FROM pubpl WHERE code=?").bind(code)
]);

/** Автор снимает свой плейлист с публикации (повторный вызов тоже отвечает ok). */
async function plUnpublish(req, env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const code = plCode(b.code); if (!code) return J({ error: "bad" }, 400);
  const own = await env.DB.prepare("SELECT 1 AS x FROM pubpl WHERE code=? AND user_id=?").bind(code, a.id).first();
  if (own) await dropPl(env, code);
  return J({ ok: true, gone: !own });
}

/** Свои публичные плейлисты (с кодами) и сколько можно иметь. */
async function plMine(env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const rows = (await env.DB.prepare(
    "SELECT p.code,p.name,p.descr,p.n,p.saves,p.cvi,p.created,p.updated,(h.code IS NOT NULL) AS hid FROM pubpl p LEFT JOIN pl_hidden h ON h.code=p.code WHERE p.user_id=? ORDER BY p.updated DESC, p.rowid DESC"
  ).bind(a.id).all()).results || [];
  return J({
    max: PL_MAX,
    items: rows.map(r => ({ code: r.code, name: r.name, desc: r.descr, n: r.n, saves: r.saves, cvi: r.cvi, created: r.created, updated: r.updated, hidden: !!r.hid }))
  });
}

/** Открыть плейлист по коду: доступно без аккаунта. Если запрос с токеном, добавляются own и saved. */
async function plGet(req, env, ip, code) {
  if (await hit(env, "plr:" + ip, 300, 3600)) return J({ error: "rate" }, 429);
  const p = code ? await livePl(env, code) : null;
  if (!p) return J({ error: "gone" }, 404);
  const me = req.headers.get("authorization") ? await authed(req, env) : null;
  const o = {
    code: p.code, name: p.name, desc: p.descr, nick: p.nick, pub: !!p.ppub, av: p.ppub ? p.av : 0,
    n: p.n, saves: p.saves, cvi: p.cvi, created: p.created, updated: p.updated, items: parseList(p.items)
  };
  if (me && !me.banned) {
    o.own = me.id === p.user_id;
    o.saved = !!(await env.DB.prepare("SELECT 1 AS x FROM pl_saves WHERE code=? AND user_id=?").bind(p.code, me.id).first());
  }
  return J(o);
}

/** Общий список: sort=new (по умолчанию) или top (сохранённые хотя бы раз, по числу сохранений), by=ник, limit до 30, offset до 500. */
async function plList(env, ip, u) {
  if (await hit(env, "plr:" + ip, 300, 3600)) return J({ error: "rate" }, 429);
  const top = u.searchParams.get("sort") === "top";
  const limit = Math.min(Math.max(parseInt(u.searchParams.get("limit") || "", 10) || PL_PAGE, 1), 30);
  const offset = Math.min(Math.max(parseInt(u.searchParams.get("offset") || "", 10) || 0, 0), 500);
  const by = clean(u.searchParams.get("by") || "", 40).normalize("NFKC").toLowerCase();
  const rows = (await env.DB.prepare(
    "SELECT p.code,p.name,p.n,p.saves,p.cvi,p.created,p.prev,u.nick,COALESCE(pr.public,0) AS ppub,COALESCE(pr.av,0) AS av "
    + "FROM pubpl p JOIN users u ON u.id=p.user_id AND u.banned=0 LEFT JOIN profiles pr ON pr.user_id=p.user_id "
    + "WHERE p.code NOT IN (SELECT code FROM pl_hidden)" + (top ? " AND p.saves>0" : "") + (by ? " AND u.nick_lc=?" : "")
    + (top ? " ORDER BY p.saves DESC, p.created DESC, p.rowid DESC" : " ORDER BY p.created DESC, p.rowid DESC") + " LIMIT ? OFFSET ?"
  ).bind(...(by ? [by] : []), limit + 1, offset).all()).results || [];
  return J({
    more: rows.length > limit,
    items: rows.slice(0, limit).map(r => ({
      code: r.code, name: r.name, nick: r.nick, pub: !!r.ppub, av: r.ppub ? r.av : 0,
      n: r.n, saves: r.saves, cvi: r.cvi, created: r.created, prev: parseList(r.prev)
    }))
  });
}

/** «Сохранить себе»: засчитывается один раз на аккаунт. Свой плейлист не считается. Автору приходит запись на 5, 10, 25, 50 и 100 сохранениях. */
async function plSave(req, env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const code = plCode(b.code); if (!code) return J({ error: "bad" }, 400);
  if (await hit(env, "plsave:" + a.id, 60, 3600)) return J({ error: "rate" }, 429);
  const p = await livePl(env, code);
  if (!p) return J({ error: "gone" }, 404);
  if (p.user_id === a.id) return J({ ok: true, own: true, saves: p.saves });
  const r = await env.DB.prepare("INSERT OR IGNORE INTO pl_saves(code,user_id,created) VALUES(?,?,?)").bind(code, a.id, now()).run();
  let saves = p.saves;
  if (r.meta.changes) {
    await env.DB.prepare("UPDATE pubpl SET saves=(SELECT COUNT(*) FROM pl_saves WHERE code=?) WHERE code=?").bind(code, code).run();
    saves = (await env.DB.prepare("SELECT saves FROM pubpl WHERE code=?").bind(code).first())?.saves || 0;
    if (MILESTONES.includes(saves)
      && !(await env.DB.prepare("SELECT 1 AS x FROM inbox WHERE user_id=? AND kind='plsaved' AND k=? AND text=?").bind(p.user_id, code, String(saves)).first())) {
      await addInbox(env, p.user_id, "plsaved", { k: code, tt: p.name }, String(saves));
    }
  }
  return J({ ok: true, saves });
}

/** Жалоба на публичный плейлист: правила те же, что у заметок (одна на аккаунт, три разные прячут до решения модератора). */
async function plReport(req, env, ip, ctx, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  const code = plCode(b.code), why = WHY.includes(b.why) ? b.why : "";
  if (!code || !why) return J({ error: "bad" }, 400);
  const day = Math.floor(now() / DAY);
  if (await hit(env, `rep:u:${a.id}:${day}`, 10, DAY)) return J({ error: "limit" }, 429);
  if (await hit(env, `rep:ip:${ip}:${day}`, 40, DAY)) return J({ error: "rate" }, 429);
  if (await hit(env, "rep:all:" + day, 500, DAY)) return J({ error: "cap" }, 429);
  const p = await plRow(env, code);
  if (!p) return J({ error: "gone" }, 404);
  if (p.user_id === a.id) return J({ error: "own" }, 403);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO pl_reports(code,user_id,why,created) VALUES(?,?,?,?)").bind(code, a.id, why, now()).run();
  if (!r.meta.changes) return J({ ok: true, dup: true });
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM pl_reports WHERE code=? AND resolved=0").bind(code).first())?.n || 0;
  let hide = false;
  if (n >= HIDE_AT) hide = !!(await env.DB.prepare("INSERT OR IGNORE INTO pl_hidden(code,at) VALUES(?,?)").bind(code, now()).run()).meta.changes;
  if (n === 1 || hide) {
    const job = notifyPlReport(env, p, hide);
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  }
  return J({ ok: true });
}

/** Плейлист вместе с ником автора, как бы он ни был виден (для модератора и жалоб). */
const plRow = (env, code) => env.DB.prepare("SELECT p.*, COALESCE(u.nick,'') AS nick FROM pubpl p LEFT JOIN users u ON u.id=p.user_id WHERE p.code=?").bind(code).first();

/** Модератор убирает плейлист; автор узнаёт об этом во «Входящих». */
async function removePl(env, code) {
  const p = await plRow(env, code);
  if (!p) return { gone: true };
  await dropPl(env, code);
  await addInbox(env, p.user_id, "plremoved", { k: code, tt: p.name });
  return { p };
}

// ───────── Профиль ─────────

const AV_MAX = 12;   // готовых цветов аватара (1..12), 0 — цвет по нику
const monthOf = (t) => new Date(t * 1000).toISOString().slice(0, 7);

/** Что человек сделал в приложении: из этого считаются значки. Скрытые жалобами заметки и плейлисты не считаются. */
async function profileStats(env, uid) {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE user_id=? AND status='approved' AND id NOT IN (SELECT sid FROM hidden)").bind(uid).first())?.n || 0;
  const h = (await env.DB.prepare(
    "SELECT COALESCE(SUM(v.n),0) AS n FROM suggestions s JOIN vote_n v ON v.sid=s.id WHERE s.user_id=? AND s.status='approved' AND s.id NOT IN (SELECT sid FROM hidden)"
  ).bind(uid).first())?.n || 0;
  const p = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(saves),0) AS s, COALESCE(MAX(saves),0) AS m FROM pubpl WHERE user_id=? AND code NOT IN (SELECT code FROM pl_hidden)"
  ).bind(uid).first();
  return { notes: n, helpful: h, playlists: p?.n || 0, saves: p?.s || 0, best: p?.m || 0 };
}

/** Значки считаются на лету, нигде не хранятся и пропадают вместе с тем, за что выданы. */
function badgeList(s, trust) {
  const b = [];
  if (s.notes >= 1) b.push("note");
  if (trust === "yes") b.push("trusted");
  if (s.helpful >= 100) b.push("helpful3"); else if (s.helpful >= 50) b.push("helpful2"); else if (s.helpful >= 10) b.push("helpful1");
  if (s.playlists >= 1) b.push("curator");
  if (s.best >= 10) b.push("popular");
  return b;
}

async function profileJson(env, uid, created) {
  const st = await profileStats(env, uid);
  const tr = await trustOf(env, uid);
  return { since: monthOf(created), stats: { notes: st.notes, helpful: st.helpful, playlists: st.playlists, saves: st.saves }, badges: badgeList(st, tr.state) };
}

/** Свой профиль: открыт он или закрыт, цвет аватара и то, что увидят другие, если открыть. */
async function profileGet(env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const pr = await env.DB.prepare("SELECT public, av FROM profiles WHERE user_id=?").bind(a.id).first();
  return J({ nick: a.nick, public: !!pr?.public, av: pr?.av || 0, ...(await profileJson(env, a.id, a.created)) });
}

/** Открыть или закрыть профиль и выбрать цвет аватара: можно прислать одно поле или оба. */
async function profileSet(req, env, a) {
  if (a.banned) return J({ error: "banned" }, 403);
  const b = await body(req); if (!b) return J({ error: "json" }, 400);
  if (b.public !== undefined && typeof b.public !== "boolean") return J({ error: "bad" }, 400);
  if (b.av !== undefined && !(Number.isInteger(b.av) && b.av >= 0 && b.av <= AV_MAX)) return J({ error: "bad" }, 400);
  if (await hit(env, "prof:" + a.id, 60, 3600)) return J({ error: "rate" }, 429);
  const cur = await env.DB.prepare("SELECT public, av FROM profiles WHERE user_id=?").bind(a.id).first();
  const pub = b.public === undefined ? (cur?.public || 0) : b.public ? 1 : 0;
  const av = b.av === undefined ? (cur?.av || 0) : b.av;
  await env.DB.prepare("INSERT OR REPLACE INTO profiles(user_id,public,av,updated) VALUES(?,?,?,?)").bind(a.id, pub, av, now()).run();
  return J({ ok: true, public: !!pub, av });
}

/** Чужой профиль по нику: только открытый. Закрытый, несуществующий и забаненный выглядят одинаково (private). */
async function profilePublic(env, ip, raw) {
  if (await hit(env, "plr:" + ip, 300, 3600)) return J({ error: "rate" }, 429);
  let nick = "";
  try { nick = decodeURIComponent(raw).normalize("NFKC").trim().toLowerCase(); } catch { /* битая запись пути */ }
  if (!nick || nick.length > 40) return J({ error: "private" }, 404);
  const u = await env.DB.prepare(
    "SELECT u.id,u.nick,u.created,u.banned,COALESCE(pr.public,0) AS pub,COALESCE(pr.av,0) AS av FROM users u LEFT JOIN profiles pr ON pr.user_id=u.id WHERE u.nick_lc=?"
  ).bind(nick).first();
  if (!u || u.banned || !u.pub) return J({ error: "private" }, 404);
  return J({ nick: u.nick, av: u.av, ...(await profileJson(env, u.id, u.created)) });
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
  if (await env.DB.prepare("SELECT 1 AS x FROM suggestions WHERE user_id=? AND k=? AND text=? AND status IN ('pending','approved')").bind(a.id, k, text).first()) {
    return J({ error: "dup" }, 409);
  }
  // Доверенный автор: заметка без ссылок выходит сразу (не больше LIVE_PER_DAY в сутки), всё остальное ждёт модератора
  const live = !src && !LINK_RE.test(text) && (await trustOf(env, a.id)).state === "yes" && !(await hit(env, `live:${a.id}:${day}`, LIVE_PER_DAY, DAY));
  const t = now();
  const r = await env.DB.prepare("INSERT INTO suggestions(user_id,nick,k,tt,ta,section,text,src,created,status,decided) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(a.id, a.nick, k, tt, ta, sec, text, src, t, live ? "approved" : "pending", live ? t : 0).run();
  const id = r.meta.last_row_id;
  if (live) await rebuildOverlay(env);
  const row = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(id).first();
  if (ctx && ctx.waitUntil) ctx.waitUntil(notify(env, row, { live })); else await notify(env, row, { live });
  return J({ ok: true, id, status: live ? "approved" : "pending" });
}

async function mine(env, a) {
  const rows = (await env.DB.prepare(
    "SELECT s.id,s.k,s.tt,s.ta,s.section,s.text,s.src,s.status,s.final_text,s.note,s.created,s.decided,(h.sid IS NOT NULL) AS hid,COALESCE(v.n,0) AS votes "
    + "FROM suggestions s LEFT JOIN hidden h ON h.sid=s.id LEFT JOIN vote_n v ON v.sid=s.id WHERE s.user_id=? ORDER BY s.id DESC LIMIT 50"
  ).bind(a.id).all()).results || [];
  return J({
    items: rows.map(r => ({
      id: r.id, k: r.k, tt: r.tt, ta: r.ta, sec: r.section, text: r.final_text || r.text, src: r.src,
      status: r.status, note: r.note, created: r.created, decided: r.decided, votes: r.votes, hidden: !!r.hid
    }))
  });
}

// ───────── Заметки фанатов (одобренные предложения) ─────────

async function rebuildOverlay(env) {
  const rows = (await env.DB.prepare(
    "SELECT id,k,section,text,final_text,src,nick,decided FROM suggestions WHERE status='approved' AND id NOT IN (SELECT sid FROM hidden) ORDER BY decided ASC, id ASC LIMIT 3000"
  ).all()).results || [];
  const notes = {};
  for (const r of rows) (notes[r.k] ||= []).push({ id: r.id, s: r.section, t: r.final_text || r.text, u: r.src || "", by: r.nick || "", at: r.decided });
  const prev = await env.DB.prepare("SELECT v FROM meta WHERE k='overlay_v'").first();
  const v = (parseInt(prev?.v || "0", 10) || 0) + 1;
  await env.DB.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('overlay',?)").bind(JSON.stringify(notes)).run();
  await env.DB.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('overlay_v',?)").bind(String(v)).run();
}

/** Заметки и, отдельным полем, голоса «Полезно»: они меняются чаще заметок и не поднимают версию, поэтому приходят при каждом запросе
 *  (поле votes есть, только когда хотя бы у одной заметки есть голоса). */
async function overlay(env, u) {
  const vr = await env.DB.prepare("SELECT v FROM meta WHERE k='overlay_v'").first();
  const v = parseInt(vr?.v || "0", 10) || 0;
  const votes = await voteMap(env);
  const vj = Object.keys(votes).length ? `,"votes":${JSON.stringify(votes)}` : "";
  const hdr = { "content-type": "application/json", "cache-control": "no-store" };
  if (parseInt(u.searchParams.get("v") ?? "-1", 10) === v) return new Response(`{"v":${v},"same":true${vj}}`, { headers: hdr });
  const o = await env.DB.prepare("SELECT v FROM meta WHERE k='overlay'").first();
  return new Response(`{"v":${v},"notes":${o?.v || "{}"}${vj}}`, { headers: hdr });
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

function card(s, o = {}) {
  const track = [s.ta, s.tt].filter(Boolean).map(esc).join(" — ");
  let t = `📝 #${s.id} · ${esc(s.nick || "—")}\n🎵 ${track ? track + " " : ""}<code>${esc(s.k)}</code>\n📂 ${esc(SEC_NAME[s.section] || s.section)}\n\n${esc(s.final_text || s.text)}`;
  if (s.src) t += `\n\n🔗 ${esc(s.src)}`;
  if (s.status === "approved") t += o.live ? "\n\n⚡ <b>Published at once</b> — trusted author" : "\n\n✅ <b>Approved</b>";
  else if (s.status === "rejected") t += "\n\n❌ <b>Rejected</b>" + (s.note ? ": " + esc(s.note) : "");
  else if (s.status === "deleted") t += "\n\n🗑 <b>Deleted</b> — it is gone from the app";
  else t += "\n\n<i>Reply with new text to edit and approve, or “/no reason” to reject with a note.</i>";
  return t;
}
// У ждущей карточки: Approve / Reject / Ban. У одобренной: Delete (убрать заметку из приложения), а если автор доверенный, ещё Pause trust.
const keyboard = (s, trusted = false) => s.status === "approved"
  ? { inline_keyboard: [[{ text: "🗑 Delete", callback_data: "d:" + s.id }], ...(trusted && s.user_id ? [[{ text: "⏸ Pause trust", callback_data: "t:" + s.user_id }]] : [])] }
  : {
    inline_keyboard: [
      [{ text: "✅ Approve", callback_data: "a:" + s.id }, { text: "❌ Reject", callback_data: "r:" + s.id }],
      ...(s.user_id ? [[{ text: "🚫 Ban author", callback_data: "b:" + s.user_id }]] : [])
    ]
  };
/** Подтверждение удаления: случайное нажатие на Delete ничего не стирает. */
const sure = (id) => ({ inline_keyboard: [[{ text: "🗑 Yes, delete", callback_data: "y:" + id }, { text: "↩️ Cancel", callback_data: "n:" + id }]] });
/** Карточка после решения: текст по статусу, а кнопки только у одобренной (Delete), у остальных их нет. */
const cardEdit = (chat_id, message_id, s, trusted = false) => ({
  chat_id, message_id, text: card(s), parse_mode: "HTML", disable_web_page_preview: true,
  ...(s.status === "approved" ? { reply_markup: keyboard(s, trusted) } : {})
});

const isTrusted = async (env, s) => !!s.user_id && (await trustOf(env, s.user_id)).state === "yes";

async function notify(env, s, o = {}) {
  const kb = keyboard(s, s.status === "approved" && await isTrusted(env, s));
  for (const id of admins(env)) {
    await tg(env, "sendMessage", { chat_id: id, text: card(s, o), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
  }
}

// Карточка жалобы: новая заметка с кнопками Delete / Keep. Keep закрывает жалобы и возвращает скрытую заметку в приложение.
const WHY_NAME = { spam: "spam", offensive: "offensive", wrong: "wrong or misleading", other: "other" };
async function reportCard(env, s, hidden) {
  const rows = (await env.DB.prepare("SELECT why, COUNT(*) AS n FROM reports WHERE sid=? AND resolved=0 GROUP BY why ORDER BY n DESC").bind(s.id).all()).results || [];
  const total = rows.reduce((x, r) => x + r.n, 0);
  const track = [s.ta, s.tt].filter(Boolean).map(esc).join(" — ");
  let t = `🚩 #${s.id} · ${esc(s.nick || "—")}\n🎵 ${track ? track + " " : ""}<code>${esc(s.k)}</code>\n📂 ${esc(SEC_NAME[s.section] || s.section)}\n\n${esc(s.final_text || s.text)}`;
  if (s.src) t += `\n\n🔗 ${esc(s.src)}`;
  t += `\n\nReports: ${total} (${rows.map(r => `${WHY_NAME[r.why] || esc(r.why)} ×${r.n}`).join(", ")})`;
  if (hidden) t += "\n🙈 <b>Hidden</b> from the app until you decide";
  return t;
}
const reportKeyboard = (s, trusted) => ({
  inline_keyboard: [
    [{ text: "🗑 Delete", callback_data: "x:" + s.id }, { text: "✅ Keep", callback_data: "k:" + s.id }],
    ...(s.user_id ? [[...(trusted ? [{ text: "⏸ Pause trust", callback_data: "t:" + s.user_id }] : []), { text: "🚫 Ban author", callback_data: "b:" + s.user_id }]] : [])
  ]
});
async function notifyReport(env, s, hidden) {
  const text = await reportCard(env, s, hidden), kb = reportKeyboard(s, await isTrusted(env, s));
  for (const id of admins(env)) {
    await tg(env, "sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
  }
}

// Карточки публичных плейлистов. Новый: Delete / Ban author (после решения кнопок нет). Жалоба: Delete / Keep / Ban author.
// Delete сначала просит подтвердить: pd → py (да) или pn (отмена); у карточки жалобы то же самое через px → pxy или pxn.
function plCard(p, note = "") {
  let t = `📻 <b>${esc(p.name)}</b> · ${esc(p.nick || "—")}\n🎧 ${p.n} tracks · <code>${fmtCode(p.code)}</code>`;
  if (p.descr) t += `\n\n${esc(p.descr)}`;
  if (note) t += "\n\n" + note;
  return t;
}
const plKeyboard = (p) => ({ inline_keyboard: [[{ text: "🗑 Delete", callback_data: "pd:" + p.code }], ...(p.user_id ? [[{ text: "🚫 Ban author", callback_data: "b:" + p.user_id }]] : [])] });
const plReportKeyboard = (p) => ({
  inline_keyboard: [
    [{ text: "🗑 Delete", callback_data: "px:" + p.code }, { text: "✅ Keep", callback_data: "pk:" + p.code }],
    ...(p.user_id ? [[{ text: "🚫 Ban author", callback_data: "b:" + p.user_id }]] : [])
  ]
});
const plSure = (code, yes, no) => ({ inline_keyboard: [[{ text: "🗑 Yes, delete", callback_data: yes + ":" + code }, { text: "↩️ Cancel", callback_data: no + ":" + code }]] });
async function plReportCard(env, p, hidden) {
  const rows = (await env.DB.prepare("SELECT why, COUNT(*) AS n FROM pl_reports WHERE code=? AND resolved=0 GROUP BY why ORDER BY n DESC").bind(p.code).all()).results || [];
  const total = rows.reduce((x, r) => x + r.n, 0);
  let t = "🚩 " + plCard(p) + `\n\nReports: ${total} (${rows.map(r => `${WHY_NAME[r.why] || esc(r.why)} ×${r.n}`).join(", ")})`;
  if (hidden) t += "\n🙈 <b>Hidden</b> from the app until you decide";
  return t;
}
async function notifyPl(env, p, kind) {
  const text = plCard(p, kind === "updated" ? "✏️ <i>Name or description changed</i>" : ""), kb = plKeyboard(p);
  for (const id of admins(env)) await tg(env, "sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
}
async function notifyPlReport(env, p, hidden) {
  const text = await plReportCard(env, p, hidden), kb = plReportKeyboard(p);
  for (const id of admins(env)) await tg(env, "sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
}

async function decide(env, id, status, extra = {}) {
  const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(id).first();
  if (!s) return null;
  if (s.status !== "pending") return { s, already: true };
  const fin = extra.final ?? "", note = extra.note ?? "";
  await env.DB.prepare("UPDATE suggestions SET status=?, final_text=?, note=?, decided=? WHERE id=?").bind(status, fin, note, now(), id).run();
  if (status === "approved") await rebuildOverlay(env);
  // Автор узнаёт о решении во «Входящих»: «опубликовано», «опубликовано с правкой» (с текстом модератора) или «отклонено» (с причиной)
  let trusted = false;
  if (status === "approved") {
    await addInbox(env, s.user_id, fin && fin !== s.text ? "edited" : "approved", s, fin);
    trusted = await trustCheck(env, s.user_id);   // третья одобренная заметка: новые заметки автора дальше выходят сразу
  } else await addInbox(env, s.user_id, "rejected", s, note);
  return { s: { ...s, status, final_text: fin, note }, trusted };
}

/** Убирает одобренную заметку совсем: строка удаляется, лента заметок пересобирается (номер версии растёт),
 *  и приложение при следующем обновлении больше её не покажет. Номера у предложений не повторяются (AUTOINCREMENT),
 *  поэтому старая кнопка не заденет чужую запись. Ждущие и отклонённые не трогаем. */
async function removeApproved(env, id) {
  const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(id).first();
  if (!s) return { gone: true };
  if (s.status !== "approved") return { s, unpublished: true };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM suggestions WHERE id=? AND status='approved'").bind(id),
    env.DB.prepare("DELETE FROM votes WHERE sid=?").bind(id),
    env.DB.prepare("DELETE FROM vote_n WHERE sid=?").bind(id),
    env.DB.prepare("DELETE FROM reports WHERE sid=?").bind(id),
    env.DB.prepare("DELETE FROM hidden WHERE sid=?").bind(id)
  ]);
  await rebuildOverlay(env);
  await addInbox(env, s.user_id, "removed", s);
  return { s: { ...s, status: "deleted" } };
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
  const refresh = async (s) => msg && tg(env, "editMessageText", cardEdit(msg.chat.id, msg.message_id, s, s.status === "approved" && await isTrusted(env, s)));
  const markup = (mk) => msg && tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: mk || { inline_keyboard: [] } });
  if (op === "a" || op === "r") {
    const r = await decide(env, n, op === "a" ? "approved" : "rejected");
    if (!r) return answer("Not found");
    await refresh(r.s);
    return answer(r.already ? "Already " + r.s.status : op === "a" ? (r.trusted ? "Approved · author is now trusted" : "Approved") : "Rejected");
  }
  if (op === "b") {
    await banUser(env, n, true);
    return answer("Author banned");
  }
  // Убрать одобренную заметку: «Delete» просит подтвердить, «Yes, delete» удаляет, «Cancel» возвращает кнопку Delete.
  if (op === "y") {
    const r = await removeApproved(env, n);
    if (r.gone) { await markup(); return answer("Already deleted"); }
    if (r.unpublished) return answer("Not published, nothing to delete");
    await refresh(r.s);
    return answer("Deleted");
  }
  if (op === "d" || op === "n") {
    const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(n).first();
    if (!s) { await markup(); return answer("Already deleted"); }
    if (s.status !== "approved") return answer("Not published, nothing to delete");
    await markup(op === "d" ? sure(n) : keyboard(s, await isTrusted(env, s)));
    return answer(op === "d" ? "Delete it from the app?" : "Cancelled");
  }
  // Жалобы: x спрашивает подтверждение, xy удаляет заметку, xn отменяет, k закрывает жалобы (скрытая заметка возвращается в приложение)
  if (op === "x" || op === "xn") {
    const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(n).first();
    if (!s) { await markup(); return answer("Already deleted"); }
    if (s.status !== "approved") return answer("Not published, nothing to delete");
    await markup(op === "x"
      ? { inline_keyboard: [[{ text: "🗑 Yes, delete", callback_data: "xy:" + n }, { text: "↩️ Cancel", callback_data: "xn:" + n }]] }
      : reportKeyboard(s, await isTrusted(env, s)));
    return answer(op === "x" ? "Delete it from the app?" : "Cancelled");
  }
  if (op === "xy") {
    const r = await removeApproved(env, n);
    if (r.gone) { await markup(); return answer("Already deleted"); }
    if (r.unpublished) return answer("Not published, nothing to delete");
    await refresh(r.s);
    return answer("Deleted");
  }
  if (op === "k") {
    const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?").bind(n).first();
    if (!s) { await markup(); return answer("Already deleted"); }
    const text = await reportCard(env, s, false);
    await env.DB.prepare("UPDATE reports SET resolved=1 WHERE sid=?").bind(n).run();
    const h = await env.DB.prepare("DELETE FROM hidden WHERE sid=?").bind(n).run();
    if (h.meta.changes) await rebuildOverlay(env);
    if (msg) await tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: text + "\n\n✅ <b>Kept</b> — reports closed", parse_mode: "HTML", disable_web_page_preview: true });
    return answer(h.meta.changes ? "Kept, visible in the app again" : "Kept");
  }
  // Pause trust: заметки автора снова проверяются вручную; /trust ник возвращает доверие. Кнопка с карточки убирается.
  if (op === "t") {
    const u = await env.DB.prepare("SELECT nick FROM users WHERE id=?").bind(n).first();
    if (!u) { await markup(); return answer("No such account"); }
    await setTrust(env, n, -1);
    const kb = (msg?.reply_markup?.inline_keyboard || []).map(row => row.filter(b => !String(b.callback_data).startsWith("t:"))).filter(row => row.length);
    await markup({ inline_keyboard: kb });
    return answer(`Trust paused for ${u.nick}. /trust ${u.nick} brings it back.`);
  }
  // Публичные плейлисты: pd/px спрашивают подтверждение, py/pxy удаляют, pn/pxn отменяют, pk закрывает жалобы и возвращает плейлист в список
  if (["pd", "pn", "py", "px", "pxn", "pxy", "pk"].includes(op)) {
    const code = plCode(raw);
    const p = code ? await plRow(env, code) : null;
    if (!p) { await markup(); return answer("Already deleted"); }
    const report = op.startsWith("px") || op === "pk";
    const text = (hidden) => report ? plReportCard(env, p, hidden) : plCard(p);
    const edit = async (t, kb) => msg && tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) });
    if (op === "pd" || op === "px") { await markup(plSure(code, op === "pd" ? "py" : "pxy", op === "pd" ? "pn" : "pxn")); return answer("Delete it from the app?"); }
    if (op === "pn" || op === "pxn") { await markup(report ? plReportKeyboard(p) : plKeyboard(p)); return answer("Cancelled"); }
    if (op === "pk") {
      const t = await text(false);
      await env.DB.prepare("UPDATE pl_reports SET resolved=1 WHERE code=?").bind(code).run();
      const h = await env.DB.prepare("DELETE FROM pl_hidden WHERE code=?").bind(code).run();
      await edit(t + "\n\n✅ <b>Kept</b> — reports closed");
      return answer(h.meta.changes ? "Kept, visible in the app again" : "Kept");
    }
    const t = await text(false);
    await removePl(env, code);
    await edit(t + "\n\n🗑 <b>Deleted</b> — it is gone from the app");
    return answer("Deleted");
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
    await tg(env, "editMessageText", cardEdit(m.chat.id, m.reply_to_message.message_id, r.s, r.s.status === "approved" && await isTrusted(env, r.s)));
    return say(reject ? "Rejected." : "Approved with your edit.");
  }
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim().toLowerCase();
  const findUser = () => env.DB.prepare("SELECT * FROM users WHERE nick_lc=?").bind(arg).first();
  switch (cmd.toLowerCase().replace(/@\w+$/, "")) {
    case "/help":
      return say("/pending — suggestions waiting for review\n/approved [nick] — published notes, each with a Delete button\n/reports — published notes and playlists people reported\n/playlists [nick] — public playlists, each with a Delete button\n/stats — counters\n/user nick — account info\n/trust nick · /untrust nick — let someone publish at once, or pause that\n/ban nick · /unban nick\n\nOn a suggestion card: Approve, Reject, or reply with new text to edit and approve (“/no reason” rejects with a note). An approved note keeps a 🗑 Delete button (it asks to confirm) that removes it from the app.\n\nAfter 3 approved notes an author is trusted: new notes without links go live at once (up to 5 a day), you get a card with Delete and Pause trust. Three different reports hide a note from the app until you press Keep or Delete.\n\nPublic playlists go live at once and you get a card with Delete (it asks to confirm) and Ban author. Three different reports hide a playlist until you press Keep or Delete; a banned author's playlists disappear from the app until you /unban.");
    case "/stats": {
      const c = await env.DB.prepare("SELECT SUM(status='pending') AS p, SUM(status='approved') AS a, SUM(status='rejected') AS r FROM suggestions").first();
      const u = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(banned) AS b FROM users").first();
      const bk = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(size) AS s FROM backups").first();
      const tu = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM users u WHERE u.banned=0 AND COALESCE((SELECT level FROM trust t WHERE t.user_id=u.id),0) >= 0 AND (COALESCE((SELECT level FROM trust t WHERE t.user_id=u.id),0) > 0 OR (SELECT COUNT(*) FROM suggestions s WHERE s.user_id=u.id AND s.status='approved') >= ?)"
      ).bind(TRUST_AFTER).first();
      const vt = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes").first();
      const rp = await env.DB.prepare("SELECT COUNT(DISTINCT sid) AS n FROM reports WHERE resolved=0").first();
      const hd = await env.DB.prepare("SELECT COUNT(*) AS n FROM hidden").first();
      const pl = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(saves),0) AS s FROM pubpl").first();
      const pp = await env.DB.prepare("SELECT COUNT(*) AS n FROM profiles WHERE public=1").first();
      const pr = await env.DB.prepare("SELECT COUNT(DISTINCT code) AS n FROM pl_reports WHERE resolved=0").first();
      const ph = await env.DB.prepare("SELECT COUNT(*) AS n FROM pl_hidden").first();
      return say(`Users: ${u?.n || 0} (banned ${u?.b || 0})\nPending: ${c?.p || 0} · Approved: ${c?.a || 0} · Rejected: ${c?.r || 0}\nTrusted authors: ${tu?.n || 0} · Helpful votes: ${vt?.n || 0}\nOpen reports: ${rp?.n || 0} (hidden ${hd?.n || 0})\nPublic playlists: ${pl?.n || 0} (saves ${pl?.s || 0}) · Open playlist reports: ${pr?.n || 0} (hidden ${ph?.n || 0})\nPublic profiles: ${pp?.n || 0}\nCloud backups: ${bk?.n || 0} (${((bk?.s || 0) / 1048576).toFixed(1)} MB of ${(BACKUP_POOL / 1048576).toFixed(0)} MB)`);
    }
    case "/pending": {
      const rows = (await env.DB.prepare("SELECT * FROM suggestions WHERE status='pending' ORDER BY id ASC LIMIT 10").all()).results || [];
      if (!rows.length) return say("Nothing is waiting for review.");
      for (const s of rows) await say(card(s), { reply_markup: keyboard(s) });
      return;
    }
    case "/approved": {
      // Опубликованные заметки: последние 10 (можно только одного автора), у каждой кнопка Delete. Новые внизу, ближе к полю ввода.
      const from = arg ? "FROM suggestions s JOIN users u ON u.id = s.user_id WHERE s.status='approved' AND u.nick_lc=?" : "FROM suggestions s WHERE s.status='approved'";
      const q = (sql) => (arg ? env.DB.prepare(sql).bind(arg) : env.DB.prepare(sql));
      const rows = ((await q(`SELECT s.* ${from} ORDER BY s.id DESC LIMIT 10`).all()).results || []).reverse();
      if (!rows.length) return say(arg ? "No approved notes from that nickname." : "No approved notes.");
      for (const s of rows) await say(card(s), { reply_markup: keyboard(s, await isTrusted(env, s)) });
      const total = (await q(`SELECT COUNT(*) AS n ${from}`).first())?.n || 0;
      if (total > rows.length) await say(`Showing the latest ${rows.length} of ${total}. Delete some and send /approved again for the rest.`);
      return;
    }
    case "/user": {
      const u = await findUser();
      if (!u) return say("No such nickname.");
      const c = await env.DB.prepare("SELECT SUM(status='pending') AS p, SUM(status='approved') AS a, SUM(status='rejected') AS r FROM suggestions WHERE user_id=?").bind(u.id).first();
      const bk = await env.DB.prepare("SELECT size, updated FROM backups WHERE user_id=?").bind(u.id).first();
      const tr = await trustOf(env, u.id, c?.a || 0);
      const pn = (await env.DB.prepare("SELECT COUNT(*) AS n FROM pubpl WHERE user_id=?").bind(u.id).first())?.n || 0;
      const pf = await env.DB.prepare("SELECT public FROM profiles WHERE user_id=?").bind(u.id).first();
      const trust = tr.state === "yes" ? (tr.manual ? "trusted (set by you)" : "trusted") : tr.state === "paused" ? "paused" : `not yet (${tr.have} of ${tr.need} approved)`;
      return say(`${esc(u.nick)} (#${u.id})${u.banned ? " · banned" : ""}\nJoined: ${new Date(u.created * 1000).toISOString().slice(0, 10)}\nPending ${c?.p || 0} · Approved ${c?.a || 0} · Rejected ${c?.r || 0}\nTrust: ${trust}\nPublic playlists: ${pn} · Profile: ${pf?.public ? "public" : "private"}\nCloud backup: ${bk ? Math.ceil(bk.size / 1024) + " KB, " + new Date(bk.updated).toISOString().slice(0, 10) : "none"}`);
    }
    case "/trust": case "/untrust": {
      const u = await findUser();
      if (!u) return say("No such nickname.");
      const on = cmd.toLowerCase().startsWith("/trust");
      await setTrust(env, u.id, on ? 1 : -1);
      return say(on ? `${esc(u.nick)} is trusted: new notes without links go live at once.` : `Trust paused for ${esc(u.nick)}: new notes wait for review again. /trust ${esc(u.nick)} brings it back.`);
    }
    case "/reports": {
      const rows = (await env.DB.prepare(
        "SELECT s.*, (SELECT COUNT(*) FROM reports r WHERE r.sid=s.id AND r.resolved=0) AS rn, EXISTS(SELECT 1 FROM hidden h WHERE h.sid=s.id) AS hid "
        + "FROM suggestions s WHERE s.status='approved' AND EXISTS (SELECT 1 FROM reports r WHERE r.sid=s.id AND r.resolved=0) ORDER BY rn DESC, s.id DESC LIMIT 10"
      ).all()).results || [];
      const pls = (await env.DB.prepare(
        "SELECT p.*, COALESCE(u.nick,'') AS nick, (SELECT COUNT(*) FROM pl_reports r WHERE r.code=p.code AND r.resolved=0) AS rn, EXISTS(SELECT 1 FROM pl_hidden h WHERE h.code=p.code) AS hid "
        + "FROM pubpl p LEFT JOIN users u ON u.id=p.user_id WHERE EXISTS (SELECT 1 FROM pl_reports r WHERE r.code=p.code AND r.resolved=0) ORDER BY rn DESC, p.created DESC LIMIT 10"
      ).all()).results || [];
      if (!rows.length && !pls.length) return say("No open reports.");
      for (const s of rows) await say(await reportCard(env, s, !!s.hid), { reply_markup: reportKeyboard(s, await isTrusted(env, s)) });
      for (const p of pls) await say(await plReportCard(env, p, !!p.hid), { reply_markup: plReportKeyboard(p) });
      return;
    }
    case "/playlists": {
      // Публичные плейлисты: последние 10 (можно только одного автора), у каждого кнопка Delete. Новые внизу, ближе к полю ввода.
      const from = arg ? "FROM pubpl p JOIN users u ON u.id = p.user_id WHERE u.nick_lc=?" : "FROM pubpl p LEFT JOIN users u ON u.id = p.user_id";
      const q = (sql) => (arg ? env.DB.prepare(sql).bind(arg) : env.DB.prepare(sql));
      const rows = ((await q(`SELECT p.*, COALESCE(u.nick,'') AS nick ${from} ORDER BY p.created DESC LIMIT 10`).all()).results || []).reverse();
      if (!rows.length) return say(arg ? "No public playlists from that nickname." : "No public playlists.");
      for (const p of rows) await say(plCard(p), { reply_markup: plKeyboard(p) });
      const total = (await q(`SELECT COUNT(*) AS n ${from}`).first())?.n || 0;
      if (total > rows.length) await say(`Showing the latest ${rows.length} of ${total}. Delete some and send /playlists again for the rest.`);
      return;
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
  const ours = p.startsWith("/a/") || p === "/s" || p === "/s/mine" || p === "/tg" || p === "/stories/overlay" || p === "/pl" || p.startsWith("/pl/") || p.startsWith("/u/");
  if (!ours) return null;
  if (!env.DB) return p === "/tg" ? J({ ok: true }) : J({ error: "off" }, 503);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  try {
    if (p === "/tg" && m === "POST") return await tgHook(req, env);
    if (p === "/stories/overlay" && m === "GET") return await overlay(env, u);
    if (m !== "POST" && m !== "GET") return J({ error: "method" }, 405);
    // Читать публичные плейлисты и открытые профили можно без аккаунта
    if (m === "GET" && p === "/pl") return await plList(env, ip, u);
    if (m === "GET" && p.startsWith("/pl/")) { let c = ""; try { c = plCode(decodeURIComponent(p.slice(4))); } catch { /* битая запись пути */ } return await plGet(req, env, ip, c); }
    if (m === "GET" && p.startsWith("/u/")) return await profilePublic(env, ip, p.slice(3));
    if (m === "POST" && p === "/a/register") return await register(req, env, ip);
    if (m === "POST" && p === "/a/login") return await login(req, env, ip);
    if (m === "POST" && p === "/a/reset") return await reset(req, env, ip);
    const a = await authed(req, env);
    if (!a) return J({ error: "auth" }, 401);
    if (p === "/a/me" && m === "GET") return a.banned ? J({ error: "banned" }, 403) : await me(env, a);
    if (p === "/a/logout" && m === "POST") { await env.DB.prepare("DELETE FROM sessions WHERE th=?").bind(a.th).run(); return J({ ok: true }); }
    if (p === "/a/password" && m === "POST") return await changePassword(req, env, a);
    if (p === "/a/delete" && m === "POST") return await deleteAccount(req, env, a);
    if (p === "/a/backup" && m === "GET") return await getBackup(env, a, u.searchParams.get("full") === "1");
    if (p === "/a/backup" && m === "POST") return await putBackup(req, env, a);
    if (p === "/a/backup/delete" && m === "POST") return await delBackup(env, a);
    if (p === "/a/inbox" && m === "GET") return await inbox(env, a);
    if (p === "/a/inbox/seen" && m === "POST") return a.banned ? J({ error: "banned" }, 403) : await inboxSeen(req, env, a);
    if (p === "/a/vote" && m === "POST") return await vote(req, env, a);
    if (p === "/a/votes" && m === "GET") return await myVotes(env, a);
    if (p === "/a/report" && m === "POST") return await report(req, env, ip, ctx, a);
    if (p === "/a/pl" && m === "POST") return await plPublish(req, env, ip, ctx, a);
    if (p === "/a/pl/del" && m === "POST") return await plUnpublish(req, env, a);
    if (p === "/a/pl/mine" && m === "GET") return await plMine(env, a);
    if (p === "/a/pl/save" && m === "POST") return await plSave(req, env, a);
    if (p === "/a/pl/report" && m === "POST") return await plReport(req, env, ip, ctx, a);
    if (p === "/a/profile" && m === "GET") return await profileGet(env, a);
    if (p === "/a/profile" && m === "POST") return await profileSet(req, env, a);
    if (p === "/s" && m === "POST") return await suggest(req, env, ip, ctx, a);
    if (p === "/s/mine" && m === "GET") return await mine(env, a);
    return J({ error: "none" }, 404);
  } catch (e) {
    return J({ error: "server" }, 500);
  }
}
