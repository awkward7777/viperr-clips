"""Тексты для неизданных треков: ищем на lrclib по названию и длительности (±3 с), даже если артист указан иначе.
Добавляет найденное в lyrics_map.json (формат {"релиз:номер": {"id": N}}), отчёт — lyrics_unreleased.json."""
import json, re, time, urllib.parse, urllib.request
BASE = "https://discographyviperr.pages.dev/"
def get(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ViperrLyrics/1.0"}), timeout=30).read().decode())
    except Exception: return None
nk = lambda s: re.sub(r"[^\w]", "", (s or "").lower())
clean = lambda t: re.sub(r"\s*[(\[][^)\]]*[)\]]", "", t).strip()
tracks = get(BASE + "tracks.json") or []
mp = json.load(open("lyrics_map.json"))
rep = []
for r in tracks:
    if not r.get("un"): continue
    cr = r.get("cr") or []
    for i, t in enumerate(r.get("tr") or []):
        key = "%s:%d" % (r["id"], i)
        if key in mp: continue
        dur = (cr[i] or {}).get("d", 0) if i < len(cr) and cr[i] else 0
        arts = [a.lower() for a in ((cr[i] or {}).get("a") or [])] if i < len(cr) and cr[i] else []
        arts += [x.strip().lower() for x in (r.get("a") or "").replace("&", ",").split(",") if x.strip()]
        seen, cands = set(), []
        for u in ("https://lrclib.net/api/search?track_name=%s" % urllib.parse.quote(t),
                  "https://lrclib.net/api/search?q=%s" % urllib.parse.quote(t + " " + (r.get("a") or "")),
                  "https://lrclib.net/api/search?q=%s" % urllib.parse.quote(clean(t))):
            for x in get(u) or []:
                if x.get("id") in seen: continue
                seen.add(x.get("id")); cands.append(x)
            time.sleep(.2)
        best = None; why = ""
        for x in cands:
            if not (x.get("syncedLyrics") or x.get("plainLyrics")): continue
            if nk(x.get("trackName")) not in (nk(t), nk(clean(t))): continue
            d = x.get("duration") or 0
            artist_ok = any(a and a in (x.get("artistName") or "").lower() for a in arts)
            dur_ok = dur and d and abs(d - dur) <= 3
            if not (artist_ok or dur_ok): continue
            score = (1 if x.get("syncedLyrics") else 0) * 4 + (2 if dur_ok else 0) + (1 if artist_ok else 0)
            if best is None or score > best[0]: best = (score, x, "artist" if artist_ok else "") + ("",)
            if best and best[1] is x: why = ("артист" if artist_ok else "") + (" длительность" if dur_ok else "")
        if best:
            x = best[1]; mp[key] = {"id": x["id"]}
            rep.append({"k": key, "title": t, "release": r.get("t"), "found": "%s — %s" % (x.get("trackName"), x.get("artistName")), "synced": bool(x.get("syncedLyrics")), "match": why.strip()})
        else:
            rep.append({"k": key, "title": t, "release": r.get("t"), "found": None})
json.dump(mp, open("lyrics_map.json", "w"), ensure_ascii=False, indent=1)
json.dump(rep, open("lyrics_unreleased.json", "w"), ensure_ascii=False, indent=1)
print(sum(1 for x in rep if x["found"]), "of", len(rep))
