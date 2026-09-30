# After: shipping pacing (60 fps cap)

Captured 2026-09-30 04:15 UTC with scripts/perf-capture.mjs on http://127.0.0.1:8190/, headless Chrome, ANGLE Vulkan on this machine's AMD Radeon Vega 11 (RADV RAVEN); vsync and the browser frame cap off, a fresh browser per row, query `?promo=1&perf=1&look=<tier>`. 10 s per row; interval stats exclude the first second of the recording. Phone rows: 1080x2400 device pixels at DPR 2.6 emulated, drawn by the Vega 11 (emulated pixels, not a phone GPU).

## Frame time (ms, rAF interval between drawn frames)

| tier | view | scenario | canvas px | scale | frames | mean | p95 | max | > 50 ms | causes of > 50 ms | CPU mean / p95 | GPU mean / p95 | calls | triangles | sync reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1920x1080 | 1 | 602 | 16.65 | 26.8 | 30.6 | 0 | - | 6.85 / 8.9 | 13.32 / 14.8 | 221 | 714038 | 0 |
| full | desktop | flyover | 1920x1080 | 1 | 602 | 16.64 | 28.2 | 30.5 | 0 | - | 8.17 / 11.8 | 12.92 / 15.55 | 286 | 799696 | 0 |
| full | phone | spot | 830x1846 | 1 | 600 | 16.65 | 27.3 | 31.2 | 0 | - | 7.11 / 10.5 | 12.72 / 15.19 | 222 | 711235 | 0 |
| full | phone | flyover | 830x1846 | 1 | 601 | 16.66 | 26.9 | 29.2 | 0 | - | 7.01 / 10 | 11.96 / 14.58 | 251 | 731629 | 0 |
| lite | desktop | spot | 1440x810 | 0.75 | 602 | 16.65 | 27.2 | 31.4 | 0 | - | 5.69 / 8.6 | 10.76 / 14.34 | 126 | 435991 | 0 |
| lite | desktop | flyover | 1440x810 | 0.75 | 602 | 16.66 | 26.7 | 30.2 | 0 | - | 6.28 / 9.8 | 11.27 / 14.86 | 171 | 491342 | 0 |
| lite | phone | spot | 466x1038 | 0.75 | 601 | 16.66 | 26.5 | 30 | 0 | - | 5.97 / 8.9 | 11.5 / 16.36 | 127 | 435892 | 0 |
| lite | phone | flyover | 466x1038 | 0.75 | 601 | 16.65 | 26 | 28.6 | 0 | - | 5.81 / 8.7 | 11.56 / 16.29 | 147 | 452806 | 0 |
| classic | desktop | spot | 1920x1080 | 1 | 1854 | 5.58 | 7.1 | 12.9 | 0 | - | 3.86 / 4.9 | 3.39 / 4.49 | 68 | 307367 | 0 |
| classic | desktop | flyover | 1920x1080 | 1 | 2025 | 4.85 | 7.1 | 51.3 | 1 | outside the frame (GC, compositor, the tab) x1 | 4.31 / 6 | 3.84 / 5.49 | 103 | 356453 | 0 |
| classic | phone | spot | 830x1846 | 1 | 1723 | 6.01 | 8.8 | 104.7 | 1 | cpu: colour x1 | 4.66 / 6.9 | 3.81 / 5.42 | 74 | 318216 | 0 |
| classic | phone | flyover | 830x1846 | 1 | 597 | 15.24 | 9.7 | 1385.9 | 6 | cpu: shadow x1, cpu: colour x5 | 21.8 / 8.6 | 9.21 / 6.58 | 124 | 391325 | 0 |

## GPU ms per pass (mean per drawn frame; EXT_disjoint_timer_query_webgl2, exclusive)

| tier | view | scenario | shadow | colour | aoNormal | ao | bloom | output | seeThrough | seePoll | fxaa | total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1.05 | 6.51 | 0.56 | 3.2 | 0.58 | 0.59 | 0 | 0 | 0.82 | 13.32 |
| full | desktop | flyover | 1.21 | 6.47 | 0.67 | 2.78 | 0.57 | 0.52 | - | 0 | 0.71 | 12.92 |
| full | phone | spot | 1.21 | 6.91 | 0.58 | 2.47 | 0.4 | 0.48 | 0 | 0.01 | 0.65 | 12.72 |
| full | phone | flyover | 1.44 | 5.94 | 0.56 | 2.44 | 0.48 | 0.49 | - | 0 | 0.62 | 11.96 |
| lite | desktop | spot | 0.73 | 7.86 | - | 0.66 | - | 0.55 | 0 | 0.01 | 0.95 | 10.76 |
| lite | desktop | flyover | 0.78 | 8.68 | - | 0.46 | - | 0.59 | - | 0 | 0.76 | 11.27 |
| lite | phone | spot | 0.92 | 9.05 | - | 0.36 | - | 0.43 | 0.01 | 0.01 | 0.73 | 11.5 |
| lite | phone | flyover | 1.24 | 8.6 | - | 0.37 | - | 0.61 | - | 0.01 | 0.73 | 11.56 |
| classic | desktop | spot | 0 | 3.39 | - | - | - | - | 0 | 0 | - | 3.39 |
| classic | desktop | flyover | 0 | 3.83 | - | - | - | - | - | 0 | - | 3.84 |
| classic | phone | spot | 0 | 3.8 | - | - | - | - | 0 | 0 | - | 3.81 |
| classic | phone | flyover | 0 | 9.21 | - | - | - | - | - | 0 | - | 9.21 |

## CPU ms per section (mean per drawn frame, exclusive; `frame` is the game update outside the named sections)

| tier | view | scenario | frame | seePoll | render | env | colour | shadow | ao | aoNormal | bloom | output | fxaa | seeThrough |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1.3 | 0.02 | 0.05 | 0.07 | 2.38 | 0.88 | 0.38 | 1.3 | 0.24 | 0.03 | 0.04 | 0.02 |
| full | desktop | flyover | 0.89 | 0.02 | 0.06 | 0.09 | 3.39 | 0.94 | 0.47 | 1.81 | 0.29 | 0.04 | 0.04 | - |
| full | phone | spot | 1.09 | 0.02 | 0.05 | 0.07 | 2.55 | 0.91 | 0.45 | 1.48 | 0.29 | 0.04 | 0.04 | 0.02 |
| full | phone | flyover | 0.78 | 0.02 | 0.05 | 0.08 | 2.77 | 0.91 | 0.45 | 1.5 | 0.27 | 0.04 | 0.04 | - |
| lite | desktop | spot | 1.53 | 0.02 | 0.06 | 0.09 | 2.97 | 0.68 | 0.11 | - | - | 0.06 | 0.06 | 0.02 |
| lite | desktop | flyover | 1.01 | 0.03 | 0.07 | 0.1 | 4.09 | 0.68 | 0.11 | - | - | 0.05 | 0.05 | - |
| lite | phone | spot | 1.43 | 0.02 | 0.05 | 0.09 | 3.33 | 0.71 | 0.11 | - | - | 0.06 | 0.06 | 0.02 |
| lite | phone | flyover | 1.02 | 0.02 | 0.06 | 0.1 | 3.61 | 0.69 | 0.11 | - | - | 0.05 | 0.06 | - |
| classic | desktop | spot | 1.68 | 0.02 | 0 | - | 2.05 | 0.03 | - | - | - | - | - | 0.02 |
| classic | desktop | flyover | 1.13 | 0.02 | 0.01 | - | 3.07 | 0.03 | - | - | - | - | - | - |
| classic | phone | spot | 1.56 | 0.02 | 0.01 | - | 2.94 | 0.04 | - | - | - | - | - | 0.02 |
| classic | phone | flyover | 1.13 | 0.02 | 0.01 | - | 19.09 | 1.48 | - | - | - | - | - | - |

## Worst frames (> 50 ms, top 5 per row)

- classic desktop flyover: 51.3 ms at 9 s (cpu 7.7, gpu 4.6, no flags; colour 5.7, frame 1.6, shadow 0.1)
- classic phone spot: 104.7 ms at 9.8 s (cpu 100.1, gpu 0, no flags; colour 98.4, frame 1.5, seeThrough 0.1)
- classic phone flyover: 1385.9 ms at 4.3 s (cpu 1384.7, gpu 2.1, no flags; colour 1384.1, frame 0.6, seePoll 0.0); 1375.2 ms at 6 s (cpu 1373.4, gpu 7.2, no flags; colour 1372.1, frame 1.1, shadow 0.1); 906.4 ms at 7.6 s (cpu 904.8, gpu 6.3, no flags; colour 903.8, frame 0.9, shadow 0.1); 872.3 ms at 2 s (cpu 870.1, gpu 1.7, no flags; shadow 858.1, colour 11.1, frame 0.8); 412.8 ms at 3.1 s (cpu 411.7, gpu 2.5, no flags; colour 410.9, frame 0.8, seePoll 0.0)

## Load and memory (the spot rows' pages; repeat: a second visit in the same browser context)

| tier | view | first frame ms | env build ms | bytes before first frame | files | repeat: first frame ms | repeat: env build ms | repeat: bytes | textures (est. MB) | render targets + shadow (est. MB) | GL textures | programs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | 3051 | 1302 (build 604.2) | 7.6 MB | 94 | 1978 | 466 (build 77.5) | 1.1 MB | 8.3 | 109.8 | 95 | 68 |
| full | phone | 3395 | 1561 (build 701.6) | 7.6 MB | 94 | 2979 | 575 (build 138.2) | 1.1 MB | 8.3 | 89.5 | 95 | 68 |
| lite | desktop | 2889 | 1021 (build 397) | 7.6 MB | 94 | 2293 | 486 (build 48.3) | 1.1 MB | 8.0 | 43.6 | 77 | 46 |
| lite | phone | 3120 | 1190 (build 504.3) | 7.6 MB | 94 | 2107 | 362 (build 46.9) | 1.1 MB | 8.0 | 22.8 | 77 | 46 |
| classic | desktop | 1405 | null (build 0) | 7.5 MB | 88 | 1312 | null (build 0) | 1.1 MB | 7.7 | 0.0 | 28 | 15 |
| classic | phone | 1442 | null (build 0) | 7.5 MB | 88 | 2209 | null (build 0) | 7.4 MB | 7.7 | 0.0 | 38 | 15 |
