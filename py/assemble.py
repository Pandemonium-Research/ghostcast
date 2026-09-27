"""Assemble finished clips into the silent cut, with captions, and write the cue sheet.

    ghostcast assemble

Reads timeline.json at the project root:

  {"items": [
     {"take": "intro", "captions": [{"text": "…", "from": "intro_open", "at": 1.5, "until": "end"}]},
     ...
  ]}

- take:     a clip in clips/ (made by cut.py).
- captions: shown over the take. `from` names a segment of the take (default: the take's start);
            `at` is seconds after that point; `until` is seconds after it, or "end" (of the
            segment, or of the take when `from` is absent). `pos` is "bottom" (default) or "top".
            Captions fade in and out.
Every sped-up segment ("@4x", "@fit3") gets an "N×" tag in the top-right corner, automatically:
a viewer should always know when they are not watching real time.

Writes out/<name>-silent.mp4 and out/<name>.cues.md (each segment's and caption's start in the cut,
for writing and placing the voice-over), and fails if the total runs past output.capSeconds.
"""
import sys

from PIL import Image, ImageDraw, ImageFont

from common import CFG, NAME, ROOT, caption_font, clip_meta, ffmpeg, timeline

W, H, FPS = CFG["output"]["width"], CFG["output"]["height"], CFG["output"]["fps"]
CAP = CFG["output"].get("capSeconds")
STYLE = CFG.get("captions", {})
SIZE = STYLE.get("size", round(34 * H / 1080))
FILL = tuple(STYLE.get("background", [24, 24, 27, 225]))
INK = tuple(STYLE.get("color", [250, 250, 250, 255]))
FADE = 0.25


def pill(text, path, *, size, pos):
    """A caption as a full-frame transparent PNG: light text on a dark rounded pill."""
    font = ImageFont.truetype(caption_font(), size)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    px, py = round(size * 1.0), round(size * 0.6)
    pw, ph = r - l + 2 * px, b - t + 2 * py
    margin = round(H * 0.05)
    if pos == "corner":
        x, y = W - pw - round(margin * 0.75), round(margin * 0.75)
    else:
        x, y = (W - pw) // 2, (H - ph - margin if pos == "bottom" else margin)
    d.rounded_rectangle((x, y, x + pw, y + ph), radius=ph // 2, fill=FILL)
    d.text((x + px - l, y + py - t), text, font=font, fill=INK)
    img.save(path)


def windows(item, meta):
    """(text, start, end, pos) for each caption of a take, in clip seconds."""
    segs = {s["segment"]: s for s in meta["segments"]}
    out = []
    for c in item.get("captions", []):
        base, end = 0.0, meta["duration"]
        if c.get("from"):
            if c["from"] not in segs:
                sys.exit(f"{item['take']}: caption \"{c['text']}\" names segment {c['from']}, which the take does not have "
                         f"({', '.join(segs)})")
            s = segs[c["from"]]
            base, end = s["start"], s["end"]
        a = base + c.get("at", 0.0)
        b = end if c.get("until", "end") == "end" else base + c["until"]
        out.append((c["text"], a, min(b, meta["duration"]), c.get("pos", "bottom")))
    for s in meta["segments"]:
        if s.get("speed", 1) >= 1.5:
            out.append((speed_tag(s["speed"]), s["start"], s["end"], "corner"))
    return out


def speed_tag(speed):
    """The on-screen tag for a sped-up stretch: "4×", or "2.5×" when the factor isn't whole.

    One decimal, so the tag is never more than 0.05 off the real factor (and agrees with the cue
    sheet); plain round() would show 3.6× as "4×", and 2.5× as "2×".
    """
    tag = f"{speed:.1f}"
    return (tag[:-2] if tag.endswith(".0") else tag) + "×"


def render_take(item, tmp):
    take = item["take"]
    clip = ROOT / "clips" / f"{take}.mp4"
    meta = clip_meta(take)
    caps = windows(item, meta)
    out = tmp / f"{take}.mp4"
    inputs, chain, last = ["-i", clip], [], "[0:v]"
    for k, (text, a, b, pos) in enumerate(caps):
        png = tmp / f"{take}_cap{k}.png"
        pill(text, png, size=round(SIZE * (0.88 if pos == "corner" else 1)), pos=pos)
        inputs += ["-loop", "1", "-t", f"{meta['duration']:.3f}", "-i", png]
        fo = max(a, b - FADE)
        chain.append(f"[{k + 1}:v]format=rgba,fade=in:st={a:.3f}:d={FADE}:alpha=1,fade=out:st={fo:.3f}:d={FADE}:alpha=1[c{k}]")
        chain.append(f"{last}[c{k}]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})'[v{k}]")
        last = f"[v{k}]"
    args = [*inputs]
    args += ["-filter_complex", ";".join(chain), "-map", last] if chain else ["-map", "0:v"]
    args += ["-r", FPS, "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation",
             "-pix_fmt", "yuv420p", "-t", f"{meta['duration']:.3f}", "-y", out]
    ffmpeg(*args)
    return out, meta, caps


def main():
    tmp = ROOT / "out" / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    parts, cues, missing, t = [], [], [], 0.0
    for item in timeline()["items"]:
        if not (ROOT / "clips" / f"{item['take']}.mp4").exists():
            cues.append(f"| — | **{item['take']}** | MISSING: not cut yet |")
            missing.append(item["take"])
            continue
        path, meta, caps = render_take(item, tmp)
        parts.append(path)
        rows = []
        for s in meta["segments"]:
            speed = f" at {s['speed']:.1f}×" if s.get("speed", 1) >= 1.5 else ""
            rows.append((s["start"], 0, f"| {t + s['start']:6.2f} | {item['take']} · {s['segment']} | {s['end'] - s['start']:.1f}s{speed} |"))
        for text, a, b, pos in caps:
            if pos != "corner":
                rows.append((a, 1, f"| {t + a:6.2f} | ↳ caption | {text} ({b - a:.1f}s) |"))
        cues += [r[2] for r in sorted(rows)]
        t += meta["duration"]
    if not parts:
        sys.exit("nothing to assemble: no take in timeline.json has a clip (run: ghostcast cut <take>)")
    listing = tmp / "concat.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
    out = ROOT / "out" / f"{NAME}-silent.mp4"
    ffmpeg("-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", "-movflags", "+faststart", "-y", out)
    (ROOT / "out" / f"{NAME}.cues.md").write_text(
        f"# Cue sheet — {out.name} ({t:.2f}s)\n\n| Time | Segment / caption | Length / text |\n|---|---|---|\n"
        + "\n".join(cues) + "\n", encoding="utf-8")
    print(f"{out}: {t:.2f}s from {len(parts)} take(s)" + (f"; missing: {', '.join(missing)}" if missing else ""))
    if CAP and t > CAP:
        sys.exit(f"over the cap: {t:.2f}s > {CAP}s")


if __name__ == "__main__":
    main()
