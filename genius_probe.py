"""Проба: что Genius отдаёт про трек через API (есть ли теги жанров)."""
import json, os, urllib.request, urllib.parse
T = os.environ.get("GENIUS_TOKEN")
print("token:", bool(T))
def get(u, hdr=None):
    api = "api.genius.com" in u
    h = {"Authorization": "Bearer " + T} if (T and api) else {}
    if not api: h["User-Agent"] = "Mozilla/5.0"
    h.update(hdr or {})
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30) as r: return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e: return e.code, ""
    except Exception as e: return 0, str(e)
res = {}
for q in ["Kai Angel designer's paradise", "9mice SHAKE", "Kai Angel are you happy"]:
    st, t = get("https://api.genius.com/search?q=" + urllib.parse.quote(q))
    hits = json.loads(t)["response"]["hits"] if st == 200 else []
    print("search", q, st, len(hits))
    if not hits: continue
    s = hits[0]["result"]; sid = s["id"]
    print(" hit:", s.get("full_title"), "| keys:", sorted(s.keys()))
    st2, t2 = get(f"https://api.genius.com/songs/{sid}?text_format=plain")
    song = json.loads(t2)["response"]["song"] if st2 == 200 else {}
    tagk = [k for k in song if "tag" in k.lower() or "genre" in k.lower()]
    print(" /songs:", st2, "tag-like keys:", tagk, "| all keys:", sorted(song.keys()))
    for k in tagk: print("   ", k, "=", json.dumps(song[k], ensure_ascii=False)[:300])
    st3, t3 = get(f"https://genius.com/api/songs/{sid}")
    print(" web api:", st3, ("tags" in t3), t3[:0])
    st4, t4 = get(f"https://genius.com/songs/{sid}")
    print(" page:", st4, "'Main Tags'" , ("Main Tags" in t4), len(t4))
    res[q] = {"song_keys": sorted(song.keys()), "tag_keys": tagk, "web_api": st3, "page": st4}
json.dump(res, open("genius_probe.json", "w"), ensure_ascii=False, indent=1)
