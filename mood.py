"""Признаки звучания каждого трека для Mood-плейлистов: энергия, яркость, минор/мажор, темп, «удар».
Результат: mood.json {"relId:idx": [energy, bright, minor, tempo, punch]}; продолжает с места остановки."""
import json, os, subprocess, time, urllib.parse, urllib.request
import numpy as np, librosa

BASE = "https://discographyviperr.pages.dev/"
REPO = "awkward7777/viperr-clips"
RAW = f"https://raw.githubusercontent.com/{REPO}/main/"
DEADLINE = time.time() + 60 * float(os.environ.get("MAX_MIN", "300"))
W = "/tmp/mood"; os.makedirs(W, exist_ok=True)
MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60)
def dl(url, dst):
    with get(url) as r, open(dst, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)
def q(u):
    u = u if u.startswith("http") else BASE + u.lstrip("/")
    return urllib.parse.quote(u, safe=":/%?&=+#")

def feats(path):
    wav = W + "/x.wav"
    for ss in ("40", "10", "0"):
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", ss, "-t", "60", "-i", path, "-ac", "1", "-ar", "22050", wav], check=False)
        if os.path.exists(wav) and os.path.getsize(wav) > 200000: break
    y, sr = librosa.load(wav, sr=22050)
    if len(y) < sr * 15: return None
    rms = float(np.mean(librosa.feature.rms(y=y)))
    cen = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    env = librosa.onset.onset_strength(y=y, sr=sr)
    fn = getattr(getattr(librosa.feature, "rhythm", None), "tempo", None) or librosa.beat.tempo
    t = float(np.atleast_1d(fn(onset_envelope=env, sr=sr, start_bpm=120, max_tempo=200, aggregate=np.median))[0])
    ch = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best_maj = max(np.corrcoef(ch, np.roll(MAJ, k))[0, 1] for k in range(12))
    best_min = max(np.corrcoef(ch, np.roll(MIN, k))[0, 1] for k in range(12))
    return [round(rms, 4), round(cen, 1), round(float(best_min - best_maj), 3), round(t, 1), round(float(np.mean(env)), 3)]

def main():
    tracks = json.loads(get(BASE + "tracks.json").read().decode())
    try: tracks += json.loads(get(RAW + "new.json").read().decode())
    except Exception as e: print("new.json:", e)
    out = json.load(open("mood.json")) if os.path.exists("mood.json") else {}
    n = 0; errs = []
    for r in tracks:
        for i, u in enumerate(r.get("au") or []):
            k = f"{r['id']}:{i}"
            if not u or k in out: continue
            if time.time() > DEADLINE: print("deadline"); json.dump(out, open("mood.json", "w"), separators=(",", ":")); return
            src = W + "/src.bin"
            try:
                try: dl(f"https://github.com/{REPO}/releases/download/audio-lq/{r['id']}-{i}-64.m4a", src)
                except Exception: dl(q(u), src)
                f = feats(src)
                out[k] = f if f else 0; n += 1
            except Exception:
                import traceback
                errs.append(f"{k}: {traceback.format_exc()[-500:]}")
                open("mood_error.txt", "w").write("\n\n".join(errs[:8]))
                if len(errs) > 40 and n == 0: print("too many errors"); return
            if n and n % 25 == 0: json.dump(out, open("mood.json", "w"), separators=(",", ":"))
    json.dump(out, open("mood.json", "w"), separators=(",", ":"))
    print("done", len(out))
main()
