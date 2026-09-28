# Compositor spike

## Recommendation

Use **ffmpeg's `perspective` filter with per-frame corner expressions**, followed by Lanczos scale and the existing libx264 settings, for the Stage 1 compositor. On these fixtures it kept the eased camera motion close to Pillow, and its best below-normal-priority wall times were **0.446 and 0.370 seconds per output second**, under the **0.5** target stated in `PLAN.md`. This is a Windows result; the same graph, caption rendering, and binary provisioning still need the Stage 1 cross-platform smoke tests. The `sharp` result is incomplete for the concrete environment reason below, so this choice should be revisited if an npm-equipped machine makes that candidate measurable.

## Method

- Read `PLAN.md` Stage 1 and `py/cut.py` first. `scratch/bench/prepare.py` ports `segments`, `view_track`, `box_at`, speed/trim handling, `bisect_right` frame selection, and smootherstep into a per-output-tick manifest. The first fixture JPEGs measured **1440×810** with `ffprobe`, despite the task description's **2880×1620**; `cut.py` also reads actual JPEG dimensions. Both output clips measured **286 frames / 9.533 seconds** at **30 fps**.
- `scratch/bench/ffmpeg_bench.py` builds a concat input with one selected JPEG per tick. The recommended graph evaluates camera corners per frame with `perspective=sense=source:eval=frame:interpolation=cubic`, scales to **1920×1080** with Lanczos, then encodes `libx264 -preset slow -crf 16 -tune animation -pix_fmt yuv420p`. The expression uses `in-1`: this filter's input count is one-based in the tested build. An initial `zoompan` graph was also rendered to check integer crop stepping.
- `scratch/bench/chrome.cjs` serves the JPEGs locally, uses Playwright to drive installed headless Chrome, draws fractional source rectangles on a canvas with high image smoothing, and encodes H.264 Annex B with WebCodecs at a configured **30 Mbit/s**. ffmpeg remuxes that stream into MP4 without re-encoding. This tests an efficient in-page extraction path; the bitrate differs from the reference's CRF setting and affects PSNR.
- `scratch/bench/quality.py` runs ffmpeg SSIM and PSNR against the Pillow reference clips, retains per-frame stats, and reports arithmetic mean and minimum over all frames and over frames whose source time lies within the **0.75-second** focus or unfocus easing window. `scratch/bench/motion.py` tracks the vertical centroid of a fixed orange search-box edge in `registry` and a blue terminal cursor in `validate`. Its motion figure is the RMS difference from the projected smootherstep position after removing each track's constant offset; lower means less frame-to-frame trajectory error. This is a feature-specific smoothness check, not an optical-flow score for the whole frame.
- `scratch/bench/measure.py` runs each complete render **three times**, samples process-tree CPU time and aggregate working set on Windows, and reports median sampled CPU, maximum sampled peak memory, and best wall time. CPU and memory are sampled every **0.05 seconds**, so they are approximate. Another job was loading this machine, especially Chrome; wall times are not uncontended capacity measurements. A separate three-run set started the recommended path below normal process priority.

## Results

All speed figures are seconds per second of output. `SSIM` and `PSNR` cells are **mean / minimum**, with the transition-only pair after the semicolon. Motion is vertical residual RMS in output pixels during focus ease. `—` means the candidate did not render; it is not a zero or an estimate.

| Candidate | Take | Best wall | CPU sampled | Peak MiB sampled | SSIM all; transition | PSNR dB all; transition | Motion px |
|---|---|---:|---:|---:|---|---|---:|
| sharp affine | registry | — | — | — | — | — | — |
| sharp affine | validate | — | — | — | — | — | — |
| Chrome canvas + WebCodecs | registry | 2.648 | 4.022 | 1261.9 | .9948/.9925; .9946/.9930 | 41.57/40.01; 40.55/40.01 | .222 |
| Chrome canvas + WebCodecs | validate | 2.895 | 4.189 | 1178.1 | .9978/.9942; .9965/.9944 | 44.02/38.90; 40.97/38.90 | .416 |
| ffmpeg `perspective` | registry | **.441** | 3.793 | 1107.1 | .9968/.9907; .9941/.9907 | 48.13/37.08; 40.63/37.08 | .210 |
| ffmpeg `perspective` | validate | **.355** | 2.935 | 1106.7 | .9969/.9882; .9946/.9883 | 53.35/35.61; 40.47/35.61 | .404 |

The Pillow track's motion residual was **.253 px** for `registry` and **.377 px** for `validate`. The simpler ffmpeg `zoompan` version completed both takes faster (**.363/.252 wall seconds per output second**) but had transition SSIM means of **.9356/.9557**, transition PSNR means of **26.76/27.86 dB**, and motion residuals of **1.178/.610 px**. Its crop position visibly stepped on the orange border; `perspective` is the measured ffmpeg option recommended here. At below normal priority, `perspective` measured **.446/.370 wall**, **3.775/3.119 sampled CPU**, and **1108.1/1106.9 peak MiB** per take respectively. The wall target is met, but parallel encoding still consumes substantial aggregate CPU and memory.

## Install footprint and availability

These are **measured Windows disk footprints of the installations used**, not npm tarball sizes or a clean-install measurement:

| Component | Measured installed size | Native and license finding |
|---|---:|---|
| Playwright + Playwright Core | 4.86 + 12.83 MiB | Installed package metadata says Apache-2.0. Used by Chrome candidate; already a repository dependency. |
| Installed Chrome version directory | 495.11 MiB | Native Windows browser; this run used system Chrome. Its redistribution terms were not audited here. |
| Installed ffmpeg distribution | 651.37 MiB; `ffmpeg.exe` 213.01 MiB | Native Windows binary. `ffmpeg -L` identifies this specific GPLv3-or-later build; it includes libx264. All measured renderers used ffmpeg for muxing or encoding. |
| sharp | — | No npm package or native libvips prebuild was installed, so npm footprint, exact prebuild coverage, and installed licenses were **not measured**. Windows, macOS, and Linux prebuild availability remains an unverified hypothesis for a later npm run. |

The selected ffmpeg graph adds **no npm compositor package** to the project; it still needs an ffmpeg executable. Windows, macOS, and Linux binary acquisition and license selection for a distributed build are Stage 1 decisions, not outcomes of this Windows spike. The Chrome path requires a WebCodecs H.264 encoder in the installed browser; availability and performance on macOS and Linux were not measured.

| Candidate | Windows native availability in this run | macOS | Linux | License status |
|---|---|---|---|---|
| sharp/libvips | npm install blocked; no prebuild tested | Unverified prebuild hypothesis | Unverified prebuild hypothesis | Package and bundled libvips licenses unverified |
| Chrome canvas | Installed Chrome and WebCodecs H.264 worked | Unmeasured browser/encoder availability | Unmeasured browser/encoder availability | Playwright Apache-2.0 measured from metadata; Chrome terms not audited |
| ffmpeg `perspective` | Installed binary and libx264 worked | Binary and filter availability unmeasured | Binary and filter availability unmeasured | Installed Windows build reported GPLv3-or-later |

## Incomplete sharp candidate

`scratch/bench/package.json` and `scratch/bench/sharp.cjs` contain a proposed affine-to-raw-RGB pipeline into the same ffmpeg encoder. It could not be run or checked against either take: `npm install --prefix scratch/bench --ignore-scripts --no-audit --no-fund` failed because `npm` is not recognized in this shell, and the configured `C:\nvm4w\nodejs` path denied access. A separate Node executable runs the other bench code, but `sharp.cjs` fails with `Cannot find module 'sharp'`. The affine API and output bounds in that prototype are therefore **unvalidated**, not a completed candidate. No network access was used to work around the missing npm command.

## Stage 1 pipeline and risks

Node computes each beat's output ticks from its log, camera keys, trim, speed, and timestamped JPEG list. It writes one ffconcat path per output frame and a beat-local `perspective` expression using `in-1`, then spawns ffmpeg at below normal priority to decode the selected JPEG, sample its fractional source quadrilateral, Lanczos scale, and encode the beat MP4. Captions can be rasterized once per distinct text/style in the already available Chrome and overlaid/faded by ffmpeg during that beat's render; visual parity of the current rounded Pillow pills needs a separate check. Joining matching beat MP4s can use ffmpeg's concat demuxer with stream copy.

Cache each beat by a hash of its selected JPEG content and timestamps, log/camera parameters, trim and speed, output/encode settings, caption assets, and ffmpeg version/filter recipe. Render to a temporary file before committing the cache entry; a changed caption should invalidate only its beat. Beats must reset the filter's frame count locally. The main risks are ffmpeg filter expression escaping on each OS, different font/codec builds, the high sampled memory and CPU despite meeting wall time here, and lack of a measured sharp comparison. These fixtures have one focus and one unfocus per take; a Stage 1 implementation must generate equivalent expressions for overlapping or repeated camera events and test them against `box_at` vectors.

## Reproduction commands

Run from the repository root. All generated files and bench code are under ignored `scratch/bench/`; these commands do not modify tracked project files.

```powershell
python scratch/bench/prepare.py
python scratch/bench/ffmpeg_bench.py --render
python scratch/bench/ffmpeg_bench.py --perspective --render
& 'C:\Users\Lenovo\AppData\Local\cursor-agent\versions\2026.09.15-d2fe57e\node.exe' scratch/bench/chrome.cjs registry
& 'C:\Users\Lenovo\AppData\Local\cursor-agent\versions\2026.09.15-d2fe57e\node.exe' scratch/bench/chrome.cjs validate
python scratch/bench/measure.py
python scratch/bench/measure.py --perspective-only
python scratch/bench/measure.py --perspective-only --low-priority
python scratch/bench/quality.py
python scratch/bench/motion.py
npm install --prefix scratch/bench --ignore-scripts --no-audit --no-fund
& 'C:\Users\Lenovo\AppData\Local\cursor-agent\versions\2026.09.15-d2fe57e\node.exe' scratch/bench/sharp.cjs registry
```

The raw measurements are in `scratch/bench/performance.json`, `performance-low.json`, `quality.json`, and `motion.json`. `ffprobe -show_entries stream=width,height` supplied the JPEG dimensions; `Get-ChildItem -File -Recurse | Measure-Object Length -Sum` supplied the installed directory sizes; `ffmpeg -L` and the installed Playwright package metadata supplied the license findings above.

## Review: re-run at true 2× (supervisor)

The fixtures above were 1440×810: Chrome's screencast ignored the device scale until the recorder
started passing `--force-device-scale-factor` (commit b9fb3a3). The same two bake-off takes were
re-recorded at a true 2880×1620, the Pillow reference clips rebuilt from them, and the
`perspective` bench re-run on an otherwise idle machine, below normal priority:

| Take | Output | Pillow (today) | `perspective` best of 3 | SSIM vs Pillow, mean / min | Transition SSIM, mean / min |
|---|---|---:|---:|---|---|
| registry | 10.47 s | 4.51 s/s | 0.86 s/s | .9981 / .9950 | .9959 / .9950 |
| validate | 15.63 s | 2.97 s/s | 0.82 s/s | .9988 / .9933 | .9958 / .9933 |

- **Recommendation holds:** `perspective` matches Pillow closely, including through the eases,
  and is about five times faster at 2×. `zoompan` stays out; its transitions stepped.
- **The 0.5 s target is not met at 2×.** On registry, decode + `perspective` with no encode is
  0.75 s/s; x264 at `slow` adds about 0.17 (`veryfast` saves 0.12 at the same visual quality). The
  cost is decoding and warping 4.7-megapixel frames, not the encoder.
- **Where the rest must come from, for stage 1's port:** most output frames repeat (a hold shows
  the same source frame in the same view box), yet each is decoded and warped again; and today a
  beat is encoded twice, once in `cut` and again in `assemble`. Render each distinct (frame, box)
  once, and encode each beat once, with its captions, then join beats without re-encoding.
- The motion-tracking script is tuned to features in the 1× fixtures and was not re-run; SSIM in
  the transition windows stands in for it.
