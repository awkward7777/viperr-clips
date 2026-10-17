"""Жанры треков по звуку: Essentia Discogs-EffNet (400 стилей). Пробный режим: LIMIT треков, равномерно по каталогу."""
import json, os, sys, urllib.request, urllib.parse, tempfile, subprocess
import numpy as np
from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs, TensorflowPredict2D

LIMIT = int(os.environ.get("LIMIT") or 20)
SITE = "https://discographyviperr.pages.dev/"
M = "https://essentia.upf.edu/models/"
def dl(u, p):
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(p, "wb") as f: f.write(r.read())
for u, p in [(M + "feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb", "eff.pb"),
             (M + "classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb", "head.pb"),
             (M + "classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json", "head.json")]:
    if not os.path.exists(p): dl(u, p)
classes = json.load(open("head.json"))["classes"]
emb_m = TensorflowPredictEffnetDiscogs(graphFilename="eff.pb", output="PartitionedCall:1")
head = TensorflowPredict2D(graphFilename="head.pb", input="serving_default_model_Placeholder", output="PartitionedCall:0")

def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=60))
rels = get(SITE + "tracks.json") + get("https://raw.githubusercontent.com/awkward7777/viperr-clips/main/new.json")
items = [(str(r["id"]), i, r["tr"][i], r["au"][i]) for r in rels for i in range(len(r["tr"])) if i < len(r.get("au", [])) and r["au"][i]]
step = max(1, len(items) // LIMIT)
pick = items[::step][:LIMIT]
out = {}
for rid, i, name, au in pick:
    u = au if au.startswith("http") else SITE + urllib.parse.quote(au)
    try:
        dl(u, "a.audio")
        a = MonoLoader(filename="a.audio", sampleRate=16000, resampleQuality=4)()
        if len(a) > 16000 * 90: a = a[: 16000 * 90]  # первые 90 секунд
        p = np.mean(head(emb_m(a)), axis=0)
        top = np.argsort(p)[::-1][:5]
        out[f"{rid}:{i}"] = {"name": name, "top": [[classes[j], round(float(p[j]), 3)] for j in top]}
        print(rid, i, name, "->", ", ".join(f"{classes[j]} {p[j]:.2f}" for j in top), flush=True)
    except Exception as e:
        print("FAIL", rid, i, name, e, flush=True)
json.dump(out, open("genre_probe.json", "w"), ensure_ascii=False, indent=1)
