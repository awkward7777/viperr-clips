"""Находит чёрные поля, «вшитые» в сам клип (например 4:3 внутри кадра 16:9), и пишет clipcrop.json:
{"<id>": [l, t, r, b, ширина_кадра, высота_кадра]} — доли кадра с реальным изображением."""
import glob, json, os, re, subprocess

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stderr

res = {}
for f in sorted(glob.glob("clips/*.mp4")):
    cid = os.path.basename(f)[:-4]
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                         "-of", "json", f], capture_output=True, text=True)
    j = json.loads(pr.stdout)
    vw, vh = j["streams"][0]["width"], j["streams"][0]["height"]
    dur = float(j["format"]["duration"])
    L, T, R, B = vw, vh, 0, 0
    for k in (0.12, 0.3, 0.5, 0.7, 0.88):
        out = run(["ffmpeg", "-ss", str(dur * k), "-i", f, "-t", "4", "-vf", "cropdetect=limit=28:round=2:reset=0", "-f", "null", "-"])
        m = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", out)
        if not m: continue
        w, h, x, y = map(int, m[-1])
        L, T, R, B = min(L, x), min(T, y), max(R, x + w), max(B, y + h)
    if R <= L or B <= T:
        continue
    l, t, r, b = L / vw, T / vh, R / vw, B / vh
    print(cid, vw, vh, "->", round(l, 3), round(t, 3), round(r, 3), round(b, 3))
    if (l > 0.015 or t > 0.015 or r < 0.985 or b < 0.985):
        res[cid] = [round(l, 4), round(t, 4), round(r, 4), round(b, 4), vw, vh]
json.dump(res, open("clipcrop.json", "w"), indent=1)
print(len(res), "clips with baked-in bars")
