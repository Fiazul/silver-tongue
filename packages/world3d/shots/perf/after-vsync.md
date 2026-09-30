# After: 60 fps cap with vsync on (the browser's own 60 Hz frame clock)

Captured 2026-09-30 04:25 UTC with scripts/perf-capture.mjs on http://127.0.0.1:8190/, headless Chrome, ANGLE Vulkan on this machine's AMD Radeon Vega 11 (RADV RAVEN); vsync and the browser frame cap off, a fresh browser per row, query `?promo=1&perf=1&look=<tier>`. 10 s per row; interval stats exclude the first second of the recording. Phone rows: 1080x2400 device pixels at DPR 2.6 emulated, drawn by the Vega 11 (emulated pixels, not a phone GPU).

## Frame time (ms, rAF interval between drawn frames)

| tier | view | scenario | canvas px | scale | frames | mean | p95 | max | > 50 ms | causes of > 50 ms | CPU mean / p95 | GPU mean / p95 | calls | triangles | sync reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1920x1080 | 1 | 561 | 17.86 | 19.9 | 38.5 | 0 | - | 7.86 / 11.2 | 14.25 / 15.99 | 221 | 714221 | 0 |
| full | desktop | flyover | 1920x1080 | 1 | 580 | 17.34 | 20.7 | 31.2 | 0 | - | 8.97 / 13.2 | 13.79 / 17.71 | 285 | 797702 | 0 |
| full | phone | spot | 830x1846 | 1 | 600 | 16.7 | 16.9 | 31.4 | 0 | - | 6.95 / 9.8 | 13.72 / 16.31 | 222 | 711235 | 0 |
| full | phone | flyover | 830x1846 | 1 | 603 | 16.67 | 16.8 | 16.9 | 0 | - | 7.11 / 9 | 13.17 / 15.25 | 251 | 731832 | 0 |
| lite | desktop | spot | 1440x810 | 0.75 | 601 | 16.67 | 16.9 | 25 | 0 | - | 6.57 / 8.8 | 11.3 / 13.89 | 125 | 435759 | 0 |
| lite | desktop | flyover | 1440x810 | 0.75 | 601 | 16.67 | 16.9 | 18.6 | 0 | - | 6.91 / 9.7 | 11.61 / 14.64 | 171 | 491094 | 0 |
| lite | phone | spot | 378x841 | 0.608 | 600 | 16.67 | 16.8 | 21.3 | 0 | - | 6.25 / 8 | 14.02 / 26.13 | 127 | 436009 | 0 |
| lite | phone | flyover | 466x1038 | 0.75 | 601 | 16.67 | 16.8 | 17.2 | 0 | - | 6.31 / 9.1 | 11.98 / 15.07 | 147 | 452485 | 0 |

## GPU ms per pass (mean per drawn frame; EXT_disjoint_timer_query_webgl2, exclusive)

| tier | view | scenario | shadow | colour | aoNormal | ao | bloom | output | seeThrough | seePoll | fxaa | total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1.18 | 7.23 | 0.61 | 3.22 | 0.58 | 0.6 | 0 | 0 | 0.83 | 14.25 |
| full | desktop | flyover | 1.32 | 6.8 | 0.93 | 2.82 | 0.65 | 0.54 | - | 0 | 0.73 | 13.79 |
| full | phone | spot | 1.29 | 7.54 | 0.69 | 2.56 | 0.5 | 0.49 | 0 | 0 | 0.65 | 13.72 |
| full | phone | flyover | 1.52 | 6.49 | 1.16 | 2.38 | 0.52 | 0.47 | - | 0.01 | 0.61 | 13.17 |
| lite | desktop | spot | 0.85 | 8.21 | - | 0.74 | - | 0.56 | 0 | 0.01 | 0.91 | 11.3 |
| lite | desktop | flyover | 0.81 | 8.83 | - | 0.51 | - | 0.62 | - | 0.05 | 0.8 | 11.61 |
| lite | phone | spot | 0.99 | 10.97 | - | 0.71 | - | 0.49 | 0 | 0 | 0.86 | 14.02 |
| lite | phone | flyover | 1.28 | 9.01 | - | 0.39 | - | 0.59 | - | 0.01 | 0.7 | 11.98 |

## CPU ms per section (mean per drawn frame, exclusive; `frame` is the game update outside the named sections)

| tier | view | scenario | frame | seePoll | seeThrough | render | env | colour | shadow | ao | aoNormal | bloom | output | fxaa |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1.3 | 0.02 | 0.02 | 0.05 | 0.08 | 2.75 | 1.16 | 0.49 | 1.53 | 0.26 | 0.03 | 0.03 |
| full | desktop | flyover | 0.94 | 0.02 | - | 0.05 | 0.1 | 3.72 | 1.12 | 0.53 | 1.96 | 0.3 | 0.04 | 0.04 |
| full | phone | spot | 1.1 | 0.02 | 0.01 | 0.05 | 0.07 | 2.46 | 0.88 | 0.48 | 1.39 | 0.27 | 0.03 | 0.04 |
| full | phone | flyover | 0.73 | 0.02 | - | 0.06 | 0.07 | 2.9 | 0.95 | 0.47 | 1.45 | 0.27 | 0.04 | 0.04 |
| lite | desktop | spot | 1.61 | 0.02 | 0.03 | 0.06 | 0.12 | 3.64 | 0.78 | 0.11 | - | - | 0.05 | 0.06 |
| lite | desktop | flyover | 0.99 | 0.02 | - | 0.07 | 0.1 | 4.61 | 0.81 | 0.11 | - | - | 0.05 | 0.06 |
| lite | phone | spot | 1.52 | 0.02 | 0.02 | 0.06 | 0.1 | 3.46 | 0.74 | 0.11 | - | - | 0.05 | 0.06 |
| lite | phone | flyover | 1.01 | 0.02 | - | 0.07 | 0.11 | 4.03 | 0.75 | 0.11 | - | - | 0.06 | 0.06 |

## Worst frames (> 50 ms, top 5 per row)


## Load and memory (the spot rows' pages; repeat: a second visit in the same browser context)

| tier | view | first frame ms | env build ms | bytes before first frame | files | repeat: first frame ms | repeat: env build ms | repeat: bytes | textures (est. MB) | render targets + shadow (est. MB) | GL textures | programs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | 3419 | 1554 (build 724.9) | 7.6 MB | 94 | 1905 | 472 (build 77.7) | 7.6 MB | 8.3 | 109.8 | 95 | 68 |
| full | phone | 3390 | 1495 (build 657.9) | 7.6 MB | 94 | 1994 | 565 (build 80.3) | 7.6 MB | 8.3 | 89.5 | 95 | 68 |
| lite | desktop | 2695 | 943 (build 393) | 7.6 MB | 94 | 1738 | 363 (build 39.8) | 7.6 MB | 8.0 | 43.6 | 77 | 46 |
| lite | phone | 2962 | 1162 (build 489.8) | 7.6 MB | 94 | 2006 | 424 (build 45) | 7.6 MB | 8.0 | 17.7 | 77 | 46 |
