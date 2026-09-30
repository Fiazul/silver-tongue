# After: 30 fps pacing

Captured 2026-09-30 04:22 UTC with scripts/perf-capture.mjs on http://127.0.0.1:8190/, headless Chrome, ANGLE Vulkan on this machine's AMD Radeon Vega 11 (RADV RAVEN); vsync and the browser frame cap off, a fresh browser per row, query `?promo=1&perf=1&look=<tier>&fps=30`. 10 s per row; interval stats exclude the first second of the recording. Phone rows: 1080x2400 device pixels at DPR 2.6 emulated, drawn by the Vega 11 (emulated pixels, not a phone GPU).

## Frame time (ms, rAF interval between drawn frames)

| tier | view | scenario | canvas px | scale | frames | mean | p95 | max | > 50 ms | causes of > 50 ms | CPU mean / p95 | GPU mean / p95 | calls | triangles | sync reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lite | desktop | spot | 1440x810 | 0.75 | 300 | 33.47 | 44.2 | 73 | 1 | cpu: ao x1 | 6.55 / 10.7 | 4.84 / 6.59 | 127 | 439144 | 0 |
| lite | desktop | flyover | 1440x810 | 0.75 | 301 | 33.29 | 45.2 | 50.4 | 1 | outside the frame (GC, compositor, the tab) x1 | 7.35 / 12 | 13.03 / 29.11 | 171 | 491599 | 0 |
| lite | phone | spot | 466x1038 | 0.75 | 296 | 33.92 | 45.4 | 170.1 | 1 | cpu: seePoll x1 | 7.36 / 10.6 | 11.5 / 21.39 | 127 | 438016 | 0 |
| lite | phone | flyover | 466x1038 | 0.75 | 300 | 33.32 | 44.7 | 50.2 | 1 | outside the frame (GC, compositor, the tab) x1 | 6.86 / 11.8 | 10.71 / 16.5 | 147 | 452521 | 0 |
| full | desktop | spot | 1920x1080 | 1 | 301 | 33.36 | 47.5 | 52.2 | 2 | outside the frame (GC, compositor, the tab) x2 | 12.1 / 18.1 | 18.47 / 28.12 | 221 | 714417 | 0 |
| full | desktop | flyover | 1920x1080 | 1 | 211 | 49.8 | 48.7 | 686.4 | 8 | cpu: colour x5, outside the frame (GC, compositor, the tab) x1, gpu x1, texture / buffer upload x1 | 26.34 / 20.2 | 18.69 / 67.61 | 292 | 811243 | 0 |
| full | phone | spot | 830x1846 | 1 | 301 | 33.35 | 46 | 48.7 | 0 | - | 10.34 / 15.1 | 15.14 / 30.35 | 222 | 711546 | 0 |
| full | phone | flyover | 830x1846 | 1 | 291 | 33.69 | 47.4 | 108 | 2 | cpu: colour x1, outside the frame (GC, compositor, the tab) x1 | 13.05 / 19.5 | 16.84 / 42.83 | 250 | 729124 | 0 |

## GPU ms per pass (mean per drawn frame; EXT_disjoint_timer_query_webgl2, exclusive)

| tier | view | scenario | shadow | colour | aoNormal | ao | bloom | output | seeThrough | seePoll | fxaa | total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lite | desktop | spot | 0.16 | 2.94 | - | 0.87 | - | 0.33 | 0.11 | 0 | 0.42 | 4.84 |
| lite | desktop | flyover | 1.22 | 9.43 | - | 0.78 | - | 0.46 | - | 0 | 1.14 | 13.03 |
| lite | phone | spot | 0.75 | 7.5 | - | 0.66 | - | 0.66 | 1.45 | 0.01 | 0.47 | 11.5 |
| lite | phone | flyover | 0.62 | 8.87 | - | 0.28 | - | 0.33 | - | 0 | 0.61 | 10.71 |
| full | desktop | spot | 1.24 | 8.5 | 0.77 | 4.32 | 0.97 | 1.11 | 0.61 | 0 | 0.96 | 18.47 |
| full | desktop | flyover | 5.64 | 5.04 | 0.58 | 4.48 | 1.46 | 0.44 | - | 0 | 1.06 | 18.69 |
| full | phone | spot | 0.99 | 7.32 | 1.32 | 2.96 | 0.75 | 1.1 | 0 | 0 | 0.69 | 15.14 |
| full | phone | flyover | 2.33 | 6.7 | 1.51 | 3.33 | 1.54 | 0.5 | - | 0 | 0.93 | 16.84 |

## CPU ms per section (mean per drawn frame, exclusive; `frame` is the game update outside the named sections)

| tier | view | scenario | frame | seePoll | render | env | colour | shadow | ao | output | fxaa | seeThrough | aoNormal | bloom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lite | desktop | spot | 1.72 | 0.04 | 0.06 | 0.11 | 3.31 | 0.75 | 0.3 | 0.06 | 0.06 | 0.05 | - | - |
| lite | desktop | flyover | 1.17 | 0.03 | 0.07 | 0.13 | 4.83 | 0.8 | 0.13 | 0.06 | 0.06 | - | - | - |
| lite | phone | spot | 1.61 | 0.58 | 0.07 | 0.11 | 3.82 | 0.77 | 0.13 | 0.06 | 0.06 | 0.05 | - | - |
| lite | phone | flyover | 1.15 | 0.03 | 0.07 | 0.13 | 4.36 | 0.77 | 0.13 | 0.07 | 0.07 | - | - | - |
| full | desktop | spot | 1.9 | 0.03 | 0.07 | 0.11 | 4.25 | 1.55 | 0.72 | 0.06 | 0.06 | 0.03 | 2.7 | 0.43 |
| full | desktop | flyover | 1.21 | 0.03 | 0.07 | 0.13 | 19.53 | 1.35 | 0.61 | 0.05 | 0.06 | - | 2.7 | 0.43 |
| full | phone | spot | 1.61 | 0.03 | 0.06 | 0.11 | 3.81 | 1.32 | 0.58 | 0.05 | 0.05 | 0.02 | 2.13 | 0.41 |
| full | phone | flyover | 1.17 | 0.03 | 0.08 | 0.12 | 5.9 | 1.49 | 0.7 | 0.05 | 0.06 | - | 2.87 | 0.43 |

## Worst frames (> 50 ms, top 5 per row)

- lite desktop spot: 73 ms at 3.9 s (cpu 70.2, gpu 6.1, no flags; ao 60.0, colour 5.5, shadow 2.4)
- lite desktop flyover: 50.4 ms at 5.1 s (cpu 13.3, gpu 5.3, no flags; colour 9.0, shadow 2.9, frame 1.0)
- lite phone spot: 170.1 ms at 5.3 s (cpu 169, gpu 10.8, no flags; seePoll 161.3, colour 3.2, shadow 1.9)
- lite phone flyover: 50.2 ms at 4.6 s (cpu 14.2, gpu 3, no flags; colour 9.3, shadow 2.7, frame 1.4)
- full desktop spot: 52.2 ms at 2.4 s (cpu 10.6, gpu 12.2, no flags; colour 4.4, aoNormal 2.4, frame 1.9); 50.2 ms at 4.4 s (cpu 13.7, gpu 11.7, no flags; colour 5.3, aoNormal 3.2, frame 2.8)
- full desktop flyover: 686.4 ms at 5.4 s (cpu 685.2, gpu 13.4, upload 2 ms; colour 677.6, shadow 3.1, frame 1.8); 654.5 ms at 4.2 s (cpu 652.5, gpu 13, upload 1 ms; colour 645.5, aoNormal 2.3, shadow 2.3); 644.2 ms at 3 s (cpu 642.7, gpu 346.1, no flags; colour 633.7, aoNormal 3.3, shadow 2.9); 461.6 ms at 6.7 s (cpu 459.7, gpu 193.2, no flags; colour 452.1, aoNormal 2.8, shadow 2.7); 460.1 ms at 1.9 s (cpu 458.9, gpu 266.1, no flags; colour 448.9, shadow 3.9, aoNormal 2.6)
- full phone flyover: 108 ms at 2.3 s (cpu 105.2, gpu 8.1, upload 2 ms; colour 95.4, aoNormal 5.8, frame 1.0); 50.3 ms at 9 s (cpu 13.4, gpu 7.5, no flags; aoNormal 5.1, colour 4.6, frame 1.3)

## Load and memory (the spot rows' pages; repeat: a second visit in the same browser context)

| tier | view | first frame ms | env build ms | bytes before first frame | files | repeat: first frame ms | repeat: env build ms | repeat: bytes | textures (est. MB) | render targets + shadow (est. MB) | GL textures | programs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lite | desktop | 6469 | 1211 (build 512.4) | 7.6 MB | 94 | 2666 | 489 (build 90.8) | 7.6 MB | 8.0 | 43.6 | 77 | 46 |
| lite | phone | 3526 | 1100 (build 482.8) | 7.6 MB | 94 | 2874 | 497 (build 61.8) | 7.6 MB | 8.0 | 22.8 | 77 | 46 |
| full | desktop | 5793 | 1976 (build 944.2) | 7.6 MB | 94 | 4101 | 1813 (build 142.8) | 7.6 MB | 8.3 | 109.8 | 95 | 68 |
| full | phone | 4244 | 2111 (build 987.5) | 7.6 MB | 94 | 3511 | 707 (build 193.9) | 7.6 MB | 8.3 | 89.5 | 95 | 68 |
