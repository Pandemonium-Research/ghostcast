"""Lay the voice-over onto the silent cut and write the finished video.

    ghostcast vo-mix [--plan voiceover/plan.json]

The plan lists pieces in playback order: a stretch of a recorded clip ([from, to] seconds in the
clip, ideally cut at pauses — see `ghostcast pauses`) and the beat it belongs to (take, optional
segment, offset in seconds):

  {"pieces": [
     {"clip": "A1.m4a", "from": 0.55, "to": 6.2, "take": "intro", "offset": 0.4, "text": "…"},
     {"clip": "A1.m4a", "from": 6.2, "to": 9.8, "take": "build", "segment": "build_run", "offset": 1.0}
  ]}

Each piece starts at its beat, or right after the previous piece if that is still speaking. Pieces
get 15 ms fades so the cuts do not click; the mix is loudness-normalised (-16 LUFS integrated,
-1.5 dBTP; `voiceover.lufs` overrides) and muxed with the silent cut's video, which is copied
untouched.

Writes out/<name>.mp4 and out/<name>.placement.md: where every piece landed, and every piece that
runs past its take (by more than its `spill`, default 1.5 s) or past the end of the video.
"""
import json
import subprocess
import sys

from common import CFG, NAME, ROOT, arg, clip_meta, ffmpeg, mmss, take_starts, timeline

GAP = 0.25        # minimum silence between two pieces
FADE = 0.015
LUFS = CFG.get("voiceover", {}).get("lufs", -16)


def place(pieces, takes, total):
    """Where each piece lands in the cut, and the problems worth reporting.

    takes: {take: {"start", "end", "segments": {segment: start within the take}}}, in cut seconds.
    Returns (placed, problems): each placed piece is the piece plus its anchor, start and end.
    """
    placed, prev_end, problems = [], 0.0, []
    for p in pieces:
        where = f"piece {p['clip']} [{p['from']}–{p['to']}]"
        if p["take"] not in takes:
            sys.exit(f"{where}: no take {p['take']} in timeline.json")
        tk = takes[p["take"]]
        if p.get("segment") and p["segment"] not in tk["segments"]:
            sys.exit(f"{where}: take {p['take']} has no segment {p['segment']} ({', '.join(tk['segments'])})")
        anchor = tk["start"] + (tk["segments"][p["segment"]] if p.get("segment") else 0.0) + p.get("offset", 0.0)
        start = max(anchor, prev_end + GAP) if placed else anchor
        end = start + (p["to"] - p["from"])
        placed.append({**p, "anchor": anchor, "start": start, "end": end})
        prev_end = end
        if end > tk["end"] + p.get("spill", 1.5):
            problems.append(f"{where} ends {end - tk['end']:.1f}s after take {p['take']}")
    if not placed:
        sys.exit("the plan has no pieces")
    if prev_end > total:
        problems.append(f"voice-over ends at {prev_end:.2f}s, after the video ({total:.2f}s)")
    return placed, problems


def main():
    plan = json.loads((ROOT / arg("--plan", "voiceover/plan.json")).read_text(encoding="utf-8"))
    silent = ROOT / "out" / f"{NAME}-silent.mp4"
    if not silent.exists():
        sys.exit(f"no out/{silent.name} (run: ghostcast assemble)")
    starts, total = take_starts()
    missing = [i["take"] for i in timeline()["items"] if i["take"] not in starts]
    if missing:
        sys.exit(f"takes without clips: {', '.join(missing)} (cut them and assemble first)")
    takes = {k: {"start": a, "end": b, "segments": {s["segment"]: s["start"] for s in clip_meta(k)["segments"]}}
             for k, (a, b) in starts.items()}
    placed, problems = place(plan["pieces"], takes, total)

    inputs, chains = ["-i", silent], []
    for k, p in enumerate(placed):
        clip = ROOT / "voiceover" / p["clip"]
        if not clip.exists():
            sys.exit(f"no voiceover/{p['clip']}")
        inputs += ["-i", clip]
        length = p["end"] - p["start"]
        chains.append(
            f"[{k + 1}:a]atrim=start={p['from']:.3f}:end={p['to']:.3f},asetpts=PTS-STARTPTS,aresample=48000,"
            f"afade=t=in:d={FADE},afade=t=out:st={max(0.0, length - FADE):.3f}:d={FADE},"
            f"adelay=delays={int(round(p['start'] * 1000))}:all=1[p{k}]")
    mix = "".join(f"[p{k}]" for k in range(len(placed)))
    # Made stereo before any loudness measurement: a meter sums the two identical channels, so a mono
    # track normalised to -16 LUFS plays at -13 once duplicated.
    graph = ";".join(chains) + (f";{mix}amix=inputs={len(placed)}:normalize=0,apad,atrim=0:{total:.3f},"
                                "pan=stereo|c0=c0|c1=c0[aout]")
    voice = ROOT / "out" / "tmp" / f"{NAME}.voice.wav"
    voice.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg(*inputs, "-filter_complex", graph, "-map", "[aout]", "-c:a", "pcm_s16le", "-y", voice)

    # Two-pass loudness normalisation: measure, then apply one linear gain where the peak ceiling
    # allows it (loudnorm falls back to its dynamic mode where it does not).
    target = f"I={LUFS}:TP=-1.5:LRA=11"
    probe = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(voice), "-af", f"loudnorm={target}:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True, check=True).stderr
    m = json.loads(probe[probe.rindex("{"):probe.rindex("}") + 1])
    norm = (f"loudnorm={target}:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
            f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
    out = ROOT / "out" / f"{NAME}.mp4"
    # -t, not -shortest: -shortest can end the video at the audio's last packet.
    ffmpeg("-i", silent, "-i", voice, "-filter_complex", f"[1:a]{norm},aresample=48000,apad[aout]",
           "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
           "-t", f"{total:.3f}", "-movflags", "+faststart", "-y", out)

    lines = [f"# Voice-over placement — {out.name} ({mmss(total)})\n",
             "| Starts | Ends | Beat | Clip | Text |", "|---|---|---|---|---|"]
    for p in placed:
        late = f" (+{p['start'] - p['anchor']:.1f}s)" if p["start"] - p["anchor"] > 0.05 else ""
        beat = p["take"] + (f" · {p['segment']}" if p.get("segment") else "")
        lines.append(f"| {mmss(p['start'])}{late} | {mmss(p['end'])} | {beat} | {p['clip']} {p['from']}–{p['to']} | {p.get('text', '')} |")
    lines += ["", "Problems: " + ("none" if not problems else "; ".join(problems))]
    (ROOT / "out" / f"{NAME}.placement.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(out)


if __name__ == "__main__":
    main()
