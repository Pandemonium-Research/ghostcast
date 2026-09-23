"""Find the pauses in voice-over clips: where speech starts and ends, and where a clip can be cut.

    ghostcast pauses voiceover/A1.m4a [voiceover/A2.m4a ...] [--noise -30] [--min 0.15]

A recorded block is usually laid as several pieces, each anchored to the beat it describes (see
vo_mix.py). Pieces must be cut in silence, between sentences; this lists the silences (ffmpeg
silencedetect: below --noise dB for at least --min seconds) with their midpoints, the natural cut
points. Pauses of 0.3 s or more are marked: they usually end a sentence; shorter ones are breaths
and commas. Match them to the sentences by listening, or by their order and length.
"""
import re
import subprocess
import sys

from common import arg


def pauses(path, noise, min_len):
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", f"silencedetect=noise={noise}dB:d={min_len}",
                          "-f", "null", "-"], capture_output=True, text=True, check=True).stderr
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    total = int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3]) if dur else None
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    spans = list(zip(starts, ends + [total] * (len(starts) - len(ends))))
    # A click or breath can split one pause in two; join silences that nearly touch.
    merged = []
    for a, b in spans:
        if merged and a - merged[-1][1] < 0.08:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return total, merged


def main():
    noise, min_len = float(arg("--noise", -30)), float(arg("--min", 0.15))
    skip = {arg("--noise"), arg("--min")}
    paths = [a for a in sys.argv[1:] if not a.startswith("--") and a not in skip]
    if not paths:
        sys.exit(__doc__)
    for p in paths:
        total, spans = pauses(p, noise, min_len)
        lead = spans[0][1] if spans and spans[0][0] <= 0.05 else 0.0
        tail = spans[-1][0] if spans and total and spans[-1][1] >= total - 0.05 else total
        inner = [s for s in spans if s[0] > 0.05 and (total is None or s[1] < total - 0.05)]
        print(f"{p}: {total:.2f}s, speech {lead:.2f} → {tail:.2f}")
        for a, b in inner:
            mark = "  ← sentence?" if b - a >= 0.3 else ""
            print(f"  pause {a:6.2f} – {b:6.2f}  ({b - a:.2f}s)  cut at {(a + b) / 2:.2f}{mark}")
        if not inner:
            print("  no pauses; try a higher --noise (e.g. -25) or a lower --min")


if __name__ == "__main__":
    main()
