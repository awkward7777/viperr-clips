import io, contextlib, json, os, re, sys, urllib.request, urllib.parse, base64
LOG = []
GT = os.environ.get("GENIUS_TOKEN")
ID, SEC = os.environ.get("SPOTIFY_ID"), os.environ.get("SPOTIFY_SECRET")
def get(u, data=None, hdr=None):
    r = urllib.request.Request(u, data=data, headers=hdr or {})
    return json.load(urllib.request.urlopen(r, timeout=30))
tok = None
if ID and SEC:
  try: tok = get("https://accounts.spotify.com/api/token", b"grant_type=client_credentials",
          {"Authorization": "Basic " + base64.b64encode(f"{ID}:{SEC}".encode()).decode()})["access_token"]
  except Exception as e: LOG.append("token fail: %s" % e); print("spotify token fail", e)
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
out = {k: v for k, v in old.items() if "dzcdn.net" not in v}
norm = lambda s: re.sub(r"\W+", "", s.lower())
slugs = json.load(open("slugs.json")) if os.path.exists("slugs.json") else {}
def genius_ids(n):
    """id артистов Genius: по точному имени или по slug из slugs.json (ссылка genius.com/artists/<slug>)."""
    ids, seen_urls = [], []
    slug = slugs.get(n)
    for q in ([slug, slug.replace("-", " "), n] if slug else [n]):
        for h in get("https://api.genius.com/search?q=" + urllib.parse.quote(q), hdr={"Authorization": "Bearer " + GT})["response"]["hits"]:
            r = h["result"]
            for a in [r["primary_artist"]] + (r.get("featured_artists") or []):
                seen_urls.append(a.get("url", ""))
                ok = a["url"].lower().rstrip("/").endswith("/artists/" + slug.lower()) if slug else norm(a["name"]) == norm(n)
                if ok and a["id"] not in ids: ids.append(a["id"])
        if ids: break
    if slug and not ids: LOG.append("no slug match %s: %s" % (n, sorted(set(seen_urls))[:12]))
    return ids
for n in sorted(names | set(slugs)):
    if n in out: continue
    try:
        if GT:
            ids = genius_ids(n)
            for i in ids:
                u = get(f"https://api.genius.com/artists/{i}", hdr={"Authorization": "Bearer " + GT})["response"]["artist"].get("image_url") or ""
                if u and "default" not in u: out[n] = u; break
            continue
        if not tok: break
        r = get("https://api.spotify.com/v1/search?type=artist&limit=5&q=" + urllib.parse.quote(n), hdr={"Authorization": "Bearer " + tok})
        for a in r["artists"]["items"]:
            if norm(a["name"]) == norm(n) and a["images"]:
                out[n] = a["images"][0]["url"]; break
    except Exception as e:
        body = ""
        try: body = e.read().decode()[:200]
        except Exception: pass
        LOG.append("fail %s: %s %s" % (n, e, body)); print("fail", n, e); break
json.dump(out, open("artists.json", "w"), ensure_ascii=False, indent=1)
print(len(out), "artists")

LOG.append("genius=%s creds=%s tok=%s names=%d found=%d" % (bool(GT), bool(ID and SEC), bool(tok), len(names), len(out)))
open("artists.log", "w").write("\n".join(LOG))
