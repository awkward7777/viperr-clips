import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { community } from "../community.js";
import { makeDB } from "./shim.mjs";

const SCHEMA = new URL("../schema.sql", import.meta.url).pathname;
const dk = (password, nick) => pbkdf2Sync(password, "viperr:v1:" + nick.toLowerCase(), 1000, 32, "sha256").toString("hex");
const TOKEN = "123:abc";
const ADMIN = 777;

function world({ tg = true, db = true } = {}) {
  const calls = [];
  let mid = 100;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: String(url).split("/").pop(), body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++mid } }));
  };
  const env = {};
  if (db) env.DB = makeDB(SCHEMA);
  if (tg) { env.TG_BOT_TOKEN = TOKEN; env.ADMIN_TG_ID = String(ADMIN); }
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  async function call(method, path, body, token, ip = "1.1.1.1", headers = {}) {
    const h = { "content-type": "application/json", "cf-connecting-ip": ip, ...headers };
    if (token) h.authorization = "Bearer " + token;
    const req = new Request("https://w.test" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await community(req, env, ctx);
    await Promise.all(pending.splice(0));
    if (!res) return null;
    return { status: res.status, json: await res.json() };
  }
  const reg = async (nick, pass = "secret123", ip) => (await call("POST", "/a/register", { nick, pw: dk(pass, nick) }, undefined, ip));
  const hook = async (update, secret) => {
    const s = secret ?? (await (async () => { const b = new TextEncoder().encode("viperr-tg:" + TOKEN); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map(x => x.toString(16).padStart(2, "0")).join(""); })());
    return call("POST", "/tg", update, undefined, "9.9.9.9", { "x-telegram-bot-api-secret-token": s });
  };
  return { env, call, reg, hook, calls };
}
const SUG = (over = {}) => ({ k: "rel-1:0", sec: "written", text: "Recorded at home in two days, mixed by a friend.", src: "https://example.com/interview", tt: "Song", ta: "Artist", ...over });

test("регистрация: успех, повтор ника, плохие и зарезервированные ники", async () => {
  const w = world();
  const a = await w.reg("Fan_One");
  assert.equal(a.status, 200);
  assert.ok(a.json.token.length >= 40);
  assert.match(a.json.recovery, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
  assert.equal((await w.reg("fan_one")).status, 409);
  for (const bad of ["ab", "admin", "Viperr_Fan", "a b", "x__y", "-abc", "Moderator77"]) assert.equal((await w.reg(bad)).status, 400, bad);
  assert.equal((await w.reg("Фанат")).status, 200);
  assert.equal((await w.call("POST", "/a/register", { nick: "okname", pw: "short" })).status, 400);
});

test("регистрация: лимит с одного адреса", async () => {
  const w = world();
  let last;
  for (let i = 0; i < 11; i++) last = await w.reg("user" + i, "secret123", "5.5.5.5");
  assert.equal(last.status, 429);
});

test("вход, блокировка после 5 ошибок, выход", async () => {
  const w = world();
  await w.reg("Fan_One");
  const ok = await w.call("POST", "/a/login", { nick: "FAN_ONE", pw: dk("secret123", "Fan_One") });
  assert.equal(ok.status, 200);
  const me = await w.call("GET", "/a/me", undefined, ok.json.token);
  assert.equal(me.json.nick, "Fan_One");
  assert.equal((await w.call("GET", "/a/me")).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("wrong" + i, "fan_one") })).status, 401);
  const locked = await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("secret123", "Fan_One") });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error, "locked");
  await w.env.DB.prepare("UPDATE users SET locked_until=0").run();
  const again = await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("secret123", "Fan_One") });
  assert.equal(again.status, 200);
  assert.equal((await w.call("POST", "/a/logout", {}, again.json.token)).status, 200);
  assert.equal((await w.call("GET", "/a/me", undefined, again.json.token)).status, 401);
  assert.equal((await w.call("POST", "/a/login", { nick: "nobody", pw: dk("x", "nobody") })).status, 401);
});

test("предложения: проверки полей, повтор, лимит новых аккаунтов, HTML в карточке экранируется", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  assert.equal((await w.call("POST", "/s", SUG())).status, 401);
  const r = await w.call("POST", "/s", SUG({ text: "He said <b>hi</b> & left right after the show." }), t);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "pending");
  const sent = w.calls.find(c => c.method === "sendMessage");
  assert.equal(sent.body.chat_id, String(ADMIN));
  assert.match(sent.body.text, /^📝 #1 · Fan_One/);
  assert.match(sent.body.text, /&lt;b&gt;hi&lt;\/b&gt; &amp; left/);
  assert.equal(sent.body.reply_markup.inline_keyboard[0][0].callback_data, "a:1");
  assert.equal((await w.call("POST", "/s", SUG({ k: "bad key" }), t)).status, 400);
  assert.equal((await w.call("POST", "/s", SUG({ sec: "nope" }), t)).status, 400);
  assert.equal((await w.call("POST", "/s", SUG({ text: "short" }), t)).status, 400);
  assert.equal((await w.call("POST", "/s", SUG({ src: "javascript:alert(1)" }), t)).status, 400);
  assert.equal((await w.call("POST", "/s", SUG({ text: "He said <b>hi</b> & left right after the show." }), t)).status, 409);
  assert.equal((await w.call("POST", "/s", SUG({ text: "Second distinct suggestion for the same track." }), t)).status, 200);
  assert.equal((await w.call("POST", "/s", SUG({ text: "Third distinct suggestion for the same track." }), t)).status, 429);
});

test("Telegram: чужой секрет, чужой пользователь, одобрить, правка ответом, отказ, бан", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  await w.call("POST", "/s", SUG({ text: "First suggestion that will be approved as is." }), t);
  await w.call("POST", "/s", SUG({ k: "rel-2:3", sec: "lyrics", text: "Second suggestion that the admin will edit." }), t);
  await w.call("POST", "/s", SUG({ k: "rel-3:1", sec: "quotes", text: "Third suggestion that will be rejected." }), t);
  assert.equal((await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/start" } }, "wrong")).status, 401);
  // не админ
  await w.hook({ callback_query: { id: "c0", from: { id: 5 }, data: "a:1", message: { chat: { id: 5 }, message_id: 1 } } });
  assert.equal((await w.env.DB.prepare("SELECT status FROM suggestions WHERE id=1").first()).status, "pending");
  assert.ok(w.calls.some(c => c.method === "answerCallbackQuery" && c.body.text === "Not allowed"));
  // одобрить
  await w.hook({ callback_query: { id: "c1", from: { id: ADMIN }, data: "a:1", message: { chat: { id: ADMIN }, message_id: 11 } } });
  let ov = await w.call("GET", "/stories/overlay");
  assert.equal(ov.json.notes["rel-1:0"][0].t, "First suggestion that will be approved as is.");
  assert.equal(ov.json.notes["rel-1:0"][0].by, "Fan_One");
  const v1 = ov.json.v;
  assert.deepEqual((await w.call("GET", "/stories/overlay?v=" + v1)).json, { v: v1, same: true });
  // повторное нажатие
  await w.hook({ callback_query: { id: "c1b", from: { id: ADMIN }, data: "r:1", message: { chat: { id: ADMIN }, message_id: 11 } } });
  assert.equal((await w.env.DB.prepare("SELECT status FROM suggestions WHERE id=1").first()).status, "approved");
  // правка ответом
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "Corrected text for the second one.", reply_to_message: { message_id: 12, text: "📝 #2 · Fan_One\n🎵 Artist — Song rel-2:3" } } });
  ov = await w.call("GET", "/stories/overlay");
  assert.equal(ov.json.notes["rel-2:3"][0].t, "Corrected text for the second one.");
  assert.ok(ov.json.v > v1);
  // отказ с причиной
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/no not verifiable", reply_to_message: { message_id: 13, text: "📝 #3 · Fan_One\n🎵 x" } } });
  const mine = await w.call("GET", "/s/mine", undefined, t);
  const by = Object.fromEntries(mine.json.items.map(i => [i.id, i]));
  assert.equal(by[1].status, "approved");
  assert.equal(by[2].status, "approved");
  assert.equal(by[2].text, "Corrected text for the second one.");
  assert.equal(by[3].status, "rejected");
  assert.equal(by[3].note, "not verifiable");
  const me = await w.call("GET", "/a/me", undefined, t);
  assert.deepEqual([me.json.pending, me.json.approved, me.json.rejected], [0, 2, 1]);
  // бан
  await w.call("POST", "/s", SUG({ k: "rel-9:9", text: "A suggestion that will be dropped by the ban." }), t).catch(() => {});
  await w.hook({ callback_query: { id: "c2", from: { id: ADMIN }, data: "b:1", message: { chat: { id: ADMIN }, message_id: 14 } } });
  assert.equal((await w.call("GET", "/a/me", undefined, t)).status, 401);
  assert.equal((await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("secret123", "Fan_One") })).json.error, "banned");
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/unban fan_one" } });
  assert.equal((await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("secret123", "Fan_One") })).status, 200);
});

test("Telegram: /start показывает ID, команды только для админа", async () => {
  const w = world();
  await w.hook({ message: { from: { id: 42 }, chat: { id: 42 }, text: "/start" } });
  assert.match(w.calls.at(-1).body.text, /Your Telegram ID: <code>42<\/code>/);
  const n = w.calls.length;
  await w.hook({ message: { from: { id: 42 }, chat: { id: 42 }, text: "/pending" } });
  assert.equal(w.calls.length, n);
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/stats" } });
  assert.match(w.calls.at(-1).body.text, /Users: 0/);
});

test("восстановление по коду, смена пароля, удаление аккаунта", async () => {
  const w = world();
  const a = (await w.reg("Fan_One")).json;
  const s1 = await w.call("POST", "/s", SUG({ text: "Approved fact that stays after account deletion." }), a.token);
  await w.call("POST", "/s", SUG({ k: "rel-2:0", text: "Pending fact that disappears with the account." }), a.token);
  await w.hook({ callback_query: { id: "c", from: { id: ADMIN }, data: "a:" + s1.json.id, message: { chat: { id: ADMIN }, message_id: 1 } } });
  // неверный код
  assert.equal((await w.call("POST", "/a/reset", { nick: "fan_one", code: "AAAAA-AAAAA-AAAAA-AAAAA", pw: dk("new-pass-1", "fan_one") })).status, 401);
  const rs = await w.call("POST", "/a/reset", { nick: "FAN_ONE", code: a.recovery.toLowerCase().replace(/-/g, " "), pw: dk("new-pass-1", "fan_one") });
  assert.equal(rs.status, 200);
  assert.notEqual(rs.json.recovery, a.recovery);
  assert.equal((await w.call("GET", "/a/me", undefined, a.token)).status, 401);
  assert.equal((await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("secret123", "fan_one") })).status, 401);
  assert.equal((await w.call("POST", "/a/reset", { nick: "fan_one", code: a.recovery, pw: dk("x", "fan_one") })).status, 401);
  let t = (await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("new-pass-1", "fan_one") })).json.token;
  // смена пароля
  assert.equal((await w.call("POST", "/a/password", { old: dk("bad", "fan_one"), pw: dk("p2", "fan_one") }, t)).status, 401);
  const t2 = (await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("new-pass-1", "fan_one") })).json.token;
  assert.equal((await w.call("POST", "/a/password", { old: dk("new-pass-1", "fan_one"), pw: dk("p2-new-pass", "fan_one") }, t)).status, 200);
  assert.equal((await w.call("GET", "/a/me", undefined, t2)).status, 401);
  assert.equal((await w.call("GET", "/a/me", undefined, t)).status, 200);
  // удаление
  assert.equal((await w.call("POST", "/a/delete", { pw: dk("wrong", "fan_one") }, t)).status, 401);
  assert.equal((await w.call("POST", "/a/delete", { pw: dk("p2-new-pass", "fan_one") }, t)).status, 200);
  assert.equal((await w.call("POST", "/a/login", { nick: "fan_one", pw: dk("p2-new-pass", "fan_one") })).status, 401);
  const ov = await w.call("GET", "/stories/overlay");
  assert.equal(ov.json.notes["rel-1:0"][0].by, "");
  assert.equal(ov.json.notes["rel-2:0"], undefined);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions").first()).n, 1);
  assert.equal((await w.reg("Fan_One")).status, 200);
});

test("без базы: маршруты сообщества отвечают off, чужие пути не трогаются", async () => {
  const w = world({ db: false });
  assert.equal((await w.call("POST", "/a/login", {})).status, 503);
  assert.equal((await w.call("GET", "/stories/overlay")).json.error, "off");
  assert.equal((await w.call("POST", "/tg", {})).status, 200);
  assert.equal(await w.call("GET", "/c/ABCD"), null);
});

test("перец создаётся один раз в meta; пустая лента заметок; чужие предложения не видны", async () => {
  const w = world();
  assert.deepEqual((await w.call("GET", "/stories/overlay")).json, { v: 0, notes: {} });
  assert.deepEqual((await w.call("GET", "/stories/overlay?v=0")).json, { v: 0, same: true });
  const a = (await w.reg("Fan_One")).json, b = (await w.reg("Fan_Two")).json;
  const p1 = (await w.env.DB.prepare("SELECT v FROM meta WHERE k='pepper'").first()).v;
  assert.match(p1, /^[0-9a-f]{64}$/);
  await w.call("POST", "/s", SUG({ text: "Only the first account wrote this suggestion." }), a.token);
  assert.equal((await w.call("GET", "/s/mine", undefined, a.token)).json.items.length, 1);
  assert.equal((await w.call("GET", "/s/mine", undefined, b.token)).json.items.length, 0);
  assert.equal((await w.env.DB.prepare("SELECT v FROM meta WHERE k='pepper'").first()).v, p1);
  // чужой пароль не подходит к другому нику, даже если ключи одинаковые по значению
  const same = dk("same-password", "x");
  assert.equal((await w.call("POST", "/a/register", { nick: "twin_a", pw: same })).status, 200);
  assert.equal((await w.call("POST", "/a/register", { nick: "twin_b", pw: same })).status, 200);
});

test("worker.js: старые маршруты совместимости работают рядом с сообществом", async () => {
  const { default: worker } = await import("../worker.js");
  const { makeKV } = await import("./shim.mjs");
  const env = { KV: makeKV(), DB: makeDB(SCHEMA) };
  const ctx = { waitUntil() {} };
  const h = { "content-type": "application/json", "cf-connecting-ip": "2.2.2.2" };
  const post = await worker.fetch(new Request("https://w.test/c", { method: "POST", headers: h, body: JSON.stringify({ t: ["1:0", "1:1", "2:0", "3:1", "4:2"], n: "test" }) }), env, ctx);
  assert.equal(post.status, 200);
  const { code } = await post.json();
  const got = await worker.fetch(new Request("https://w.test/c/" + code, { headers: h }), env, ctx);
  assert.equal((await got.json()).t.length, 5);
  const miss = await worker.fetch(new Request("https://w.test/c/ZZZZ", { headers: h }), env, ctx);
  assert.equal(miss.status, 404);
  const ov = await worker.fetch(new Request("https://w.test/stories/overlay", { headers: h }), env, ctx);
  assert.deepEqual(await ov.json(), { v: 0, notes: {} });
  const off = await worker.fetch(new Request("https://w.test/stories/overlay", { headers: h }), { KV: env.KV }, ctx);
  assert.equal(off.status, 503);
});

test("просроченные счётчики с IP и сессии вычищаются", async () => {
  const w = world();
  await w.reg("Fan_One");
  const db = w.env.DB;
  await db.prepare("INSERT INTO throttle(k,n,until) VALUES('old:1.2.3.4',3,1)").run();
  await db.prepare("INSERT INTO sessions(th,user_id,created,expires) VALUES('dead',1,1,2)").run();
  const rnd = Math.random;
  Math.random = () => 0;
  try { await w.call("POST", "/a/login", { nick: "nobody", pw: dk("x", "nobody") }, undefined, "7.7.7.7"); } finally { Math.random = rnd; }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE k='old:1.2.3.4'").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE th='dead'").first()).n, 0);
  assert.ok((await db.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n >= 1);
});
