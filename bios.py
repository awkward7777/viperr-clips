import json, os, re, urllib.request, urllib.parse
GT = os.environ.get("GENIUS_TOKEN")
def get(u):
    r = urllib.request.Request(u, headers={"Authorization": "Bearer " + GT})
    return json.load(urllib.request.urlopen(r, timeout=30))
norm = lambda s: re.sub(r"\W+", "", s.lower())
def flat(d):
    if isinstance(d, str): return d
    if isinstance(d, list): return "".join(flat(x) for x in d)
    if isinstance(d, dict):
        t = d.get("tag"); c = flat(d.get("children", []))
        return c + ("\n\n" if t in ("p", "br") else "")
    return ""
out = json.load(open("bios.json")) if os.path.exists("bios.json") else {}
if GT:
    slugs = json.load(open("slugs.json")) if os.path.exists("slugs.json") else {}
    names = list(json.load(open("artists.json")).keys())
    for n in names:
        if out.get(n): continue
        try:
            sl = slugs.get(n)
            for h in get("https://api.genius.com/search?q=" + urllib.parse.quote(sl or n))["response"]["hits"]:
                a = h["result"]["primary_artist"]
                if sl:
                    if not norm(a["url"].split("/artists/")[-1]).endswith(norm(sl)): continue
                elif norm(a["name"]) != norm(n): continue
                d = get(f"https://api.genius.com/artists/{a['id']}?text_format=plain")["response"]["artist"].get("description", {}).get("plain", "").strip()
                d = re.split(r"\n\s*(?:Дискография|Официальный сайт|Сообщество ВКонтакте|Страница ВКонтакте|Телеграм-канал|Discography|Official Website)\s*\n", d)[0].strip()
                if d and d != "?" and len(d) > 40: out[n] = d; break
        except Exception as e: print("fail", n, e)
json.dump(out, open("bios.json", "w"), ensure_ascii=False, indent=1)
print(len(out), "bios")
