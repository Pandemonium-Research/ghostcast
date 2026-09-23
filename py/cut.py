"""Turn a raw take into a finished clip: keep the logged segments, zoom where the scene focused.

    studio cut <take> [<take> ...]

Reads raw/<take>/frames.json, frames/*.jpg and log.json (written by the recorder) and writes
clips/<take>.mp4 at the project's output size and frame rate, plus clips/<take>.json giving each
segment's position in the clip (for the cue sheet and the assembler).

- Segments: everything outside [+name - PRE, -name + POST] is dropped. A name ending in "@4x"
  (any factor) plays that segment sped up; "@fit3" plays it in 3 seconds, however long it really
  took (never slower than real time). The assembler tags every sped-up stretch "N×".
- Trims: project.json "trims": {"segment": seconds} caps a segment's length in the clip.
- Frames: Chrome sends one only when the page changes, so each output tick shows the latest frame
  at or before its source time.
- Zoom: a `focus` event eases the view in on its rectangle (CSS px, scaled by the logged
  devicePixelRatio), `unfocus` eases back out. The crop is taken from the full-resolution frame
  with sub-pixel precision, so pans are smooth and a zoom up to the capture's oversampling costs
  no sharpness.
"""
import bisect
import json
import re
import subprocess
import sys

from PIL import Image

from common import CFG, ROOT

OUT_W, OUT_H, FPS = CFG["output"]["width"], CFG["output"]["height"], CFG["output"]["fps"]
PRE, POST = 0.20, 0.35          # seconds kept either side of a segment
EASE_S = 0.75                   # zoom transition length
ZOOM = CFG.get("zoom", {})
# Zooming up to the capture's oversampling (viewport.dpr) costs no sharpness; past it, some.
MAX_ZOOM = ZOOM.get("max", max(1.5, CFG["viewport"]["dpr"]))
FILL = ZOOM.get("fill", 0.62)   # a focused rectangle fills at most this share of the view


def smooth(k):
    k = max(0.0, min(1.0, k))
    return k * k * k * (k * (k * 6 - 15) + 10)   # smootherstep


def segments(log):
    open_, out = {}, []
    for ev in log:
        t, label = ev[0] / 1000, ev[1]
        if label[:1] == "+":
            open_[label[1:]] = t
        elif label[:1] == "-" and label[1:] in open_:
            name = label[1:]
            a, b = open_.pop(name) - PRE, t + POST
            # "@4x": a fixed speed-up. "@fit3": however long the wait was, play it in 3 seconds
            # (never slower than real time) — for model calls and clones, whose length varies.
            fixed = re.search(r"@(\d+(?:\.\d+)?)x$", name)
            fit = re.search(r"@fit(\d+(?:\.\d+)?)$", name)
            speed = float(fixed.group(1)) if fixed else max(1.0, (b - a) / float(fit.group(1))) if fit else 1.0
            out.append({"name": name, "a": a, "b": b, "speed": speed})
    return sorted(out, key=lambda s: s["a"])


def view_track(log, src_w, src_h, dpr):
    """Keyframes of the visible box (x, y, w, h) in source pixels, as [(t, box)]."""
    full = (0.0, 0.0, float(src_w), float(src_h))
    aspect = src_w / src_h
    keys = [(-1e18, full)]
    for ev in log:
        t = ev[0] / 1000
        if ev[1] == "focus":
            r = ev[2]
            cx, cy = (r["x"] + r["w"] / 2) * dpr, (r["y"] + r["h"] / 2) * dpr
            want_w = max(r["w"] * dpr / FILL, r["h"] * dpr / FILL * aspect, src_w / r.get("zoom", MAX_ZOOM))
            w = min(src_w, want_w)
            h = w / aspect
            x = min(max(cx - w / 2, 0), src_w - w)
            y = min(max(cy - h / 2, 0), src_h - h)
            keys.append((t, (x, y, w, h)))
        elif ev[1] == "unfocus":
            keys.append((t, full))
    return keys


def box_at(keys, t):
    """Eased box at source time t: each keyframe starts a transition from the box shown then."""
    shown = keys[0][1]
    for i in range(1, len(keys)):
        tk, target = keys[i]
        if t < tk:
            break
        start = shown
        k = smooth((t - tk) / EASE_S)
        shown = tuple(s + (e - s) * k for s, e in zip(start, target))
    return shown


def cut(take):
    raw = ROOT / "raw" / take
    frames = json.loads((raw / "frames.json").read_text())
    log = json.loads((raw / "log.json").read_text())
    if not frames:
        sys.exit(f"{take}: no frames")
    times = [f[0] for f in frames]
    vp = next((e[2] for e in log if e[1] == "viewport"), None)
    first = Image.open(raw / "frames" / frames[0][1])
    src_w, src_h = first.size
    dpr = src_w / vp["w"] if vp else 1.0
    keys = view_track(log, src_w, src_h, dpr)
    segs = segments(log)
    if not segs:
        sys.exit(f"{take}: no segments in log")

    clips = ROOT / "clips"
    clips.mkdir(exist_ok=True)
    out_path = clips / f"{take}.mp4"
    enc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{OUT_W}x{OUT_H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow",
         "-crf", "16", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
         "-y", str(out_path)],
        stdin=subprocess.PIPE)

    cache = {"name": None, "img": None}
    meta, pos, n_out = [], 0.0, 0
    # project.json "trims": {segment: seconds} caps a segment's length in the clip, dropping the end of
    # its closing hold — for dead air left once the voice-over is laid.
    trims = CFG.get("trims", {})
    for s in segs:
        dur = (s["b"] - s["a"]) / s["speed"]
        if s["name"] in trims:
            dur = min(dur, trims[s["name"]])
        n = max(1, round(dur * FPS))
        meta.append({"segment": s["name"], "start": round(pos, 3), "end": round(pos + n / FPS, 3), "speed": s["speed"]})
        for i in range(n):
            t = s["a"] + i / FPS * s["speed"]
            j = max(0, bisect.bisect_right(times, t) - 1)
            name = frames[j][1]
            if cache["name"] != name:
                cache["name"], cache["img"] = name, Image.open(raw / "frames" / name).convert("RGB")
            x, y, w, h = box_at(keys, t)
            img = cache["img"]
            if w >= src_w - 0.5 and h >= src_h - 0.5:
                out = img.resize((OUT_W, OUT_H), Image.LANCZOS)
            else:
                out = img.transform((OUT_W, OUT_H), Image.EXTENT, (x, y, x + w, y + h), Image.BICUBIC)
            enc.stdin.write(out.tobytes())
            n_out += 1
        pos += n / FPS
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit(f"{take}: ffmpeg failed")
    (clips / f"{take}.json").write_text(json.dumps({"take": take, "duration": round(pos, 3), "segments": meta}, indent=1))
    print(f"{take}: {len(segs)} segment(s), {n_out} frames, {pos:.2f}s -> {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for take in sys.argv[1:]:
        cut(take)
