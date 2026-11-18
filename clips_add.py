"""Скачивает клипы с YouTube по id и кладёт их в релиз clips как <id>.mp4: оттуда их играет приложение.
Версии 720p и 480p делает workflow Quality, данные кадрирования (чёрные полосы) считает Crop.
Отчёт (название, канал, длительность, кодеки, размер) пишется в clips_probe.txt и clips_probe.json."""
import json, os, re, subprocess

REPO = "awkward7777/viperr-clips"
TAG = "clips"
ids = [x for x in re.split(r"[\s,]+", os.environ.get("IDS", "")) if x]
out, res = [], {}


def p(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    out.append(s)


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True)


def probe(path):
    r = sh("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt:format=duration,size", "-of", "json", path)
    try:
        j = json.loads(r.stdout)
    except Exception:
        return {}
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), {})
    f = j.get("format", {})
    return {"v": v.get("codec_name"), "a": a.get("codec_name"), "w": v.get("width"), "h": v.get("height"), "pix": v.get("pix_fmt"),
            "dur": float(f.get("duration") or 0), "size": int(f.get("size") or 0)}


r = sh("gh", "api", f"repos/{REPO}/releases/tags/{TAG}", "--jq", ".id")
if r.returncode != 0:
    sh("gh", "release", "create", TAG, "--repo", REPO, "--title", TAG, "--notes", "music videos")
os.makedirs("/tmp/up", exist_ok=True)

for vid in ids:
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
        p("skip (not a YouTube id):", vid[:30])
        continue
    url = f"https://www.youtube.com/watch?v={vid}"
    p(f"=== {vid}")
    m = sh("yt-dlp", "--skip-download", "--no-playlist", "--print", "%(title)s\t%(uploader)s\t%(channel)s\t%(duration)s\t%(upload_date)s\t%(availability)s", url)
    meta = (m.stdout.strip().splitlines() or [""])[0].split("\t")
    if m.returncode != 0 or len(meta) < 6:
        p("  metadata failed:", (m.stderr or m.stdout)[-400:].replace("\n", " | "))
        res[vid] = {"error": "metadata"}
        continue
    info = {"title": meta[0], "uploader": meta[1], "channel": meta[2], "duration": meta[3], "date": meta[4], "availability": meta[5]}
    p("  meta:", json.dumps(info, ensure_ascii=False))
    raw = f"/tmp/raw_{vid}.mp4"
    d = sh("yt-dlp", "--no-playlist", "-f", "bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
           "--merge-output-format", "mp4", "-o", raw, url)
    if d.returncode != 0 or not os.path.exists(raw):
        p("  download failed:", (d.stderr or d.stdout)[-600:].replace("\n", " | "))
        res[vid] = {**info, "error": "download"}
        continue
    pr = probe(raw)
    p("  downloaded:", json.dumps(pr))
    dst = f"/tmp/up/{vid}.mp4"
    if pr.get("v") == "h264" and pr.get("a") in ("aac", None) and pr.get("pix") == "yuv420p":
        c = sh("ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-c", "copy", "-movflags", "+faststart", dst)
    else:
        p("  re-encoding to H.264/AAC (source codecs:", pr.get("v"), pr.get("a"), ")")
        c = sh("ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", dst)
    os.remove(raw)
    if c.returncode != 0 or not os.path.exists(dst):
        p("  ffmpeg failed:", c.stderr[-400:].replace("\n", " | "))
        res[vid] = {**info, "error": "ffmpeg"}
        continue
    fin = probe(dst)
    p("  final:", json.dumps(fin))
    u = sh("gh", "release", "upload", TAG, dst, "--clobber", "--repo", REPO)
    if u.returncode != 0:
        p("  upload failed:", u.stderr[-400:].replace("\n", " | "))
        res[vid] = {**info, "final": fin, "error": "upload"}
        continue
    os.remove(dst)
    p(f"  uploaded: https://github.com/{REPO}/releases/download/{TAG}/{vid}.mp4")
    res[vid] = {**info, "final": fin, "uploaded": True}

open("clips_probe.txt", "w", encoding="utf-8").write("\n".join(out) + "\n")
json.dump(res, open("clips_probe.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
