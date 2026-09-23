"""Look at what was recorded: contact sheets and stills, as images an agent (or a person) can read.

    ghostcast review <take>              contact sheet of clips/<take>.mp4, labelled by segment
    ghostcast review final               contact sheet of the finished video (or the silent cut)
    ghostcast review <take> --raw        contact sheet of the raw capture, ending on its last frame;
                                      for a take that failed, this shows where it stopped
    ghostcast review <take> --at 12.5    one full-size still at 12.5 s (repeat --at for more)
    options: --every 2 (seconds between thumbnails; default: about 16 per sheet)

Writes PNGs under out/review/ and prints their paths. Check every take before assembling: text
legible at the zoom, the right line in focus, no personal data or secrets on screen, nothing stuck.
"""
import io
import json
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

from common import NAME, ROOT, caption_font, clip_meta, take_starts, timeline

THUMB_W, COLS = 480, 4


def grab(video, t):
    png = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(video),
                          "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                         capture_output=True, check=True).stdout
    return Image.open(io.BytesIO(png)).convert("RGB")


def duration(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def sheet(items, title, path):
    """items: [(image, label)] → one grid PNG."""
    font = ImageFont.truetype(caption_font(), 18)
    th = round(THUMB_W * items[0][0].height / items[0][0].width)
    rows = (len(items) + COLS - 1) // COLS
    lab, head = 28, 44
    img = Image.new("RGB", (COLS * THUMB_W + (COLS + 1) * 8, head + rows * (th + lab + 8) + 8), (32, 32, 36))
    d = ImageDraw.Draw(img)
    d.text((10, 10), title, font=ImageFont.truetype(caption_font(), 22), fill=(240, 240, 240))
    for k, (im, label) in enumerate(items):
        x = 8 + (k % COLS) * (THUMB_W + 8)
        y = head + (k // COLS) * (th + lab + 8)
        img.paste(im.resize((THUMB_W, th), Image.LANCZOS), (x, y))
        d.text((x + 2, y + th + 4), label, font=font, fill=(220, 220, 220))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    print(path)


def times(total, every):
    step = every or max(0.5, total / 16)
    ts, t = [], 0.0
    while t < total - 0.05:
        ts.append(t)
        t += step
    return ts


def seg_at(segs, t):
    """segs: [(start, label)] sorted → label of the segment playing at t."""
    label = ""
    for a, name in segs:
        if a <= t + 1e-6:
            label = name
    return label


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    target = args[0]
    every = float(args[args.index("--every") + 1]) if "--every" in args else None
    ats = [float(args[i + 1]) for i, a in enumerate(args) if a == "--at"]
    out = ROOT / "out" / "review"

    if "--raw" in args:
        raw = ROOT / "raw" / target
        frames = json.loads((raw / "frames.json").read_text())
        log = json.loads((raw / "log.json").read_text()) if (raw / "log.json").exists() else []
        t0 = frames[0][0]
        segs = sorted((e[0] / 1000 - t0, e[1][1:] if e[1][0] == "+" else f"(cut: after {e[1][1:]})")
                      for e in log if e[1][:1] in "+-")
        picks = [frames[round(k * (len(frames) - 1) / 15)] for k in range(16)] if len(frames) > 16 else frames
        items = [(Image.open(raw / "frames" / f).convert("RGB"), f"{t - t0:6.1f}s  {seg_at(segs, t - t0)}") for t, f in picks]
        sheet(items, f"raw/{target} · {len(frames)} frames · {frames[-1][0] - t0:.1f}s captured", out / f"{target}.raw.png")
        return

    if target == "final":
        video = ROOT / "out" / f"{NAME}.mp4"
        if not video.exists():
            video = ROOT / "out" / f"{NAME}-silent.mp4"
        starts, _ = take_starts()
        segs = sorted((starts[i["take"]][0] + s["start"], f"{i['take']} · {s['segment']}")
                      for i in timeline()["items"] if i["take"] in starts for s in clip_meta(i["take"])["segments"])
    else:
        video = ROOT / "clips" / f"{target}.mp4"
        segs = sorted((s["start"], s["segment"]) for s in clip_meta(target)["segments"])
    if not video.exists():
        sys.exit(f"no {video.relative_to(ROOT)}")

    if ats:
        for t in ats:
            path = out / f"{target}@{t:g}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            grab(video, t).save(path)
            print(f"{path}  ({seg_at(segs, t)})")
        return
    total = duration(video)
    items = [(grab(video, t), f"{t:6.1f}s  {seg_at(segs, t)}") for t in times(total, every)]
    sheet(items, f"{video.name} · {total:.1f}s", out / f"{target}.png")


if __name__ == "__main__":
    main()
