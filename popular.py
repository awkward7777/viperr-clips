"""Популярность треков по Genius (просмотры страницы песни). popular.json:
{"pv": {"<релиз>:<номер>": просмотры}, "d": {"<ключ>": прирост с прошлого запуска}, "t": время}"""
import json, os, re, time, urllib.parse, urllib.request
BASE = "https://discographyviperr.pages.dev/"
T = os.environ.get("GENIUS_TOKEN")
nk = lambda s: re.sub(r"[^\w]", "", (s or "").lower())
clean = lambda t: re.sub(r"\s*[(\[][^)\]]*[)\]]", "", t).strip()
def get(u, auth=False):
    h = {"User-Agent": "ViperrPop/1.0"}
    if auth: h["Authorization"] = "Bearer " + T
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30).read().decode())
    except Exception: return None
tracks = get(BASE + "tracks.json") or []
try: prev = json.load(open("popular.json")).get("pv", {})
except Exception: prev = {}
pv, cache = {}, {}
for r in tracks:
    for i, t in enumerate(r.get("tr") or []):
        art = (r.get("a") or "").split(",")[0].split(" & ")[0].strip()
        key = "%s:%d" % (r["id"], i)
        ck = nk(clean(t)) + "|" + nk(art)
        if ck in cache:
            if cache[ck] is not None: pv[key] = cache[ck]
            continue
        res = get("https://api.genius.com/search?q=" + urllib.parse.quote(art + " " + clean(t)), True)
        best = None
        for h in ((res or {}).get("response", {}).get("hits") or []):
            s = h.get("result") or {}
            if nk(clean(s.get("title", ""))) == nk(clean(t)) and (nk(art) in nk(s.get("artist_names", "")) or nk(art) in nk(s.get("primary_artist", {}).get("name", ""))):
                best = (s.get("stats") or {}).get("pageviews"); break
        cache[ck] = best
        if best is not None: pv[key] = best
        time.sleep(.2)
d = {k: v - prev[k] for k, v in pv.items() if k in prev and v - prev[k] > 0}
json.dump({"pv": pv, "d": d, "t": int(time.time())}, open("popular.json", "w"), separators=(",", ":"))
print("tracks with views:", len(pv), "growth:", len(d))
