import json, os, re, sys, urllib.request, urllib.parse, base64
ID, SEC = os.environ.get("SPOTIFY_ID"), os.environ.get("SPOTIFY_SECRET")
def get(u, data=None, hdr=None):
    r = urllib.request.Request(u, data=data, headers={"User-Agent":"Mozilla/5.0",**(hdr or {})})
    return json.load(urllib.request.urlopen(r, timeout=30))
tok = None
if ID and SEC:
  try: tok = get("https://accounts.spotify.com/api/token", b"grant_type=client_credentials",
          {"Authorization": "Basic " + base64.b64encode(f"{ID}:{SEC}".encode()).decode()})["access_token"]
  except Exception as e: print("spotify token fail", e)
try: site = get("https://discographyviperr.pages.dev/tracks.json")
except Exception as e: print("site fail", e); site = []
extra = json.load(open("new.json")) if os.path.exists("new.json") else []
names = set()
site = site if isinstance(site, list) else site.get("tracks", [])
for t in site + extra:
    for k in ("a",):
        v = t.get(k)
        for n in (v if isinstance(v, list) else [v]):
            for p in re.split(r",|&| feat\.? | x ", n or ""):
                if p.strip(): names.add(p.strip())
    for c in t.get("cr", []) or []:
        for n in c.get("a", []) or []:
            if n: names.add(n.strip())
old = json.load(open("artists.json")) if os.path.exists("artists.json") else {}
out = dict(old)
norm = lambda s: re.sub(r"\W+", "", s.lower())
for n in sorted(names):
    if n in out: continue
    try:
        if not tok:
            for a in get("https://api.deezer.com/search/artist?limit=5&q=" + urllib.parse.quote(n))["data"]:
                if norm(a["name"]) == norm(n) and a.get("picture_xl"):
                    out[n] = a["picture_xl"]; break
            continue
        r = get("https://api.spotify.com/v1/search?type=artist&limit=5&q=" + urllib.parse.quote(n), hdr={"Authorization": "Bearer " + tok})
        for a in r["artists"]["items"]:
            if norm(a["name"]) == norm(n) and a["images"]:
                out[n] = a["images"][0]["url"]; break
    except Exception as e:
        print("fail", n, e)
json.dump(out, open("artists.json", "w"), ensure_ascii=False, indent=1)
print(len(out), "artists")
