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
  // приложение показывает разные тексты: «не подходит по форме» и «слово зарезервировано», а не одно общее про цифры и знаки
  for (const bad of ["ab", "a b", "x__y", "-abc"]) { const r = (await w.reg(bad)).json; assert.equal(r.error, "nick_bad", bad); assert.equal(r.why, undefined, bad); }
  for (const bad of ["admin", "Viperr_Fan", "Moderator77", "kaiangel_fan"]) { const r = (await w.reg(bad)).json; assert.equal(r.error, "nick_bad", bad); assert.equal(r.why, "reserved", bad); }
  // обычные имена без цифр, знаков и подчёркиваний проходят
  for (const ok of ["Lena", "Алиса", "kai.fan", "Nikita2005"]) assert.equal((await w.reg(ok)).status, 200, ok);
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

test("Telegram: одобренную заметку можно убрать (Delete с подтверждением), /approved показывает список, лента в приложении обновляется", async () => {
  const w = world();
  const a = (await w.reg("Fan_One")).json, b = (await w.reg("Фанат")).json;
  await w.call("POST", "/s", SUG({ text: "First test note that will be approved." }), a.token); // #1
  await w.call("POST", "/s", SUG({ k: "rel-2:3", text: "Second test note from the first account." }), a.token); // #2
  await w.call("POST", "/s", SUG({ k: "rel-3:1", text: "Third note from the second account, approved too." }), b.token); // #3
  await w.call("POST", "/s", SUG({ k: "rel-4:0", text: "Fourth note that stays pending for the whole test." }), b.token); // #4
  const tap = (data, from = ADMIN) => w.hook({ callback_query: { id: "q" + w.calls.length, from: { id: from }, data, message: { chat: { id: from }, message_id: 50 } } });
  const say = (text, from = ADMIN) => w.hook({ message: { from: { id: from }, chat: { id: from }, text } });
  const lastOf = (method) => w.calls.filter(c => c.method === method).at(-1).body;
  const answerText = () => lastOf("answerCallbackQuery").text;
  const row = (id) => w.env.DB.prepare("SELECT status FROM suggestions WHERE id=?").bind(id).first();
  const overlay = async () => (await w.call("GET", "/stories/overlay")).json;
  const cardsAfter = (n) => w.calls.slice(n).filter(c => c.method === "sendMessage");
  const btns = (c) => c.body.reply_markup.inline_keyboard[0][0].callback_data;

  for (const id of [1, 2, 3]) await tap("a:" + id);
  // сразу после одобрения у карточки есть кнопка Delete: ошибочное одобрение можно откатить на месте
  assert.deepEqual(lastOf("editMessageText").reply_markup.inline_keyboard, [[{ text: "🗑 Delete", callback_data: "d:3" }]]);
  let ov = await overlay();
  assert.deepEqual(Object.keys(ov.notes).sort(), ["rel-1:0", "rel-2:3", "rel-3:1"]);
  const v0 = ov.v;

  // /approved: три одобренные (новые внизу), у каждой Delete; ждущая #4 в список не попадает; не админу не отвечает
  let n = w.calls.length;
  await say("/approved");
  let cards = cardsAfter(n);
  assert.deepEqual(cards.map(btns), ["d:1", "d:2", "d:3"]);
  assert.match(cards[0].body.text, /^📝 #1 · Fan_One/);
  n = w.calls.length;
  await say("/approved fan_one");
  assert.deepEqual(cardsAfter(n).map(btns), ["d:1", "d:2"]);
  n = w.calls.length;
  await say("/approved ФАНАТ");
  assert.deepEqual(cardsAfter(n).map(btns), ["d:3"]);
  await say("/approved nobody");
  assert.match(lastOf("sendMessage").text, /No approved notes from that nickname/);
  n = w.calls.length;
  await say("/approved", 5);
  assert.equal(w.calls.length, n);

  // Delete только спрашивает подтверждение и ничего не стирает; Cancel возвращает кнопку Delete
  await tap("d:1");
  assert.deepEqual(lastOf("editMessageReplyMarkup").reply_markup.inline_keyboard[0].map(x => x.callback_data), ["y:1", "n:1"]);
  assert.equal((await row(1)).status, "approved");
  assert.equal((await overlay()).v, v0);
  await tap("n:1");
  assert.deepEqual(lastOf("editMessageReplyMarkup").reply_markup.inline_keyboard, [[{ text: "🗑 Delete", callback_data: "d:1" }]]);
  assert.equal(answerText(), "Cancelled");
  // не админ удалить не может
  await tap("y:1", 5);
  assert.equal(answerText(), "Not allowed");
  assert.equal((await row(1)).status, "approved");

  // подтверждение удаляет: строка исчезает, карточка становится «Deleted» без кнопок, лента заметок пересобрана
  await tap("d:1");
  await tap("y:1");
  assert.equal(await row(1), null);
  assert.match(lastOf("editMessageText").text, /🗑 <b>Deleted<\/b>/);
  assert.equal(lastOf("editMessageText").reply_markup, undefined);
  assert.equal(answerText(), "Deleted");
  ov = await overlay();
  assert.deepEqual(Object.keys(ov.notes).sort(), ["rel-2:3", "rel-3:1"]);
  assert.ok(ov.v > v0);
  // приложение со старой версией получит новую ленту уже без этой заметки
  const old = (await w.call("GET", "/stories/overlay?v=" + v0)).json;
  assert.equal(old.v, ov.v);
  assert.equal(old.notes["rel-1:0"], undefined);
  assert.deepEqual((await w.call("GET", "/stories/overlay?v=" + ov.v)).json, { v: ov.v, same: true });

  // старая кнопка по уже удалённой заметке: ничего не ломается, версия ленты не растёт
  await tap("y:1");
  assert.equal(answerText(), "Already deleted");
  await tap("d:1");
  assert.equal(answerText(), "Already deleted");
  assert.equal((await overlay()).v, ov.v);
  // ждущее предложение этими кнопками не удалить
  for (const d of ["d:4", "y:4", "n:4"]) {
    await tap(d);
    assert.equal(answerText(), "Not published, nothing to delete", d);
  }
  assert.equal((await row(4)).status, "pending");
  assert.equal((await overlay()).v, ov.v);

  // автор не видит удалённую в своём списке, счётчики сходятся
  assert.deepEqual((await w.call("GET", "/s/mine", undefined, a.token)).json.items.map(i => i.id), [2]);
  await say("/stats");
  assert.match(lastOf("sendMessage").text, /Pending: 1 · Approved: 2 · Rejected: 0/);

  // правка ответом на карточку тоже оставляет кнопку Delete
  const s5 = await w.call("POST", "/s", SUG({ k: "rel-5:0", text: "Fifth note, the admin will fix it by replying." }), b.token);
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "Fifth note, fixed by the admin.", reply_to_message: { message_id: 61, text: `📝 #${s5.json.id} · Фанат\n🎵 x` } } });
  assert.deepEqual(w.calls.filter(c => c.method === "editMessageText").at(-1).body.reply_markup.inline_keyboard, [[{ text: "🗑 Delete", callback_data: "d:" + s5.json.id }]]);

  // убрали всё: лента пустая, но версия выросла, поэтому приложение её заберёт
  const before = (await overlay()).v;
  for (const id of [2, 3, s5.json.id]) { await tap("d:" + id); await tap("y:" + id); }
  ov = await overlay();
  assert.deepEqual(ov.notes, {});
  assert.ok(ov.v > before);

  // длинный список: показываем 10 последних и говорим, сколько всего (заметки без автора, как после удаления аккаунта)
  for (let i = 0; i < 12; i++) {
    await w.env.DB.prepare("INSERT INTO suggestions(user_id,nick,k,section,text,status,created,decided) VALUES(NULL,'',?,'other',?,'approved',1,1)").bind("rel-9:" + i, "Bulk note number " + i + " for the list limit.").run();
  }
  n = w.calls.length;
  await say("/approved");
  cards = cardsAfter(n);
  assert.equal(cards.length, 11);
  assert.match(cards.at(-1).body.text, /Showing the latest 10 of 12/);
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

test("worker.js: тело без Content-Length считается по тексту, а JSON не объект даёт 400, а не 500", async () => {
  const { default: worker } = await import("../worker.js");
  const { makeKV } = await import("./shim.mjs");
  const env = { KV: makeKV(), DB: makeDB(SCHEMA) };
  const ctx = { waitUntil() {} };
  const h = { "content-type": "application/json", "cf-connecting-ip": "3.3.3.3" };
  const send = (path, body) => worker.fetch(new Request("https://w.test" + path, { method: "POST", headers: h, body }), env, ctx);
  assert.equal((await send("/c", "x".repeat(9000))).status, 413);
  assert.equal((await send("/t", "x".repeat(400001))).status, 413);
  for (const path of ["/c", "/t"]) {
    for (const body of ["null", "5", '"s"', "true", "[]", "{"]) {
      assert.equal((await send(path, body)).status, 400, path + " " + body);
    }
  }
  // обычный запрос по-прежнему проходит
  const ok = await send("/c", JSON.stringify({ t: ["1:0", "1:1", "2:0", "3:1", "4:2"], n: "ok" }));
  assert.equal(ok.status, 200);
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

// ───────── Облачная копия и «Входящие» ─────────

const BK = (extra = {}) => JSON.stringify({ app: "viperr-backup", v: 1, t: 1, prefs: { viperr: { fav: { s: "a" } } }, photos: {}, ...extra });

test("облачная копия: загрузка, чтение, подпись, чужим недоступна, удаление", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  const o = (await w.reg("Other_Fan")).json.token;
  assert.equal((await w.call("GET", "/a/backup")).status, 401);
  assert.equal((await w.call("POST", "/a/backup", { d: BK(), base: 0 })).status, 401);
  assert.deepEqual((await w.call("GET", "/a/backup", undefined, t)).json, { has: false });
  assert.equal((await w.call("GET", "/a/me", undefined, t)).json.backup, null);

  const data = BK({ photos: { "cover1.jpg": "AAAA/BBBB==" } });
  const up = await w.call("POST", "/a/backup", { d: data, base: 0, device: "Pixel 7\nfake line", info: { pl: 3, fav: 120, x: 9, ph: -1 } }, t);
  assert.equal(up.status, 200);
  assert.equal(up.json.size, new TextEncoder().encode(data).length);
  assert.equal(up.json.device, "Pixel 7\nfake line".replace("\n", " "));

  // сведения без самой копии: подпись очищена от лишнего
  const meta = (await w.call("GET", "/a/backup", undefined, t)).json;
  assert.equal(meta.has, true);
  assert.equal(meta.updated, up.json.updated);
  assert.deepEqual(meta.info, { pl: 3, fav: 120 });
  assert.equal(meta.d, undefined);
  // сама копия приходит байт в байт
  const full = (await w.call("GET", "/a/backup?full=1", undefined, t)).json;
  assert.equal(full.d, data);
  assert.equal((await w.call("GET", "/a/me", undefined, t)).json.backup.device, "Pixel 7 fake line");

  // у другого человека копии нет, и удалить чужую он не может
  assert.deepEqual((await w.call("GET", "/a/backup", undefined, o)).json, { has: false });
  assert.equal((await w.call("POST", "/a/backup/delete", {}, o)).status, 200);
  assert.equal((await w.call("GET", "/a/backup", undefined, t)).json.has, true);

  assert.equal((await w.call("POST", "/a/backup/delete", {}, t)).status, 200);
  assert.deepEqual((await w.call("GET", "/a/backup", undefined, t)).json, { has: false });
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM backups").first()).n, 0);
});

test("облачная копия: свежий телефон не затирает чужую копию без подтверждения", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  const first = (await w.call("POST", "/a/backup", { d: BK(), base: 0, device: "Old phone" }, t)).json;
  // новый телефон ещё не видел копию (base 0): сервер просит подтвердить и сообщает, что лежит в облаке
  const stale = await w.call("POST", "/a/backup", { d: BK({ t: 2 }), base: 0, device: "New phone" }, t);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, "stale");
  assert.equal(stale.json.device, "Old phone");
  assert.equal(stale.json.updated, first.updated);
  assert.equal((await w.call("GET", "/a/backup?full=1", undefined, t)).json.d, BK());
  // с верным base (телефон опирается на последнюю копию) обновление проходит, метка времени растёт
  const next = await w.call("POST", "/a/backup", { d: BK({ t: 3 }), base: first.updated, device: "Old phone" }, t);
  assert.equal(next.status, 200);
  assert.ok(next.json.updated > first.updated);
  // устаревший base после чужой записи снова 409, а force: true записывает сознательно
  assert.equal((await w.call("POST", "/a/backup", { d: BK({ t: 4 }), base: first.updated }, t)).status, 409);
  assert.equal((await w.call("POST", "/a/backup", { d: BK({ t: 4 }), base: first.updated, force: true, device: "New phone" }, t)).status, 200);
  assert.equal((await w.call("GET", "/a/backup", undefined, t)).json.device, "New phone");
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM backups").first()).n, 1);
});

test("облачная копия: плохие данные, слишком большая (считаются байты), лимиты", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  for (const bad of [undefined, 5, "short", "x".repeat(40), JSON.stringify({ app: "other", prefs: {} }), JSON.stringify({ app: "viperr-backup" }), JSON.stringify({ app: "viperr-backup", prefs: 5 }), "[1,2,3,4,5,6,7,8,9,10,11,12,13,14]"]) {
    const r = await w.call("POST", "/a/backup", { d: bad, base: 0 }, t);
    assert.equal(r.status, 400, String(bad).slice(0, 30));
  }
  assert.equal((await w.call("POST", "/a/backup", "nope", t)).status, 400);
  // 1,6 МБ в байтах, хотя символов вдвое меньше: русские буквы занимают по два байта
  assert.equal((await w.call("POST", "/a/backup", { d: BK({ photos: { a: "я".repeat(800000) } }), base: 0 }, t)).status, 413);
  assert.equal((await w.call("POST", "/a/backup", { d: BK({ photos: { a: "x".repeat(1500000) } }), base: 0 }, t)).status, 413);
  assert.equal((await w.call("POST", "/a/backup", { d: BK({ photos: { a: "x".repeat(1400000) } }), base: 0 }, t)).status, 200);
  assert.equal((await w.call("GET", "/a/backup?full=1", undefined, t)).json.d.length > 1400000, true);
  // не больше 30 записей в сутки
  let last;
  for (let i = 0; i < 40; i++) last = await w.call("POST", "/a/backup", { d: BK({ t: i }), base: 0, force: true }, t);
  assert.equal(last.status, 429);
  assert.equal(last.json.error, "limit");
  // скачивать целиком можно не чаще 20 раз в час
  let r;
  for (let i = 0; i < 22; i++) r = await w.call("GET", "/a/backup?full=1", undefined, t);
  assert.equal(r.status, 429);
});

test("облачная копия: общий предел места на сервере и удаление вместе с аккаунтом", async () => {
  const w = world();
  const a = (await w.reg("Fan_One")).json.token;
  const b = (await w.reg("Other_Fan")).json.token;
  // условно занято почти всё место: новая копия не принимается, а замена уже существующей проходит
  await w.env.DB.prepare("INSERT INTO backups(user_id,data,size,updated) VALUES(99,'{}',2499999990,1)").run();
  const r = await w.call("POST", "/a/backup", { d: BK(), base: 0 }, a);
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "cap");
  await w.env.DB.prepare("DELETE FROM backups WHERE user_id=99").run();
  assert.equal((await w.call("POST", "/a/backup", { d: BK(), base: 0 }, a)).status, 200);
  assert.equal((await w.call("POST", "/a/backup", { d: BK(), base: 0 }, b)).status, 200);
  // удаление аккаунта убирает его копию и «Входящие», чужие остаются
  await w.env.DB.prepare("INSERT INTO inbox(user_id,kind,created) VALUES(1,'approved',1),(2,'approved',1)").run();
  assert.equal((await w.call("POST", "/a/delete", { pw: dk("secret123", "Fan_One") }, a)).status, 200);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM backups WHERE user_id=1").first()).n, 0);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE user_id=1").first()).n, 0);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM backups WHERE user_id=2").first()).n, 1);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE user_id=2").first()).n, 1);
});

test("входящие: решения модератора доходят до автора, прочитанное отмечается, чужие записи недоступны", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  const o = (await w.reg("Other_Fan")).json.token;
  await w.call("POST", "/s", SUG({ text: "First note, to be approved as it is." }), t); // #1
  await w.call("POST", "/s", SUG({ k: "rel-2:3", tt: "Song Two", ta: "Artist Two", text: "Second note that the moderator will fix." }), t); // #2
  await w.call("POST", "/s", SUG({ k: "rel-3:1", text: "Third note that cannot be verified at all." }), t); // #3
  assert.deepEqual((await w.call("GET", "/a/inbox", undefined, t)).json, { unread: 0, items: [] });
  const tap = (data) => w.hook({ callback_query: { id: "q" + w.calls.length, from: { id: ADMIN }, data, message: { chat: { id: ADMIN }, message_id: 50 } } });
  await tap("a:1");
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "Second note, fixed by the moderator.", reply_to_message: { message_id: 12, text: "📝 #2 · Fan_One\n🎵 Artist — Song rel-2:3" } } });
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/no not verifiable", reply_to_message: { message_id: 13, text: "📝 #3 · Fan_One\n🎵 x" } } });
  await tap("d:1"); await tap("y:1"); // убрана уже опубликованная заметка

  const box = (await w.call("GET", "/a/inbox", undefined, t)).json;
  assert.equal(box.unread, 4);
  assert.deepEqual(box.items.map(i => i.kind), ["removed", "rejected", "edited", "approved"]);
  assert.deepEqual(box.items.map(i => i.ref), [1, 3, 2, 1]);
  assert.equal(box.items[1].text, "not verifiable");
  assert.equal(box.items[2].text, "Second note, fixed by the moderator.");
  assert.equal(box.items[2].tt, "Song Two");
  assert.equal(box.items[2].ta, "Artist Two");
  assert.equal(box.items[3].text, "");
  assert.equal(box.items[0].seen, false);
  assert.equal((await w.call("GET", "/a/me", undefined, t)).json.unread, 4);

  // чужой ящик пуст, и отметить чужое прочитанным нельзя
  assert.deepEqual((await w.call("GET", "/a/inbox", undefined, o)).json, { unread: 0, items: [] });
  assert.equal((await w.call("POST", "/a/inbox/seen", {}, o)).status, 200);
  assert.equal((await w.call("GET", "/a/inbox", undefined, t)).json.unread, 4);

  // «до номера»: два старых прочитаны, два новых нет
  const upTo = box.items[2].id;
  assert.equal((await w.call("POST", "/a/inbox/seen", { upTo }, t)).status, 200);
  const half = (await w.call("GET", "/a/inbox", undefined, t)).json;
  assert.equal(half.unread, 2);
  assert.deepEqual(half.items.map(i => i.seen), [false, false, true, true]);
  // без номера прочитано всё
  await w.call("POST", "/a/inbox/seen", {}, t);
  assert.equal((await w.call("GET", "/a/me", undefined, t)).json.unread, 0);
  assert.equal((await w.call("GET", "/a/inbox")).status, 401);
});

test("входящие: хранятся последние 100, у удалённого автора записей нет и ошибок тоже", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  const ins = w.env.DB.prepare("INSERT INTO inbox(user_id,kind,ref,created) VALUES(1,'approved',?,1)");
  for (let i = 0; i < 105; i++) await ins.bind(1000 + i).run();
  await w.call("POST", "/s", SUG({ text: "A note that will push the old ones out." }), t); // #1
  await w.hook({ callback_query: { id: "c1", from: { id: ADMIN }, data: "a:1", message: { chat: { id: ADMIN }, message_id: 11 } } });
  const box = (await w.call("GET", "/a/inbox", undefined, t)).json;
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE user_id=1").first()).n, 100);
  assert.equal(box.items.length, 50);
  assert.equal(box.items[0].ref, 1);

  // автор удалил аккаунт, а заметка осталась без ника: модератор убирает её, ничего не падает, нового ящика не появляется
  assert.equal((await w.call("POST", "/a/delete", { pw: dk("secret123", "Fan_One") }, t)).status, 200);
  await w.hook({ callback_query: { id: "c2", from: { id: ADMIN }, data: "y:1", message: { chat: { id: ADMIN }, message_id: 11 } } });
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE id=1").first()).n, 0);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM inbox").first()).n, 0);
});

test("Telegram: /stats и /user показывают облачные копии", async () => {
  const w = world();
  const t = (await w.reg("Fan_One")).json.token;
  await w.call("POST", "/a/backup", { d: BK({ photos: { a: "x".repeat(2048) } }), base: 0, device: "Pixel" }, t);
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/stats" } });
  assert.match(w.calls.at(-1).body.text, /Cloud backups: 1 \(0\.0 MB of 2384 MB\)/);
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/user fan_one" } });
  assert.match(w.calls.at(-1).body.text, /Cloud backup: \d+ KB, \d{4}-\d{2}-\d{2}/);
  await w.call("POST", "/a/backup/delete", {}, t);
  await w.hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN }, text: "/user fan_one" } });
  assert.match(w.calls.at(-1).body.text, /Cloud backup: none/);
});

// ───────── Доверие, голоса «Полезно», жалобы ─────────

/** Команды модератора в Telegram и несколько коротких проверок. */
const mod = (w) => ({
  tap: (data, from = ADMIN, message = {}) => w.hook({ callback_query: { id: "q" + w.calls.length, from: { id: from }, data, message: { chat: { id: from }, message_id: 70, ...message } } }),
  say: (text, from = ADMIN) => w.hook({ message: { from: { id: from }, chat: { id: from }, text } }),
  lastOf: (method) => w.calls.filter(c => c.method === method).at(-1)?.body,
  cards: (n, method = "sendMessage") => w.calls.slice(n).filter(c => c.method === method).map(c => c.body),
  status: async (id) => (await w.env.DB.prepare("SELECT status FROM suggestions WHERE id=?").bind(id).first())?.status ?? null,
  overlay: async (q = "") => (await w.call("GET", "/stories/overlay" + q)).json,
  count: async (t) => (await w.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n,
  kb: (b) => b.reply_markup.inline_keyboard.map(r => r.map(x => x.callback_data))
});
const PLAIN = (i, over = {}) => SUG({ k: "rel-" + i + ":0", src: "", text: "A plain note number " + i + " about the recording.", ...over });

test("доверие: после трёх одобренных заметок новые выходят сразу; ссылки, повторы и лишнее идут на проверку; модератор приостанавливает и возвращает", async () => {
  const w = world(), m = mod(w);
  const a = (await w.reg("Fan_One")).json;
  const meTrust = async (t = a.token) => (await w.call("GET", "/a/me", undefined, t)).json.trust;
  assert.deepEqual(await meTrust(), { state: "no", have: 0, need: 3 });
  for (const i of [1, 2, 3]) assert.equal((await w.call("POST", "/s", PLAIN(i), a.token)).json.status, "pending");
  await m.tap("a:1"); await m.tap("a:2");
  assert.equal(m.lastOf("answerCallbackQuery").text, "Approved");
  assert.deepEqual(await meTrust(), { state: "no", have: 2, need: 3 });
  await m.tap("a:3");
  assert.equal(m.lastOf("answerCallbackQuery").text, "Approved · author is now trusted");
  assert.deepEqual(await meTrust(), { state: "yes", have: 3, need: 3 });
  assert.deepEqual((await w.call("GET", "/a/inbox", undefined, a.token)).json.items.map(i => i.kind), ["trusted", "approved", "approved", "approved"]);

  // дальше заметка без ссылок выходит сразу: она уже в ленте, а модератору приходит карточка с Delete и Pause trust
  await w.env.DB.prepare("UPDATE users SET created=created-864000").run();   // не «новичок»: в сутки можно 10 заметок, а не 3
  let n = w.calls.length;
  const live = await w.call("POST", "/s", PLAIN(4), a.token);
  assert.deepEqual([live.status, live.json.status], [200, "approved"]);
  assert.equal(await m.status(live.json.id), "approved");
  assert.ok((await m.overlay()).notes["rel-4:0"]);
  const c1 = m.cards(n)[0];
  assert.match(c1.text, /^📝 #4 · Fan_One/);
  assert.match(c1.text, /⚡ <b>Published at once<\/b>/);
  assert.deepEqual(m.kb(c1), [["d:4"], ["t:1"]]);

  // ссылка в поле источника или в самом тексте: сначала проверка, как у новичка
  assert.equal((await w.call("POST", "/s", PLAIN(5, { src: "https://example.com/x" }), a.token)).json.status, "pending");
  assert.equal((await w.call("POST", "/s", PLAIN(6, { text: "Mentioned in an interview, see https://youtu.be/abc for details." }), a.token)).json.status, "pending");
  assert.equal((await w.call("POST", "/s", PLAIN(7, { text: "He says the full version is on kaiangel.ru right now." }), a.token)).json.status, "pending");
  // тот же текст ещё раз не проходит, даже когда заметка уже опубликована
  assert.equal((await w.call("POST", "/s", PLAIN(4), a.token)).status, 409);

  // Pause trust с карточки: кнопка пропадает, заметки снова ждут проверки, автору приходит запись
  await m.tap("t:1", ADMIN, { reply_markup: { inline_keyboard: c1.reply_markup.inline_keyboard } });
  assert.match(m.lastOf("answerCallbackQuery").text, /Trust paused for Fan_One/);
  assert.deepEqual(m.kb(m.lastOf("editMessageReplyMarkup")), [["d:4"]]);
  assert.equal((await meTrust()).state, "paused");
  assert.equal((await w.call("POST", "/s", PLAIN(8), a.token)).json.status, "pending");
  assert.equal((await w.call("GET", "/a/inbox", undefined, a.token)).json.items[0].kind, "paused");
  // три одобренные заметки приостановленное доверие не возвращают, а следующее одобрение не пишет «доверенный» заново
  await m.tap("a:8");
  assert.equal(m.lastOf("answerCallbackQuery").text, "Approved");
  assert.equal((await meTrust()).state, "paused");

  // /user и /trust: состояние видно, команды только для админа, возвращённое доверие работает
  await m.say("/user fan_one");
  assert.match(m.lastOf("sendMessage").text, /Trust: paused/);
  const calls = w.calls.length;
  await m.say("/trust fan_one", 5);
  assert.equal(w.calls.length, calls);
  assert.equal((await meTrust()).state, "paused");
  await m.say("/trust fan_one");
  assert.match(m.lastOf("sendMessage").text, /Fan_One is trusted/);
  await m.say("/user fan_one");
  assert.match(m.lastOf("sendMessage").text, /Trust: trusted \(set by you\)/);
  assert.equal((await w.call("GET", "/a/inbox", undefined, a.token)).json.items[0].kind, "trusted");
  assert.equal((await w.call("POST", "/s", PLAIN(9), a.token)).json.status, "approved");
  await m.say("/trust nobody");
  assert.match(m.lastOf("sendMessage").text, /No such nickname/);

  // доверие, выданное вручную, работает и без трёх одобренных; без проверки выходит не больше 5 заметок в сутки
  const b = (await w.reg("Fan_Two", "secret123", "2.2.2.2")).json;
  assert.deepEqual(await meTrust(b.token), { state: "no", have: 0, need: 3 });
  await m.say("/trust fan_two");
  await w.env.DB.prepare("UPDATE users SET created=created-864000 WHERE nick_lc='fan_two'").run();
  const sts = [];
  for (let i = 20; i < 27; i++) sts.push((await w.call("POST", "/s", PLAIN(i), b.token)).json.status);
  assert.deepEqual(sts, ["approved", "approved", "approved", "approved", "approved", "pending", "pending"]);
  await m.say("/untrust fan_two");
  assert.match(m.lastOf("sendMessage").text, /Trust paused for Fan_Two/);

  // счётчики для модератора
  await m.say("/stats");
  assert.match(m.lastOf("sendMessage").text, /Trusted authors: 1 · Helpful votes: 0\nOpen reports: 0 \(hidden 0\)/);
  await m.say("/help");
  assert.match(m.lastOf("sendMessage").text, /\/reports/);
  assert.match(m.lastOf("sendMessage").text, /\/trust nick · \/untrust nick/);
});

test("доверие: забаненный автор не публикует; старые приложения видят обычный ответ", async () => {
  const w = world(), m = mod(w);
  const a = (await w.reg("Fan_One")).json;
  await m.say("/trust fan_one");
  await w.env.DB.prepare("UPDATE users SET created=created-864000").run();
  const ok = await w.call("POST", "/s", PLAIN(1), a.token);
  assert.deepEqual(ok.json, { ok: true, id: 1, status: "approved" });
  await m.say("/ban fan_one");
  assert.equal((await w.call("POST", "/s", PLAIN(2), a.token)).status, 401);
  assert.equal((await w.call("POST", "/a/vote", { id: 1 }, a.token)).status, 401);
  assert.equal((await w.call("POST", "/a/report", { id: 1, why: "spam" }, a.token)).status, 401);
});

test("голоса «Полезно»: один голос на аккаунт, свою заметку нельзя, счётчик в ленте, запись автору на 5 голосах, чистка при удалении заметки", async () => {
  const w = world(), m = mod(w);
  const a = (await w.reg("Fan_One")).json;
  const vs = [];
  for (let i = 1; i <= 5; i++) vs.push((await w.reg("Voter" + i, "secret123", "3.3.3." + i)).json);
  await w.call("POST", "/s", SUG({ text: "A note that people will find useful." }), a.token);                      // #1
  await w.call("POST", "/s", SUG({ k: "rel-2:0", text: "A note that is still waiting for the moderator." }), a.token); // #2, ждёт
  await m.tap("a:1");
  const vote = (t, id = 1, on) => w.call("POST", "/a/vote", { id, ...(on === undefined ? {} : { on }) }, t);
  const helpful = async () => (await w.call("GET", "/a/inbox", undefined, a.token)).json.items.filter(i => i.kind === "helpful");

  assert.equal((await w.call("POST", "/a/vote", { id: 1 })).status, 401);
  assert.equal((await w.call("GET", "/a/votes")).status, 401);
  assert.equal((await vote(a.token)).json.error, "own");
  assert.equal((await vote(vs[0].token, 2)).json.error, "gone");      // ещё не опубликована
  assert.equal((await vote(vs[0].token, 999)).json.error, "gone");
  assert.equal((await w.call("POST", "/a/vote", { id: "x" }, vs[0].token)).json.error, "bad");
  assert.equal((await w.call("POST", "/a/vote", {}, vs[0].token)).json.error, "bad");
  assert.equal((await m.overlay()).votes, undefined);                 // голосов нет: поля в ответе нет

  assert.deepEqual((await vote(vs[0].token)).json, { ok: true, id: 1, n: 1, mine: true });
  assert.equal((await vote(vs[0].token)).json.n, 1);                  // повторный голос ничего не меняет
  assert.deepEqual((await w.call("GET", "/a/votes", undefined, vs[0].token)).json.ids, [1]);
  assert.deepEqual((await w.call("GET", "/a/votes", undefined, vs[1].token)).json.ids, []);
  const ov = await m.overlay();
  assert.deepEqual(ov.votes, { 1: 1 });
  assert.deepEqual(await m.overlay("?v=" + ov.v), { v: ov.v, same: true, votes: { 1: 1 } });   // и при «не изменилось» счётчики приходят

  for (const x of vs.slice(1, 4)) await vote(x.token);                // 2, 3, 4 голоса
  assert.equal((await helpful()).length, 0);
  assert.equal((await vote(vs[4].token)).json.n, 5);
  assert.deepEqual((await helpful()).map(i => [i.text, i.ref, i.k]), [["5", 1, "rel-1:0"]]);
  // голос можно снять и поставить снова: запись автору второй раз не приходит
  assert.deepEqual((await vote(vs[4].token, 1, false)).json, { ok: true, id: 1, n: 4, mine: false });
  assert.equal((await vote(vs[4].token, 1, false)).json.n, 4);
  assert.equal((await vote(vs[4].token)).json.n, 5);
  assert.equal((await helpful()).length, 1);
  assert.equal((await w.call("GET", "/s/mine", undefined, a.token)).json.items.find(i => i.id === 1).votes, 5);

  // заметку убрали: голоса и счётчик уходят вместе с ней
  await m.tap("d:1"); await m.tap("y:1");
  assert.equal(await m.count("votes"), 0);
  assert.equal(await m.count("vote_n"), 0);
  assert.equal((await m.overlay()).votes, undefined);

  // не больше 120 голосов в час с одного аккаунта
  const codes = [];
  for (let i = 0; i < 125; i++) codes.push((await vote(vs[0].token, 999)).status);
  assert.equal(codes.filter(c => c === 429).length > 0, true);
});

test("жалобы: карточка модератору, одна жалоба на аккаунт, после трёх заметка скрыта, Keep возвращает, Delete с подтверждением чистит всё", async () => {
  const w = world(), m = mod(w);
  const a = (await w.reg("Fan_One")).json;
  const rs = [];
  for (let i = 1; i <= 5; i++) rs.push((await w.reg("Reporter" + i, "secret123", "4.4.4." + i)).json);
  await w.call("POST", "/s", SUG({ text: "A note that somebody will report as spam." }), a.token);                    // #1
  await w.call("POST", "/s", SUG({ k: "rel-2:0", text: "A second note, still waiting for the moderator." }), a.token); // #2, ждёт
  await m.tap("a:1");
  const rep = (t, id = 1, why = "spam") => w.call("POST", "/a/report", { id, why }, t);
  const keyboard = [["x:1", "k:1"], ["b:" + a.id]];

  assert.equal((await w.call("POST", "/a/report", { id: 1, why: "spam" })).status, 401);
  assert.equal((await rep(a.token)).json.error, "own");
  assert.equal((await rep(rs[0].token, 2)).json.error, "gone");        // ждущую жалобой не закрыть
  assert.equal((await rep(rs[0].token, 1, "because")).json.error, "bad");
  assert.equal((await w.call("POST", "/a/report", { why: "spam" }, rs[0].token)).json.error, "bad");

  // первая жалоба: карточка модератору с причиной и кнопками
  let n = w.calls.length;
  assert.deepEqual((await rep(rs[0].token)).json, { ok: true });
  let cs = m.cards(n);
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /^🚩 #1 · Fan_One/);
  assert.match(cs[0].text, /Reports: 1 \(spam ×1\)/);
  assert.deepEqual(m.kb(cs[0]), keyboard);

  // повтор с того же аккаунта игнорируется; вторая жалоба от другого карточку не шлёт и заметку не прячет
  n = w.calls.length;
  assert.deepEqual((await rep(rs[0].token)).json, { ok: true, dup: true });
  assert.deepEqual((await rep(rs[1].token, 1, "offensive")).json, { ok: true });
  assert.equal(m.cards(n).length, 0);
  const v0 = (await m.overlay()).v;
  assert.ok((await m.overlay()).notes["rel-1:0"]);

  // третья жалоба прячет заметку из ленты и шлёт вторую карточку
  n = w.calls.length;
  assert.deepEqual((await rep(rs[2].token, 1, "wrong")).json, { ok: true });
  cs = m.cards(n);
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /Reports: 3 \(.*spam ×1.*\)/);
  assert.match(cs[0].text, /🙈 <b>Hidden<\/b>/);
  const ov = await m.overlay();
  assert.equal(ov.notes["rel-1:0"], undefined);
  assert.ok(ov.v > v0);
  assert.equal(await m.status(1), "approved");                         // в базе заметка осталась
  const mine = (await w.call("GET", "/s/mine", undefined, a.token)).json.items.find(i => i.id === 1);
  assert.deepEqual([mine.status, mine.hidden], ["approved", true]);
  assert.equal((await w.call("POST", "/a/vote", { id: 1 }, rs[3].token)).json.error, "gone");   // за скрытую не проголосовать
  n = w.calls.length;
  await rep(rs[3].token);                                              // четвёртая: карточки нет, заметка уже скрыта
  assert.equal(m.cards(n).length, 0);

  // /reports показывает открытые жалобы
  n = w.calls.length;
  await m.say("/reports");
  cs = m.cards(n);
  assert.equal(cs.length, 1);
  assert.match(cs[0].text, /Reports: 4/);
  assert.match(cs[0].text, /🙈 <b>Hidden<\/b>/);
  await m.say("/stats");
  assert.match(m.lastOf("sendMessage").text, /Open reports: 1 \(hidden 1\)/);

  // не админ ничего нажать не может
  await m.tap("k:1", 5);
  assert.equal(m.lastOf("answerCallbackQuery").text, "Not allowed");
  assert.equal(await m.count("hidden"), 1);

  // Keep: жалобы закрыты, заметка снова в ленте; новая жалоба от другого аккаунта снова зовёт модератора
  await m.tap("k:1");
  assert.match(m.lastOf("editMessageText").text, /✅ <b>Kept<\/b> — reports closed/);
  assert.equal(m.lastOf("answerCallbackQuery").text, "Kept, visible in the app again");
  assert.ok((await m.overlay()).notes["rel-1:0"]);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE resolved=0").first()).n, 0);
  await m.say("/reports");
  assert.equal(m.lastOf("sendMessage").text, "No open reports.");
  assert.deepEqual((await rep(rs[0].token)).json, { ok: true, dup: true });   // кто уже жаловался, второй раз не может
  n = w.calls.length;
  assert.deepEqual((await rep(rs[4].token, 1, "other")).json, { ok: true });
  assert.equal(m.cards(n).length, 1);

  // Delete с карточки жалобы просит подтверждение, Cancel возвращает кнопки
  await m.tap("x:1");
  assert.deepEqual(m.lastOf("editMessageReplyMarkup").reply_markup.inline_keyboard[0].map(b => b.callback_data), ["xy:1", "xn:1"]);
  await m.tap("xn:1");
  assert.deepEqual(m.kb(m.lastOf("editMessageReplyMarkup")), keyboard);
  assert.equal(await m.status(1), "approved");
  await m.tap("x:1"); await m.tap("xy:1");
  assert.equal(await m.status(1), null);
  assert.match(m.lastOf("editMessageText").text, /🗑 <b>Deleted<\/b>/);
  for (const t of ["reports", "hidden", "votes", "vote_n"]) assert.equal(await m.count(t), 0, t);
  assert.equal((await m.overlay()).notes["rel-1:0"], undefined);
  assert.equal((await w.call("GET", "/a/inbox", undefined, a.token)).json.items[0].kind, "removed");
  // старые кнопки по удалённой заметке ничего не ломают
  for (const d of ["k:1", "xy:1", "x:1"]) { await m.tap(d); assert.equal(m.lastOf("answerCallbackQuery").text, "Already deleted", d); }

  // не больше 10 жалоб в сутки с одного аккаунта
  const sp = (await w.reg("Spammer", "secret123", "4.4.9.9")).json;
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await rep(sp.token, 500 + i)).status);
  assert.deepEqual(codes, [404, 404, 404, 404, 404, 404, 404, 404, 404, 404, 429, 429]);
});

test("жалобы: у доверенного автора на карточке есть Pause trust, кнопка Ban author работает", async () => {
  const w = world(), m = mod(w);
  const a = (await w.reg("Fan_One")).json, b = (await w.reg("Reporter", "secret123", "7.7.7.7")).json;
  await m.say("/trust fan_one");
  await w.env.DB.prepare("UPDATE users SET created=created-864000 WHERE nick_lc='fan_one'").run();
  await w.call("POST", "/s", PLAIN(1), a.token);                       // выходит сразу (#1)
  const n = w.calls.length;
  await w.call("POST", "/a/report", { id: 1, why: "offensive" }, b.token);
  const card1 = m.cards(n)[0];
  assert.deepEqual(m.kb(card1), [["x:1", "k:1"], ["t:" + a.id, "b:" + a.id]]);
  await m.tap("b:" + a.id);
  assert.equal(m.lastOf("answerCallbackQuery").text, "Author banned");
  assert.equal((await w.call("GET", "/a/me", undefined, a.token)).status, 401);
});

test("удаление аккаунта убирает его голоса, жалобы и доверие; счётчики голосов сходятся", async () => {
  const w = world(), m = mod(w);
  const a = (await w.reg("Fan_One")).json, b = (await w.reg("Voter_B", "secret123", "6.6.6.6")).json, c = (await w.reg("Voter_C", "secret123", "6.6.6.7")).json;
  await w.call("POST", "/s", SUG({ text: "A note that gets votes from two accounts." }), a.token);
  await m.tap("a:1");
  await w.call("POST", "/a/vote", { id: 1 }, b.token);
  await w.call("POST", "/a/vote", { id: 1 }, c.token);
  await w.call("POST", "/a/report", { id: 1, why: "other" }, b.token);
  await m.say("/trust voter_b");
  assert.deepEqual((await m.overlay()).votes, { 1: 2 });
  assert.equal((await w.call("POST", "/a/delete", { pw: dk("secret123", "Voter_B") }, b.token)).status, 200);
  assert.deepEqual((await m.overlay()).votes, { 1: 1 });
  for (const t of ["reports", "trust"]) assert.equal(await m.count(t), 0, t);
  assert.equal(await m.count("votes"), 1);
  // автор удаляет аккаунт: опубликованная заметка остаётся без имени, голоса при ней
  assert.equal((await w.call("POST", "/a/delete", { pw: dk("secret123", "Fan_One") }, a.token)).status, 200);
  const ov = await m.overlay();
  assert.equal(ov.notes["rel-1:0"][0].by, "");
  assert.deepEqual(ov.votes, { 1: 1 });
});
