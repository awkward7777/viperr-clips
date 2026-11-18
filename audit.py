#!/usr/bin/env python3
"""Разовая проверка каталога, только чтение (workflow «Catalog audit»).

  1. KISS: что лежит в каталоге и отвечает ли файл со звуком;
  2. все ссылки на звук: какие не открываются или не похожи на аудио;
  3. «Топ треков» артистов по popular.json (как считает приложение);
  4. чего нет в каталоге по сравнению с Apple Music, Deezer и Spotify (только список, каталог не меняется).

Результат: audit_probe.txt (читать глазами) и audit_probe.json.
"""
import base64, concurrent.futures as cf, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

BASE = "https://discographyviperr.pages.dev/"
ARTISTS = {"Kai Angel": "1617297110", "9mice": "1593955534"}  # Apple Music
OUT, RES = [], {}


def p(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    OUT.append(s)


def req(url, headers=None, rng=None, timeout=40):
    h = {"User-Agent": "Mozilla/5.0 (ViperrAudit)"}
    h.update(headers or {})
    if rng:
        h["Range"] = rng
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)


def jget(url, headers=None, quiet=False):
    for i in range(3):
        try:
            return json.loads(req(url, headers).read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (i + 1)); continue
            if not quiet:
                p("  ! HTTP", e.code, url[:110])
            return None
        except Exception as e:
            if i == 2 and not quiet:
                p("  ! ", repr(e)[:120], url[:110])
            time.sleep(1.5)
    return None


def norm(s):
    s = (s or "").lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"\b(feat|ft|prod)\b.*$", " ", s)
    return re.sub(r"[^\w]+", "", s, flags=re.U)


def quote(u):
    u = u if u.startswith("http") else BASE + u.lstrip("/")
    return urllib.parse.quote(u, safe=":/%?&=+#")


def section(t):
    p(""); p("=" * 8, t)


def artists_of(r, i):
    cr = r.get("cr") or []
    a = (cr[i].get("a") if i < len(cr) and cr[i] else None) or None
    return a or [x.strip() for x in re.split(r" & |, ", r.get("a") or "") if x.strip()]


# ---------- каталог ----------
site = json.loads(req(BASE + "tracks.json").read().decode("utf-8"))
extra = json.load(open("new.json", encoding="utf-8"))
allrel = site + extra
p("releases on site:", len(site), "| in new.json:", len(extra), "| tracks:", sum(len(r.get("tr") or []) for r in allrel))
cat_titles = {norm(t) for r in allrel for t in (r.get("tr") or [])}

# ---------- 1. KISS ----------
section("1. KISS")
kiss = [(r, i) for r in allrel for i, t in enumerate(r.get("tr") or []) if norm(t) == "kiss"]
if not kiss:
    p("no track titled KISS; titles containing 'kiss':", [(r["id"], t) for r in allrel for t in (r.get("tr") or []) if "kiss" in t.lower()])
for r, i in kiss:
    cr = (r.get("cr") or [None] * (i + 1))[i] if r.get("cr") else None
    au = (r.get("au") or [None] * (i + 1))[i] if r.get("au") else None
    p(f"release id={r.get('id')} title={r.get('t')!r} type={r.get('type')} artist={r.get('a')!r} date={r.get('dt')} unreleased={r.get('un')} track#{i} of {len(r.get('tr') or [])}")
    p("  keys:", sorted(r.keys()))
    p("  au[i] =", repr(au))
    p("  cr[i] =", json.dumps(cr, ensure_ascii=False)[:300])
    if au:
        raw = au if au.startswith("http") else BASE + au.lstrip("/")
        p("  raw url:", raw)
        p("  quoted url:", quote(au))
        p("  chars that need escaping:", sorted({c for c in au if c not in urllib.parse.quote(c, safe=":/%?&=+#")}))
        for rng in ("bytes=0-63",):
            try:
                resp = req(quote(au), rng=rng)
                b = resp.read(64)
                p("  GET", resp.status, resp.headers.get("content-type"), "range/len:", resp.headers.get("content-range") or resp.headers.get("content-length"), "| first bytes:", b[:16].hex(), re.sub(rb"[^\x20-\x7e]", b".", b[:16]).decode())
            except urllib.error.HTTPError as e:
                p("  GET HTTP", e.code, e.headers.get("content-type"))
            except Exception as e:
                p("  GET error", repr(e)[:150])
        try:
            with req(quote(au)) as resp, open("/tmp/kiss.bin", "wb") as f:
                n = 0
                while n < 80 << 20:
                    b = resp.read(1 << 20)
                    if not b: break
                    f.write(b); n += len(b)
            p("  downloaded bytes:", n)
            pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration,bit_rate:stream=codec_name,codec_type,sample_rate,channels", "-of", "json", "/tmp/kiss.bin"], capture_output=True, text=True)
            p("  ffprobe:", re.sub(r"\s+", " ", pr.stdout)[:400], "| err:", pr.stderr[-200:])
            p("  duration in catalog (cr.d):", (cr or {}).get("d"))
        except Exception as e:
            p("  download/ffprobe failed:", repr(e)[:200])
    else:
        p("  -> this track has NO audio link in the catalog")
    q = json.load(open("quality.json"))
    p("  low-quality variants listed for", f"{r.get('id')}:{i}", "->", q.get("a", {}).get(f"{r.get('id')}:{i}"))

# ---------- 2. все ссылки на звук ----------
section("2. audio links health")
items = []
for r in allrel:
    for i, u in enumerate(r.get("au") or []):
        if u:
            items.append((str(r["id"]), i, (r.get("tr") or [""] * (i + 1))[i], u))
p("tracks with an audio link:", len(items), "| tracks without:", sum(len(r.get("tr") or []) for r in allrel) - len(items))


def check(it):
    rid, i, title, u = it
    try:
        resp = req(quote(u), rng="bytes=0-31", timeout=30)
        b = resp.read(32)
        ct = (resp.headers.get("content-type") or "").lower()
        ok = resp.status in (200, 206) and len(b) > 8 and (ct.startswith("audio") or ct.startswith("application/octet") or ct.startswith("video"))
        tot = resp.headers.get("content-range", "").split("/")[-1] or resp.headers.get("content-length")
        return (rid, i, title, u, resp.status, ct, tot, b[:8].hex(), ok)
    except urllib.error.HTTPError as e:
        return (rid, i, title, u, e.code, e.headers.get("content-type"), None, "", False)
    except Exception as e:
        return (rid, i, title, u, 0, repr(e)[:60], None, "", False)


bad = []
with cf.ThreadPoolExecutor(12) as ex:
    for res in ex.map(check, items):
        if not res[-1] or (res[6] and str(res[6]).isdigit() and int(res[6]) < 100_000):
            bad.append(res)
p("problem links:", len(bad))
for b in bad[:80]:
    p("  ", f"{b[0]}:{b[1]}", repr(b[2]), "| status", b[4], b[5], "| size", b[6], "|", b[3][:90])
RES["bad_audio"] = [list(b[:8]) for b in bad]

# ---------- 3. топ треков ----------
section("3. top tracks by popular.json (formula of the app: views/1000 + growth/20)")
pop = json.load(open("popular.json"))
score = {k: v / 1000.0 for k, v in (pop.get("pv") or {}).items()}
for k, v in (pop.get("d") or {}).items():
    score[k] = score.get(k, 0.0) + v / 20.0
p("tracks with a score:", len(score), "| popular.json time:", pop.get("t"))
for name in ARTISTS:
    seen, rows = set(), []
    for r in sorted(allrel, key=lambda x: x.get("dt") or "", reverse=True):
        for i, t in enumerate(r.get("tr") or []):
            if name.lower() not in [a.lower() for a in artists_of(r, i)]:
                continue
            if norm(t) in seen:
                continue
            seen.add(norm(t))
            rows.append((score.get(f"{r['id']}:{i}"), t, r.get("t"), bool(r.get("un"))))
    have = [x for x in rows if x[0] is not None]
    p(f"{name}: {len(rows)} unique tracks, {len(have)} with a score")
    for s, t, rt, un in sorted(have, key=lambda x: -x[0])[:8]:
        p(f"   {s:8.1f}  {t}  ({rt}){' [unreleased]' if un else ''}")
    p("   newest five (what the app shows today):", [x[1] for x in rows[:5]])

# ---------- 4. чего нет в каталоге ----------
section("4. songs on streaming platforms that are not in the catalog")
plat = {}  # (platform) -> list of dicts


def add(pf, title, artist, album, date, ident=""):
    plat.setdefault(pf, []).append({"title": title, "artist": artist, "album": album, "date": (date or "")[:10], "id": str(ident)})


def apple():
    seen_cid = set()
    for name, aid in ARTISTS.items():
        for country in ("ru", "us"):
            d = jget(f"https://itunes.apple.com/lookup?id={aid}&entity=album&country={country}&limit=200") or {}
            for r in d.get("results", []):
                if r.get("wrapperType") != "collection" or r["collectionId"] in seen_cid:
                    continue
                seen_cid.add(r["collectionId"])
                t = jget(f"https://itunes.apple.com/lookup?id={r['collectionId']}&entity=song&country={country}&limit=200") or {}
                for s in t.get("results", []):
                    if s.get("wrapperType") == "track" and s.get("kind") == "song":
                        add("apple", s.get("trackName"), s.get("artistName"), s.get("collectionName"), s.get("releaseDate"), s.get("trackId"))
                time.sleep(0.5)
            time.sleep(1)
        # песни, где артист указан в названии исполнителя (фиты на чужих релизах)
        for country in ("ru", "us"):
            d = jget("https://itunes.apple.com/search?term=" + urllib.parse.quote(name) + f"&entity=song&attribute=artistTerm&limit=200&country={country}") or {}
            for s in d.get("results", []):
                if s.get("kind") == "song":
                    add("apple", s.get("trackName"), s.get("artistName"), s.get("collectionName"), s.get("releaseDate"), s.get("trackId"))
            time.sleep(1)


def deezer():
    for name in ARTISTS:
        d = jget("https://api.deezer.com/search/artist?q=" + urllib.parse.quote(name) + "&limit=10") or {}
        cand = [a for a in d.get("data", []) if (a.get("name") or "").lower() == name.lower()]
        if not cand:
            p("  deezer: artist not found:", name); continue
        a = max(cand, key=lambda x: x.get("nb_fan", 0))
        p(f"  deezer artist {name}: id={a['id']} fans={a.get('nb_fan')}")
        url = f"https://api.deezer.com/artist/{a['id']}/albums?limit=100"
        albums = []
        while url:
            d = jget(url) or {}
            albums += d.get("data", [])
            url = d.get("next")
        for al in albums:
            t = jget(f"https://api.deezer.com/album/{al['id']}/tracks?limit=200") or {}
            for s in t.get("data", []):
                add("deezer", s.get("title"), (s.get("artist") or {}).get("name"), al.get("title"), al.get("release_date"), s.get("id"))
            time.sleep(0.15)
        top = jget(f"https://api.deezer.com/artist/{a['id']}/top?limit=100") or {}
        for s in top.get("data", []):
            add("deezer", s.get("title"), (s.get("artist") or {}).get("name"), (s.get("album") or {}).get("title"), "", s.get("id"))


def spotify():
    sid, sec = os.environ.get("SPOTIFY_ID"), os.environ.get("SPOTIFY_SECRET")
    if not (sid and sec):
        p("  spotify: no credentials"); return
    rq = urllib.request.Request("https://accounts.spotify.com/api/token", b"grant_type=client_credentials", {"Authorization": "Basic " + base64.b64encode((sid + ":" + sec).encode()).decode()})
    tok = json.load(urllib.request.urlopen(rq, timeout=30))["access_token"]
    H = {"Authorization": "Bearer " + tok}
    for name in ARTISTS:
        d = jget("https://api.spotify.com/v1/search?type=artist&limit=10&q=" + urllib.parse.quote(name), H) or {}
        cand = [a for a in d.get("artists", {}).get("items", []) if a["name"].lower() == name.lower()]
        if not cand:
            p("  spotify: artist not found:", name); continue
        a = max(cand, key=lambda x: x.get("followers", {}).get("total", 0))
        p(f"  spotify artist {name}: id={a['id']}")
        albums, off = [], 0
        while True:
            d = jget(f"https://api.spotify.com/v1/artists/{a['id']}/albums?include_groups=album,single,appears_on&market=RU&limit=10&offset={off}", H)
            if not d: break
            albums += d.get("items", [])
            if not d.get("next"): break
            off += 10
            time.sleep(0.2)
        p(f"  spotify albums for {name}: {len(albums)}")
        for al in albums:
            toff = 0
            while True:
                t = jget(f"https://api.spotify.com/v1/albums/{al['id']}/tracks?market=RU&limit=50&offset={toff}", H)
                if not t: break
                for s in t.get("items", []):
                    add("spotify", s.get("name"), ", ".join(x["name"] for x in s.get("artists", [])), al.get("name"), al.get("release_date"), s.get("id"))
                if not t.get("next"): break
                toff += 50
            time.sleep(0.15)


for fn in (apple, deezer, spotify):
    try:
        fn()
    except Exception as e:
        p(f"  {fn.__name__} failed:", repr(e)[:200])
for pf, l in plat.items():
    p(f"{pf}: {len(l)} track rows collected")

# оставляем только песни, где участвует наш артист; сравниваем по названию
mine = {n.lower() for n in ARTISTS}
missing = {}
for pf, l in plat.items():
    for s in l:
        if not s["title"]:
            continue
        who = {x.strip().lower() for x in re.split(r" & |, |,| feat\.? | x ", s["artist"] or "")}
        if not (who & mine):
            continue
        if norm(s["title"]) in cat_titles:
            continue
        key = norm(s["title"])
        m = missing.setdefault(key, {"title": s["title"], "artist": s["artist"], "album": s["album"], "date": s["date"], "on": set()})
        m["on"].add(pf)
        if s["date"] and (not m["date"] or s["date"] < m["date"]):
            m["date"] = s["date"]
rows = sorted(missing.values(), key=lambda m: (m["date"] or "9999", m["title"]))
p("")
p(f"NOT IN CATALOG: {len(rows)} songs (by title; remixes/versions under another title may show up here too)")
for m in rows:
    p(f"  {m['date'] or '?':10}  {m['title']}  | {m['artist']} | album: {m['album']} | on: {','.join(sorted(m['on']))}")
RES["missing"] = [{**m, "on": sorted(m["on"])} for m in rows]
RES["platform_rows"] = {k: len(v) for k, v in plat.items()}

open("audit_probe.txt", "w", encoding="utf-8").write("\n".join(OUT) + "\n")
json.dump(RES, open("audit_probe.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("done")
