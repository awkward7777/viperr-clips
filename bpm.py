"""BPM каждого трека: качаем лёгкую версию (или оригинал), берём 75 секунд из середины, считаем темп (librosa).
Результат: bpm.json {"relId:idx": bpm}. Скрипт продолжает с того места, где остановился."""
import json, os, subprocess, sys, time, urllib.parse, urllib.request
import numpy as np, librosa

BASE = "https://discographyviperr.pages.dev/"
REPO = "awkward7777/viperr-clips"
RAW = f"https://raw.githubusercontent.com/{REPO}/main/"
DEADLINE = time.time() + 60 * float(os.environ.get("MAX_MIN", "300"))
W = "/tmp/bpm"; os.makedirs(W, exist_ok=True)


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60)


def dl(url, dst):
    with get(url) as r, open(dst, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)


def q(u):
    u = u if u.startswith("http") else BASE + u.lstrip("/")
    return urllib.parse.quote(u, safe=":/%?&=+#")


def tempo(path):
    wav = W + "/x.wav"
    for ss in ("40", "10", "0"):
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", ss, "-t", "75", "-i", path, "-ac", "1", "-ar", "22050", wav], check=False)
        if os.path.exists(wav) and os.path.getsize(wav) > 200000: break
    y, sr = librosa.load(wav, sr=22050)
    if len(y) < sr * 15: return None
    env = librosa.onset.onset_strength(y=y, sr=sr)
    fn = getattr(getattr(librosa.feature, "rhythm", None), "tempo", None) or librosa.beat.tempo
    t = fn(onset_envelope=env, sr=sr, start_bpm=85, max_tempo=200, aggregate=np.median)
    return float(np.atleast_1d(t)[0])


def main():
    tracks = json.loads(get(BASE + "tracks.json").read().decode())
    try: tracks += json.loads(get(RAW + "new.json").read().decode())
    except Exception as e: print("new.json:", e)
    out = json.load(open("bpm.json")) if os.path.exists("bpm.json") else {}
    n = 0; errs = []
    for r in tracks:
        for i, u in enumerate(r.get("au") or []):
            k = f"{r['id']}:{i}"
            if not u or k in out: continue
            if time.time() > DEADLINE: print("deadline"); json.dump(out, open("bpm.json", "w")); return
            src = W + "/src.bin"
            try:
                try: dl(f"https://github.com/{REPO}/releases/download/audio-lq/{r['id']}-{i}-64.m4a", src)
                except Exception: dl(q(u), src)
                t = tempo(src)
                if t: out[k] = round(t, 1); n += 1
                else: out[k] = 0
            except Exception as e:
                import traceback
                errs.append(f"{k}: {traceback.format_exc()[-600:]}")
                if len(errs) <= 8: open("bpm_error.txt", "w").write("\n\n".join(errs))
                if len(errs) > 40 and n == 0: print("too many errors"); return
            if n and n % 25 == 0: json.dump(out, open("bpm.json", "w"), separators=(",", ":"))
    json.dump(out, open("bpm.json", "w"), separators=(",", ":"))
    print("done", len(out))


main()
