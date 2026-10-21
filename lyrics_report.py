"""Отчёт по текстам: для каждого трека — есть ли синхронный текст, только обычный или нет ничего (с учётом lyrics_map.json)."""
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
pl = get(BASE + "playlists.json")
if pl is not None: json.dump(pl, open("site_playlists.json", "w"), ensure_ascii=False, indent=1)
mp = json.load(open("lyrics_map.json"))
rows = {}
for r in tracks:
    title = r.get("t") or r.get("title") or r["id"]
    for i, t in enumerate(r.get("tr") or []):
        key = "%s:%d" % (r["id"], i)
        art = (r.get("a") or "").split(",")[0].split(" & ")[0].strip()
        state = None
        if key in mp:
            x = get("https://lrclib.net/api/get/%s" % mp[key]["id"])
            if x: state = "synced" if x.get("syncedLyrics") else ("plain" if x.get("plainLyrics") else None)
        if state is None:
            res = get("https://lrclib.net/api/search?track_name=%s&artist_name=%s" % (urllib.parse.quote(t), urllib.parse.quote(art))) or []
            good = [x for x in res if nk(x.get("trackName")) in (nk(t), nk(clean(t)))]
            if any(x.get("syncedLyrics") for x in good): state = "synced"
            elif any(x.get("plainLyrics") for x in good): state = "plain"
            else: state = "none"
            time.sleep(.15)
        rows.setdefault(title, []).append((i + 1, t, state))
out, tot = [], {"synced": 0, "plain": 0, "none": 0}
for title, l in rows.items():
    for _, _, s in l: tot[s] += 1
    miss = [(n, t, s) for n, t, s in l if s != "synced"]
    if miss: out.append({"release": title, "tracks": len(l), "missing": [{"n": n, "title": t, "state": s} for n, t, s in miss]})
json.dump({"totals": tot, "releases": out}, open("lyrics_report.json", "w"), ensure_ascii=False, indent=1)
print(tot)
