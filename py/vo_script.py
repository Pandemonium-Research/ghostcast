"""Write the voice-over script: each narration block, when it starts in the cut, and whether it fits.

    ghostcast vo-script

Narration lives in timeline.json, next to the takes it is spoken over:

  {"items": [...],
   "narration": [
     {"takes": ["intro"], "text": "An agent made the parser faster. Where did it go?"},
     {"takes": ["build", "build2"], "text": "…"}
   ]}

A block is timed against the takes it names, which must be consecutive in the timeline. The fit
estimate uses voiceover.wordsPerSecond (default 2.5, i.e. 150 words a minute). Writes
out/voiceover-script.md, the page the narrator reads from.
"""
import sys

from common import CFG, ROOT, mmss, take_starts, timeline

WPS = CFG.get("voiceover", {}).get("wordsPerSecond", 2.5)


def main():
    tl = timeline()
    blocks = tl.get("narration", [])
    if not blocks:
        sys.exit('timeline.json has no "narration" blocks')
    starts, total = take_starts()
    order = [i["take"] for i in tl["items"]]
    out = [f"# Voice-over script\n\nFor the silent cut ({mmss(total)}). Start each block when its time comes up; "
           f"a block may run into the next take by a second or two, but not past it. Estimates assume "
           f"{WPS * 60:.0f} words a minute.\n"]
    for k, b in enumerate(blocks, 1):
        takes = b["takes"]
        absent = [t for t in takes if t not in starts]
        if absent:
            out.append(f"\n## Block {k} · {', '.join(takes)}\n\n> {b['text']}\n\nNot timed: no clip yet for {', '.join(absent)}.\n")
            continue
        idx = [order.index(t) for t in takes]
        if idx != list(range(idx[0], idx[0] + len(idx))):
            sys.exit(f"block {k}: takes {takes} are not consecutive in the timeline")
        a, room = starts[takes[0]][0], starts[takes[-1]][1] - starts[takes[0]][0]
        words = len(b["text"].split())
        need = words / WPS
        flag = "fits" if need <= room - 0.5 else f"**{max(0.1, need - room + 0.5):.1f}s too long: trim the text or lengthen the take**"
        out.append(f"\n## Block {k} · {mmss(a)} → {mmss(a + room)} · {room:.1f}s · {', '.join(takes)}\n\n"
                   f"> {b['text']}\n\n{words} words ≈ {need:.1f}s · {flag}\n")
    path = ROOT / "out" / "voiceover-script.md"
    path.parent.mkdir(exist_ok=True)
    path.write_text("".join(out), encoding="utf-8")
    print("".join(out))
    print(path)


if __name__ == "__main__":
    main()
