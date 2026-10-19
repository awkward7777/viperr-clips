"""Для треков без синхронного текста ищем точное совпадение названия у нужных артистов (lrclib), по длительности.
Уверенные находки добавляются в lyrics_map.json; остальное — в lyrics_fill.json для ручной проверки."""
import json, re, time, urllib.parse, urllib.request
BASE = "https://discographyviperr.pages.dev/"
def get(u):
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ViperrAudit/1.0"}), timeout=30).read().decode())
    except Exception: return None
nk = lambda s: re.sub(r"[^\w]", "", (s or "").lower())
clean = lambda t: re.sub(r"\s*[(\[][^)\]]*[)\]]", "", t).strip()
q = urllib.parse.quote
tracks = {str(r["id"]): r for r in (get(BASE + "tracks.json") or [])}
audit = json.load(open("lyrics_audit.json"))
mp = json.load(open("lyrics_map.json"))
rep = []
for n in audit["none"]:
    rid, i = n["k"].split(":"); r = tracks.get(rid)
    if not r or n["k"] in mp: continue
    i = int(i); t = n["title"]
    dur = ((r.get("cr") or [{}]*(i+1))[i] or {}).get("d", 0) if r.get("cr") else 0
    arts = {nk(x) for x in re.split(r",| & ", (r.get("a") or ""))} | {nk(x) for x in re.split(r",| & ", n.get("artist",""))}
    cands = []
    for u in ("https://lrclib.net/api/search?track_name=%s" % q(t), "https://lrclib.net/api/search?q=%s" % q(t + " " + n.get("artist", ""))):
        for x in (get(u) or []):
            if x.get("syncedLyrics") and nk(x.get("trackName")) in (nk(t), nk(clean(t))) and (nk(x.get("artistName")) in arts or any(a and a in nk(x.get("artistName")) for a in arts)):
                cands.append(x)
        time.sleep(.15)
    seen = set(); cands = [c for c in cands if not (c["id"] in seen or seen.add(c["id"]))]
    if not cands: continue
    best = min(cands, key=lambda c: abs((c.get("duration") or 0) - dur))
    diff = abs((best.get("duration") or 0) - dur) if dur else None
    rep.append({"k": n["k"], "title": t, "found": best.get("trackName") + " — " + best.get("artistName", ""), "id": best["id"], "diff": diff})
    if diff is not None and diff <= 6: mp[n["k"]] = {"id": best["id"]}
json.dump(rep, open("lyrics_fill.json", "w"), ensure_ascii=False, indent=1)
json.dump(mp, open("lyrics_map.json", "w"), ensure_ascii=False, indent=1)
print("found", len(rep), "added", sum(1 for x in rep if x["diff"] is not None and x["diff"] <= 6))
