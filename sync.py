#!/usr/bin/env python3
"""Viperr: автоматическое пополнение каталога новыми релизами.

Метаданные — Apple Music (iTunes API). Звук — официальные YouTube-каналы артистов (yt-dlp).
Результат: new.json (формат как tracks.json сайта) + m4a-файлы в релизе GitHub `audio`.
Приложение читает new.json само, обновлять его не нужно.

  python sync.py             обычный запуск (cron)
  python sync.py --baseline  отметить всё, что уже есть в Apple Music, как «старое» (без скачивания)
  python sync.py --dry       ничего не качать и не загружать, только показать план

Звук качается, только если в секретах репозитория задан YT_COOKIES (YouTube блокирует запросы с серверов без входа).
Без них релиз появляется в каталоге без звука, а при следующем запуске докачивается.
"""
import json, os, re, subprocess, sys, urllib.request, time

REPO = os.environ.get("GITHUB_REPOSITORY", "awkward7777/viperr-clips")
SITE = "https://discographyviperr.pages.dev/"
ARTISTS = {"1617297110": "Kai Angel", "1593955534": "9mice"}
CHANNELS = ["https://www.youtube.com/@kaixxxngel", "https://www.youtube.com/@999mice"]
COUNTRY = "ru"
TAG = "audio"
BASELINE = "--baseline" in sys.argv
DRY = "--dry" in sys.argv


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ViperrSync/1.0"})
            return urllib.request.urlopen(req, timeout=30).read()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2)


def jget(url):
    return json.loads(get(url))


def norm(s):
    s = s.lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"\b(feat|ft|prod)\b.*$", " ", s)
    return re.sub(r"[^\w]+", "", s, flags=re.U)


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save(path, data):
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


# ---------- Apple Music ----------
def apple_albums():
    out = {}
    for aid in ARTISTS:
        d = jget(f"https://itunes.apple.com/lookup?id={aid}&entity=album&country={COUNTRY}&limit=200")
        for r in d["results"]:
            if r.get("wrapperType") == "collection":
                out[r["collectionId"]] = r
    return list(out.values())


def apple_tracks(cid):
    d = jget(f"https://itunes.apple.com/lookup?id={cid}&entity=song&country={COUNTRY}&limit=200")
    t = [r for r in d["results"] if r.get("wrapperType") == "track" and r.get("kind") == "song"]
    return sorted(t, key=lambda r: (r.get("discNumber", 1), r.get("trackNumber", 0)))


def kind(name):
    if re.search(r"- single$", name, re.I):
        return "Сингл"
    if re.search(r"- ep$", name, re.I):
        return "EP"
    return "Альбом"


def clean(name):
    return re.sub(r"\s+-\s+(Single|EP)$", "", name, flags=re.I)


# ---------- YouTube ----------
HAS_COOKIES = os.path.exists("cookies.txt")
YT = ["yt-dlp", "--js-runtimes", "node", "--no-warnings"]
if HAS_COOKIES:
    YT += ["--cookies", "cookies.txt"]


def flat(url):
    p = subprocess.run(YT + ["--flat-playlist", "-J", url], capture_output=True, text=True)
    if p.returncode != 0 or not p.stdout.strip():
        print("list failed:", url, p.stderr[-200:])
        return []
    try:
        return [e for e in (json.loads(p.stdout).get("entries") or []) if e and e.get("id")]
    except Exception:
        return []


def channel_videos():
    vids = []
    for ch in CHANNELS:
        for tab in ("videos", "releases"):
            for e in flat(f"{ch}/{tab}"):
                if str(e["id"]).startswith(("OLAK", "PL")):  # релиз = плейлист с аудио-треками
                    for t in flat(f"https://www.youtube.com/playlist?list={e['id']}"):
                        if t.get("title"):
                            vids.append((t["id"], t["title"], t.get("duration") or 0))
                elif e.get("title"):
                    vids.append((e["id"], e["title"], e.get("duration") or 0))
    return vids


def ytm_match(track, artist, dur):
    """Запасной поиск по метаданным Apple Music через ytmusicapi: только официальные «песни» нужного артиста и той же длины (±3 с)."""
    try:
        from ytmusicapi import YTMusic
        res = YTMusic().search(f"{artist} {track}", filter="songs", limit=10)
    except Exception as e:
        print("ytmusicapi unavailable:", e)
        return None
    names = {norm(x) for x in re.split(r", | & ", artist)}
    for r in res:
        if norm(r.get("title", "")) != norm(track) or not r.get("videoId"):
            continue
        if not any(norm(a.get("name", "")) in names for a in r.get("artists", [])):
            continue
        d = r.get("duration_seconds") or 0
        if dur and d and abs(d - dur) > 3:
            continue
        return r["videoId"]
    return None


def match(track, dur, vids):
    n = norm(track)
    if not n:
        return None
    best = None
    for vid, title, vd in vids:
        if n not in norm(title):
            continue
        bad = re.search(r"clip|клип|official video|live|концерт|remix|snippet|teaser|trailer|лайв", title, re.I)
        score = 1 if bad and not re.search(r"audio|аудио", title, re.I) else 2
        if dur and vd and abs(vd - dur) <= 8:
            score += 2
        if best is None or score > best[0]:
            best = (score, vid)
    return best[1] if best and best[0] >= 2 else None


def download(vid, out):
    p = subprocess.run(YT + ["-f", "140/bestaudio[ext=m4a]/bestaudio", "-x", "--audio-format", "m4a",
                             "-o", out, f"https://www.youtube.com/watch?v={vid}"], capture_output=True, text=True)
    f = out.replace("%(ext)s", "m4a")
    if p.returncode != 0:
        print("download failed:", vid, p.stderr[-300:])
    return f if p.returncode == 0 and os.path.exists(f) else None


def loudness(f):
    p = subprocess.run(["ffmpeg", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True)
    s = p.stderr.split("Summary:")[-1]
    i = re.search(r"I:\s+(-?[\d.]+) LUFS", s)
    k = re.search(r"Peak:\s+(-?[\d.]+) dBFS", s)
    return [float(i.group(1)), float(k.group(1))] if i and k else None


def upload(f):
    if subprocess.run(["gh", "release", "view", TAG, "-R", REPO], capture_output=True).returncode != 0:
        subprocess.run(["gh", "release", "create", TAG, "-R", REPO, "-t", "Audio", "-n", "Audio files"], check=True)
    subprocess.run(["gh", "release", "upload", TAG, f, "-R", REPO, "--clobber"], check=True)


# ---------- main ----------
def adopt_manual(new):
    """Файлы, загруженные в релиз вручную (имя «<id>-<номер>.m4a|mp3|…»), подставляются в new.json."""
    p = subprocess.run(["gh", "release", "view", TAG, "-R", REPO, "--json", "assets"], capture_output=True, text=True)
    if p.returncode != 0:
        return False
    names = {a["name"] for a in json.loads(p.stdout).get("assets", [])}
    changed = False
    for rel in new:
        for i in range(len(rel["tr"])):
            if rel["au"][i]:
                continue
            for ext in ("m4a", "mp3", "ogg", "opus", "flac", "wav", "aac"):
                n = f"{rel['id']}-{i + 1}.{ext}"
                if n in names:
                    rel["au"][i] = f"https://github.com/{REPO}/releases/download/{TAG}/{n}"
                    print("adopted manual upload:", n)
                    changed = True
                    break
    return changed


def ingest_manual(new):
    """Файлы из папки manual/ (имя «<id>-<номер>.<расширение>») → релиз audio → ссылка и громкость в new.json."""
    import glob
    changed = False
    for f in sorted(glob.glob("manual/*")):
        m = re.match(r"(.+)-(\d+)\.(\w+)$", os.path.basename(f))
        rel = next((r for r in new if m and r["id"] == m.group(1)), None)
        if not m or not rel or not 1 <= int(m.group(2)) <= len(rel["tr"]):
            print("manual: пропуск", f)
            continue
        n, ext = int(m.group(2)), m.group(3).lower()
        out = f
        if ext not in ("m4a", "mp3"):  # flac/wav/… → m4a (AAC 256k, без обложки)
            out = f"manual/{m.group(1)}-{n}.m4a"
            p = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", f, "-vn", "-map_metadata", "-1", "-c:a", "aac",
                                "-b:a", "256k", "-movflags", "+faststart", out], capture_output=True, text=True)
            if p.returncode != 0:
                print("manual: ошибка конвертации", f, p.stderr[-200:])
                continue
        rel["lf"][n - 1] = loudness(out)
        upload(out)
        rel["au"][n - 1] = f"https://github.com/{REPO}/releases/download/{TAG}/{os.path.basename(out)}"
        print("manual: загружен", os.path.basename(out))
        for x in {f, out}:
            os.remove(x)
        changed = True
    return changed


def main():
    seen = load("seen.json", [])
    new = load("new.json", [])
    if not DRY and (ingest_manual(new) | adopt_manual(new)):
        save("new.json", new)
    site = []
    try:
        site = jget(SITE + "tracks.json")
    except Exception as e:
        print("site catalog unavailable:", e)
    site_titles = {norm(r.get("t", "")) for r in site}
    albums = apple_albums()
    print(f"Apple Music: {len(albums)} albums")

    if BASELINE:
        seen = sorted({str(a["collectionId"]) for a in albums} | set(seen))
        save("seen.json", seen)
        print("baseline saved:", len(seen))
        return

    # дубли оригиналов на сайте (Tainted Love, Narcotic) — не добавляем
    block = {norm("Club Tainted"), norm("Your Love")}
    todo = [a for a in albums if str(a["collectionId"]) not in seen and norm(clean(a["collectionName"])) not in site_titles | block]
    pending = [r for r in new if any(x is None for x in r["au"])]
    print("new releases:", [a["collectionName"] for a in todo], "| pending:", [r["t"] for r in pending])
    if not todo and not pending:
        return

    can_audio = HAS_COOKIES and not DRY
    vids = channel_videos() if (can_audio or DRY) else []
    print("YouTube videos indexed:", len(vids), "| audio download:", "on" if can_audio else "off (no YT_COOKIES)")
    os.makedirs("out", exist_ok=True)

    def fill(rel):
        if not can_audio and not DRY:
            return
        durs = [c["d"] for c in rel["cr"]]
        for i, name in enumerate(rel["tr"]):
            if rel["au"][i]:
                continue
            vid = match(name, durs[i], vids) or ytm_match(name, rel["a"], durs[i])
            print("  ", name, "->", vid)
            if not vid or DRY:
                continue
            f = download(vid, f"out/{rel['id']}-{i + 1}.%(ext)s")
            if not f:
                continue
            rel["lf"][i] = loudness(f)
            upload(f)
            rel["au"][i] = f"https://github.com/{REPO}/releases/download/{TAG}/{os.path.basename(f)}"
            os.remove(f)

    for a in todo:
        tr = apple_tracks(a["collectionId"])
        if not tr:
            continue
        names = [t["trackName"] for t in tr]
        rel = {
            "id": f"am{a['collectionId']}", "t": clean(a["collectionName"]), "type": kind(a["collectionName"]),
            "y": int(a["releaseDate"][:4]), "dt": a["releaseDate"][:10], "a": a["artistName"],
            "tr": names, "au": [None] * len(names), "lf": [None] * len(names),
            "cover": re.sub(r"\d+x\d+bb", "3000x3000bb", a["artworkUrl100"]),
            "h": int(a["collectionId"]) % 360,
            "cr": [{"d": round(t.get("trackTimeMillis", 0) / 1000),
                    "a": [x.strip() for x in re.split(r", | & ", t["artistName"]) if x.strip()]} for t in tr],
        }
        fill(rel)
        if not DRY:
            new.append(rel)
            seen.append(str(a["collectionId"]))
    for rel in pending:
        fill(rel)
    if not DRY:
        save("new.json", new)
        save("seen.json", sorted(set(seen)))


if __name__ == "__main__":
    main()
