"""Shared by the post-production scripts: the project, its config, and a few helpers.

The project is the directory in GHOSTCAST_PROJECT (set by `ghostcast`), or the current directory.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("GHOSTCAST_PROJECT") or os.getcwd()).resolve()
if not (ROOT / "project.json").exists():
    sys.exit(f"no project.json in {ROOT} (run: ghostcast init <dir>)")
CFG = json.loads((ROOT / "project.json").read_text(encoding="utf-8"))
NAME = CFG.get("name", "screencast")


def timeline():
    return json.loads((ROOT / "timeline.json").read_text(encoding="utf-8"))


def clip_meta(take):
    return json.loads((ROOT / "clips" / f"{take}.json").read_text(encoding="utf-8"))


def take_starts():
    """{take: (start, end)} in the assembled cut, and its total length. Missing clips are skipped."""
    starts, t = {}, 0.0
    for item in timeline()["items"]:
        if not (ROOT / "clips" / f"{item['take']}.json").exists():
            continue
        d = clip_meta(item["take"])["duration"]
        starts[item["take"]] = (t, t + d)
        t += d
    return starts, t


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def mmss(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


# A semibold sans for captions: the project's choice, else the first one this machine has.
FONTS = [
    "C:/Windows/Fonts/seguisb.ttf",                               # Segoe UI Semibold
    "/System/Library/Fonts/SFNS.ttf",                             # San Francisco
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def caption_font():
    want = CFG.get("captions", {}).get("font")
    if want:
        return want
    for f in FONTS:
        if Path(f).exists():
            return f
    sys.exit("no caption font found; set captions.font in project.json to a .ttf/.otf path")


def ffmpeg(*args, capture=False):
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", *map(str, args)],
                          check=True, capture_output=capture, text=capture)
