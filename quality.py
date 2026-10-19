"""Лёгкие версии аудио (128 и 64 кбит/с) и клипов (720p и 480p) для экономии трафика.
Результат: релизы audio-lq (аудио) и clips (клипы) + quality.json со списком готовых версий."""
import json, os, re, subprocess, sys, time, urllib.request

BASE = "https://discographyviperr.pages.dev/"
REPO = "awkward7777/viperr-clips"
RAW = f"https://raw.githubusercontent.com/{REPO}/main/"
DEADLINE = time.time() + 60 * float(os.environ.get("MAX_MIN", "300"))
AUDIO_TIERS = [128, 64]
CLIP_TIERS = [720, 480]
WORK = "/tmp/q"
os.makedirs(WORK, exist_ok=True)


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url), timeout=60)


def download(url, dst):
    with get(url) as r, open(dst, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def sh(*a, check=True):
    return subprocess.run(a, check=check, capture_output=True, text=True)


def release_assets(tag):
    r = sh("gh", "api", f"repos/{REPO}/releases/tags/{tag}", "--jq", ".id", check=False)
    if r.returncode != 0:
        sh("gh", "release", "create", tag, "--repo", REPO, "--title", tag, "--notes", "generated")
        return set()
    rid = r.stdout.strip()
    out = sh("gh", "api", f"repos/{REPO}/releases/{rid}/assets?per_page=100", "--paginate", "--jq", ".[].name").stdout
    return set(out.split())


def upload(tag, path):
    for _ in range(3):
        if sh("gh", "release", "upload", tag, path, "--repo", REPO, "--clobber", check=False).returncode == 0:
            return True
        time.sleep(5)
    return False


def abs_url(u):
    return u if u.startswith("http") else BASE + u.lstrip("/")


def main():
    tracks = json.loads(get(BASE + "tracks.json").read().decode())
    try:
        tracks += json.loads(get(RAW + "new.json").read().decode())
    except Exception as e:
        print("new.json:", e)
    have_a = release_assets("audio-lq")
    todo = []
    for r in tracks:
        for i, u in enumerate(r.get("au") or []):
            if not u:
                continue
            need = [k for k in AUDIO_TIERS if f"{r['id']}-{i}-{k}.m4a" not in have_a]
            if need:
                todo.append((str(r["id"]), i, abs_url(u), need))
    print("audio to do:", len(todo))
    done = 0
    for rid, i, url, need in todo:
        if time.time() > DEADLINE:
            print("deadline"); break
        src = f"{WORK}/src.bin"
        try:
            download(url, src)
        except Exception as e:
            print("skip", rid, i, e); continue
        for k in need:
            out = f"{WORK}/{rid}-{i}-{k}.m4a"
            p = sh("ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", f"{k}k", "-movflags", "+faststart", out, check=False)
            if p.returncode == 0 and upload("audio-lq", out):
                have_a.add(os.path.basename(out)); done += 1
            if os.path.exists(out):
                os.remove(out)
        os.remove(src)
    print("audio done:", done)

    # клипы
    have_c = release_assets("clips")
    orig = sorted(n for n in have_c if n.endswith(".mp4") and not re.search(r"_(720|480)\.mp4$", n))
    for n in orig:
        cid = n[:-4]
        need = [h for h in CLIP_TIERS if f"{cid}_{h}.mp4" not in have_c]
        if not need or time.time() > DEADLINE:
            continue
        src = f"{WORK}/clip.mp4"
        try:
            download(f"https://github.com/{REPO}/releases/download/clips/{n}", src)
        except Exception as e:
            print("clip skip", cid, e); continue
        pr = sh("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", src, check=False)
        try:
            src_h = int(pr.stdout.strip().split(",")[0])
        except Exception:
            src_h = 1080
        for h in need:
            if h >= src_h:
                continue   # исходник не больше — отдельная версия не нужна
            out = f"{WORK}/{cid}_{h}.mp4"
            crf = "26" if h == 720 else "28"
            p = sh("ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", f"scale=-2:{h}", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
                   "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out, check=False)
            if p.returncode == 0 and upload("clips", out):
                have_c.add(os.path.basename(out))
            if os.path.exists(out):
                os.remove(out)
        os.remove(src)

    # индекс готовых версий
    a = {}
    for n in have_a:
        m = re.match(r"^(.+)-(\d+)-(\d+)\.m4a$", n)
        if m:
            a.setdefault(f"{m.group(1)}:{m.group(2)}", []).append(int(m.group(3)))
    c = {}
    for n in have_c:
        m = re.match(r"^(.+)_(720|480)\.mp4$", n)
        if m:
            c.setdefault(m.group(1), []).append(int(m.group(2)))
    for d in (a, c):
        for k in d:
            d[k] = sorted(d[k], reverse=True)
    json.dump({"a": a, "c": c}, open("quality.json", "w"), separators=(",", ":"), sort_keys=True)
    print("index:", len(a), "audio,", len(c), "clips")


main()
