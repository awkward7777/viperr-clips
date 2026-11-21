-- Viperr · Сообщество (D1). Файл идемпотентный: его можно применять при каждом деплое.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nick TEXT NOT NULL,
  nick_lc TEXT NOT NULL UNIQUE,
  pw TEXT NOT NULL,            -- HMAC(pepper, "pw:" + ключ, посчитанный на телефоне)
  rec TEXT NOT NULL,           -- HMAC(pepper, "rec:" + код восстановления)
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  th TEXT PRIMARY KEY,         -- SHA-256 токена; сам токен хранится только на телефоне
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  nick TEXT NOT NULL DEFAULT '',
  k TEXT NOT NULL,             -- «<id релиза>:<номер трека>»
  tt TEXT NOT NULL DEFAULT '', -- название трека (для карточки у модератора)
  ta TEXT NOT NULL DEFAULT '', -- исполнитель
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  final_text TEXT NOT NULL DEFAULT '',      -- текст после правки модератора
  note TEXT NOT NULL DEFAULT '',            -- причина отказа
  created INTEGER NOT NULL,
  decided INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sug_status ON suggestions(status, id);
CREATE INDEX IF NOT EXISTS sug_user ON suggestions(user_id, id);

CREATE TABLE IF NOT EXISTS throttle (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Облачная копия библиотеки: одна последняя на аккаунт. Хранится как есть, без шифрования (в приложении об этом сказано прямо).
-- Копию присылает приложение целиком; updated в миллисекундах, по нему приложение замечает, что копию уже заменили с другого телефона.
CREATE TABLE IF NOT EXISTS backups (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  info TEXT NOT NULL DEFAULT '{}',   -- сколько плейлистов и лайков внутри, для окна «Восстановить»
  device TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);

-- Входящие: что стало с вашими заметками (одобрено, одобрено с правкой, отклонено, убрано) и дальше награды. Последние 100 на человека.
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref INTEGER NOT NULL DEFAULT 0,    -- номер предложения
  k TEXT NOT NULL DEFAULT '',
  tt TEXT NOT NULL DEFAULT '',
  ta TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',     -- причина отказа или текст после правки модератора
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inbox_user ON inbox(user_id, id);

-- Доверие: запись нужна, только если модератор решил сам. level 1 — доверен (даже без трёх одобренных заметок), -1 — приостановлено.
-- Без записи доверие считается по числу одобренных заметок автора.
CREATE TABLE IF NOT EXISTS trust (
  user_id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL,
  since INTEGER NOT NULL
);

-- «Полезно»: один голос на аккаунт и заметку. vote_n хранит готовый счётчик, чтобы не пересчитывать все голоса при каждом обновлении ленты.
CREATE TABLE IF NOT EXISTS votes (
  sid INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (sid, user_id)
);
CREATE INDEX IF NOT EXISTS votes_user ON votes(user_id, created);
CREATE TABLE IF NOT EXISTS vote_n (
  sid INTEGER PRIMARY KEY,
  n INTEGER NOT NULL
);

-- Жалобы на опубликованные заметки: одна на аккаунт и заметку. resolved = 1, когда модератор нажал Keep.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  why TEXT NOT NULL,
  created INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sid, user_id)
);
CREATE INDEX IF NOT EXISTS reports_open ON reports(sid, resolved);

-- Скрытые заметки: после трёх разных жалоб заметка пропадает из ленты, пока модератор не решит (оставить или удалить).
CREATE TABLE IF NOT EXISTS hidden (
  sid INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
