# After: uncapped (fps=0), the work per frame

Captured 2026-09-30 04:19 UTC with scripts/perf-capture.mjs on http://127.0.0.1:8190/, headless Chrome, ANGLE Vulkan on this machine's AMD Radeon Vega 11 (RADV RAVEN); vsync and the browser frame cap off, a fresh browser per row, query `?promo=1&perf=1&look=<tier>&fps=0`. 10 s per row; interval stats exclude the first second of the recording. Phone rows: 1080x2400 device pixels at DPR 2.6 emulated, drawn by the Vega 11 (emulated pixels, not a phone GPU).

## Frame time (ms, rAF interval between drawn frames)

| tier | view | scenario | canvas px | scale | frames | mean | p95 | max | > 50 ms | causes of > 50 ms | CPU mean / p95 | GPU mean / p95 | calls | triangles | sync reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1920x1080 | 1 | 311 | 28.61 | 16.8 | 1789.8 | 7 | cpu: colour x7 | 31.52 / 14.8 | 14.16 / 16.21 | 224 | 721057 | 0 |
| full | desktop | flyover | 1920x1080 | 1 | 141 | 69.01 | 26.5 | 1857.7 | 4 | cpu: colour x4 | 76.88 / 24.6 | 21.98 / 17.96 | 329 | 882487 | 0 |
| full | phone | spot | 830x1846 | 1 | 241 | 41.68 | 17.6 | 1951.6 | 5 | cpu: colour x2, cpu: aoNormal x3 | 46.15 / 15.2 | 13.27 / 13.19 | 222 | 711291 | 0 |
| full | phone | flyover | 830x1846 | 1 | 561 | 16.47 | 20.3 | 1191 | 5 | cpu: colour x3, cpu: bloom x1, cpu: fxaa x1 | 16.27 / 17.4 | 11.55 / 15.19 | 254 | 735184 | 0 |
| lite | desktop | spot | 1440x810 | 0.75 | 494 | 20.08 | 9.7 | 2153.9 | 6 | cpu: colour x4, cpu: shadow x2 | 20.94 / 9.1 | 6.54 / 6.7 | 127 | 438016 | 0 |
| lite | desktop | flyover | 1440x810 | 0.75 | 887 | 10.02 | 15.8 | 630.9 | 6 | cpu: colour x5, outside the frame (GC, compositor, the tab) x1 | 10.65 / 13.3 | 7.1 / 9.3 | 162 | 476279 | 0 |
| lite | phone | spot | 466x1038 | 0.75 | 660 | 17.49 | 11.3 | 1379.8 | 5 | cpu: colour x5 | 15.89 / 9.7 | 5.66 / 5.96 | 127 | 435776 | 0 |
| lite | phone | flyover | 466x1038 | 0.75 | 895 | 10.27 | 10.6 | 1284.5 | 4 | cpu: colour x3, cpu: shadow x1 | 10.62 / 9.7 | 5.07 / 7.97 | 163 | 478292 | 0 |

## GPU ms per pass (mean per drawn frame; EXT_disjoint_timer_query_webgl2, exclusive)

| tier | view | scenario | shadow | colour | aoNormal | ao | bloom | output | seeThrough | seePoll | fxaa | total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 0.63 | 5.44 | 0.54 | 2.87 | 3.42 | 0.54 | 0.01 | 0 | 0.71 | 14.16 |
| full | desktop | flyover | 0.76 | 12.26 | 0.57 | 4.37 | 0.74 | 0.38 | - | 0 | 2.9 | 21.98 |
| full | phone | spot | 0.5 | 5.97 | 0.44 | 2.65 | 2.87 | 0.37 | 0 | 0 | 0.48 | 13.27 |
| full | phone | flyover | 2.09 | 4.14 | 0.6 | 2.13 | 1.72 | 0.38 | - | 0 | 0.49 | 11.55 |
| lite | desktop | spot | 0.16 | 4.59 | - | 0.53 | - | 0.82 | 0 | 0 | 0.44 | 6.54 |
| lite | desktop | flyover | 0.66 | 5.18 | - | 0.45 | - | 0.32 | - | 0 | 0.49 | 7.1 |
| lite | phone | spot | 0.5 | 3.3 | - | 0.7 | - | 0.17 | 0 | 0 | 0.98 | 5.66 |
| lite | phone | flyover | 0.4 | 4.03 | - | 0.25 | - | 0.17 | - | 0 | 0.22 | 5.07 |

## CPU ms per section (mean per drawn frame, exclusive; `frame` is the game update outside the named sections)

| tier | view | scenario | frame | seePoll | seeThrough | shadow | render | env | colour | ao | aoNormal | bloom | output | fxaa |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1.21 | 0.03 | 0.04 | 1.18 | 0.06 | 0.09 | 25.93 | 0.53 | 1.94 | 0.31 | 0.04 | 0.04 |
| full | desktop | flyover | 1.08 | 0.02 | - | 1.17 | 0.06 | 0.11 | 67.4 | 0.6 | 5.85 | 0.32 | 0.04 | 0.05 |
| full | phone | spot | 1.01 | 0.03 | 0.02 | 12.58 | 0.04 | 0.08 | 10.77 | 0.42 | 20.77 | 0.25 | 0.03 | 0.04 |
| full | phone | flyover | 1.08 | 0.02 | - | 1.88 | 0.06 | 0.1 | 6.45 | 0.58 | 2.41 | 2.44 | 0.05 | 1.07 |
| lite | desktop | spot | 1.25 | 0.02 | 0.02 | 2.84 | 0.04 | 0.07 | 16.47 | 0.08 | - | - | 0.04 | 0.04 |
| lite | desktop | flyover | 1.15 | 0.02 | - | 0.76 | 0.06 | 0.12 | 8.21 | 0.13 | - | - | 0.06 | 0.05 |
| lite | phone | spot | 1.31 | 0.02 | 0.02 | 0.66 | 0.05 | 0.08 | 13.49 | 0.11 | - | - | 0.04 | 0.05 |
| lite | phone | flyover | 1.01 | 0.02 | - | 2.77 | 0.05 | 0.09 | 6.41 | 0.11 | - | - | 0.04 | 0.05 |

## Worst frames (> 50 ms, top 5 per row)

- full desktop spot: 1789.8 ms at 5.3 s (cpu 1787.5, gpu 15.9, no flags; colour 1782.7, aoNormal 1.8, frame 1.4); 1759.4 ms at 3.3 s (cpu 1757.7, gpu 16.6, no flags; colour 1751.7, aoNormal 2.5, shadow 1.5); 800.7 ms at 7.4 s (cpu 799.1, gpu 16.3, no flags; colour 795.3, shadow 1.1, aoNormal 1.0); 511.3 ms at 2.5 s (cpu 509.6, gpu 15.3, no flags; colour 500.7, aoNormal 3.8, shadow 1.8); 162.4 ms at 9.5 s (cpu 160.8, gpu 0, no flags; colour 157.1, aoNormal 1.6, frame 0.7)
- full desktop flyover: 1857.7 ms at 7.3 s (cpu 1856, gpu 0, no flags; colour 1847.7, aoNormal 5.3, ao 1.1); 1846.2 ms at 5.3 s (cpu 1844.6, gpu 0, no flags; colour 1839.3, aoNormal 3.5, frame 0.8); 1829.3 ms at 3.2 s (cpu 1827, gpu 6, disjoint; colour 1818.1, aoNormal 5.6, frame 1.3); 424.8 ms at 2.6 s (cpu 423.7, gpu 12.8, no flags; colour 409.8, aoNormal 7.2, ao 4.8)
- full phone spot: 1951.6 ms at 7.4 s (cpu 1950, gpu 0, no flags; aoNormal 1946.6, colour 1.9, frame 0.6); 1855.1 ms at 5.3 s (cpu 1853.3, gpu 1.4, no flags; aoNormal 1845.9, bloom 1.9, colour 1.8); 1266.2 ms at 2.7 s (cpu 1264, gpu 12.9, no flags; colour 1258.9, aoNormal 1.5, shadow 1.5); 875.4 ms at 4.2 s (cpu 873.3, gpu 10.8, no flags; aoNormal 869.7, colour 1.6, frame 0.7); 710.1 ms at 1.6 s (cpu 708.4, gpu 12.1, no flags; colour 702.5, aoNormal 3.0, frame 1.1)
- full phone flyover: 1191 ms at 7.3 s (cpu 1189.1, gpu 10.4, no flags; bloom 1185.2, colour 1.3, shadow 0.9); 582.9 ms at 9.3 s (cpu 580.5, gpu 0, no flags; fxaa 575.6, shadow 1.3, colour 1.2); 433.3 ms at 1.6 s (cpu 430.6, gpu 13.4, no flags; colour 422.2, aoNormal 3.7, shadow 1.9); 223.6 ms at 6.8 s (cpu 222.2, gpu 10.9, no flags; colour 217.6, aoNormal 1.6, shadow 1.2); 155.3 ms at 2.2 s (cpu 153.4, gpu 24.3, no flags; colour 146.2, aoNormal 3.6, shadow 1.2)
- lite desktop spot: 2153.9 ms at 6.2 s (cpu 2151.9, gpu 0, no flags; colour 2147.8, frame 2.3, shadow 1.4); 1303.1 ms at 4.6 s (cpu 1300.4, gpu 0, no flags; colour 1298.7, frame 0.9, ao 0.3); 600.4 ms at 2.1 s (cpu 598.1, gpu 7, no flags; shadow 593.7, colour 3.2, frame 0.8); 543.5 ms at 3.8 s (cpu 541.5, gpu 7.9, no flags; shadow 537.9, colour 2.4, frame 0.9); 486.8 ms at 3 s (cpu 483.7, gpu 7.2, no flags; colour 482.6, frame 0.7, render 0.2)
- lite desktop flyover: 630.9 ms at 9 s (cpu 629.4, gpu 0, no flags; colour 626.6, shadow 1.4, frame 1.0); 302.8 ms at 2.4 s (cpu 299.1, gpu 7.4, no flags; colour 297.3, frame 1.0, ao 0.2); 275.8 ms at 2.9 s (cpu 274.2, gpu 8.7, no flags; colour 271.8, shadow 1.0, frame 0.8); 246.7 ms at 1.6 s (cpu 245.5, gpu 277.5, no flags; colour 240.8, shadow 2.7, frame 1.5); 62.4 ms at 8.7 s (cpu 60.8, gpu 0, no flags; colour 58.8, shadow 1.0, frame 0.7)
- lite phone spot: 1379.8 ms at 6.5 s (cpu 1377.5, gpu 0, no flags; colour 1376.1, frame 0.9, render 0.2); 1351.4 ms at 8.2 s (cpu 1349.3, gpu 0, no flags; colour 1346.8, shadow 1.2, frame 0.9); 1316.5 ms at 4.9 s (cpu 1314.1, gpu 4, no flags; colour 1312.7, frame 1.0, ao 0.2); 1067.4 ms at 2.7 s (cpu 1064.6, gpu 4, no flags; colour 1062.5, frame 1.3, ao 0.2); 338.6 ms at 2 s (cpu 336.2, gpu 4.5, no flags; colour 333.5, shadow 1.3, frame 0.8)
- lite phone flyover: 1284.5 ms at 7.3 s (cpu 1282.3, gpu 0, no flags; colour 1280.1, ao 0.8, frame 0.7); 590 ms at 6.3 s (cpu 587.3, gpu 0, no flags; shadow 581.8, colour 4.2, frame 0.7); 575 ms at 5.5 s (cpu 573, gpu 3.6, no flags; colour 572.1, frame 0.5, ao 0.2); 389.9 ms at 4.3 s (cpu 388.1, gpu 4.5, no flags; colour 387.2, frame 0.6, seePoll 0.1)

## Load and memory (the spot rows' pages; repeat: a second visit in the same browser context)

| tier | view | first frame ms | env build ms | bytes before first frame | files | repeat: first frame ms | repeat: env build ms | repeat: bytes | textures (est. MB) | render targets + shadow (est. MB) | GL textures | programs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | 4700 | 2523 (build 752.8) | 7.6 MB | 94 | 3133 | 789 (build 123.6) | 7.6 MB | 8.3 | 109.8 | 95 | 68 |
| full | phone | 4892 | 2245 (build 764) | 7.6 MB | 94 | 6553 | 2727 (build 112) | 7.6 MB | 8.3 | 89.5 | 95 | 68 |
| lite | desktop | 6035 | 3844 (build 764.9) | 7.6 MB | 94 | 5142 | 1455 (build 95.1) | 7.6 MB | 8.0 | 43.6 | 77 | 46 |
| lite | phone | 5334 | 2621 (build 759.9) | 7.6 MB | 94 | 4959 | 468 (build 59.5) | 7.6 MB | 8.0 | 22.8 | 77 | 46 |
