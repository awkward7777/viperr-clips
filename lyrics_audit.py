"""Проверка текстов: для каждого трека ищем в lrclib и сверяем название найденного с нашим.
Результат: lyrics_audit.json — {"bad": [треки, где поиск раньше подсовывал чужую песню], "none": [нет синхронного текста]}."""
import json, re, time, urllib.parse, urllib.request
BASE = "https://discographyviperr.pages.dev/"
def get(u):
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ViperrAudit/1.0"}), timeout=30).read().decode())
    except Exception:
        return None
nk = lambda s: re.sub(r"[^\w]", "", (s or "").lower())
clean = lambda t: re.sub(r"\s*[(\[][^)\]]*[)\]]", "", t).strip()
tracks = get(BASE + "tracks.json") or []
bad, none, ok = [], [], 0
for r in tracks:
    for i, t in enumerate(r.get("tr") or r.get("tracks") or []):
        art = (r.get("ar") or r.get("artist") or "").split(",")[0].split(" & ")[0].strip()
        res = get("https://lrclib.net/api/search?track_name=%s&artist_name=%s" % (urllib.parse.quote(t), urllib.parse.quote(art))) or []
        syn = [x for x in res if x.get("syncedLyrics")]
        good = [x for x in syn if nk(x.get("trackName")) in (nk(t), nk(clean(t)))]
        key = "%s:%d" % (r["id"], i)
        if good: ok += 1
        elif syn: bad.append({"k": key, "title": t, "artist": art, "found": [x.get("trackName") + " — " + x.get("artistName", "") + " (id %s)" % x.get("id") for x in syn[:3]]})
        else: none.append({"k": key, "title": t, "artist": art})
        time.sleep(.15)
json.dump({"ok": ok, "bad": bad, "none": none}, open("lyrics_audit.json", "w"), ensure_ascii=False, indent=1)
print("ok", ok, "bad", len(bad), "none", len(none))
