# Performance before (HEAD 256cd43 + the ?perf=1 probe only)

Captured 2026-09-30 03:52 UTC with scripts/perf-capture.mjs on http://127.0.0.1:8191/, headless Chrome, ANGLE Vulkan on this machine's AMD Radeon Vega 11 (RADV RAVEN); vsync and the browser frame cap off, a fresh browser per row, query `?promo=1&perf=1&look=<tier>&fps=0`. 10 s per row; interval stats exclude the first second of the recording. Phone rows: 1080x2400 device pixels at DPR 2.6 emulated, drawn by the Vega 11 (emulated pixels, not a phone GPU).

## Frame time (ms, rAF interval between drawn frames)

| tier | view | scenario | canvas px | scale | frames | mean | p95 | max | > 50 ms | causes of > 50 ms | CPU mean / p95 | GPU mean / p95 | calls | triangles | sync reads |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1920x1080 | 1 | 260 | 33.33 | 77.5 | 883.9 | 20 | sync read-back x15, cpu: shadow x1, cpu: colour x4 | 37.96 / 77.2 | 32.1 / 47.12 | 307 | 1061800 | 21 |
| full | desktop | flyover | 1920x1080 | 1 | 272 | 37.37 | 351.9 | 461.1 | 15 | cpu: bloom x4, cpu: shadow x5, gpu x1, cpu: colour x3, texture / buffer upload x2 | 41.63 / 352.6 | 34.48 / 43.41 | 394 | 1181246 | 0 |
| full | phone | spot | 830x1846 | 1 | 342 | 27.71 | 16.9 | 869.6 | 12 | cpu: seePoll x2, cpu: colour x4, sync read-back x1, cpu: shadow x5 | 28.98 / 73.9 | 27.53 / 35.04 | 305 | 1058370 | 1 |
| full | phone | flyover | 830x1846 | 1 | 408 | 24.32 | 229.8 | 390.5 | 19 | cpu: output x1, cpu: shadow x8, cpu: bloom x1, texture / buffer upload x2, cpu: colour x7 | 26.2 / 222.9 | 23.23 / 28.9 | 372 | 1147980 | 0 |
| lite | desktop | spot | 1920x1080 | 1 | 295 | 30.08 | 14.6 | 1345.7 | 9 | sync read-back x4, cpu: shadow x3, cpu: aoNormal x1, cpu: colour x1 | 33.47 / 75.7 | 29.63 / 42.82 | 298 | 999859 | 16 |
| lite | desktop | flyover | 1920x1080 | 1 | 322 | 32.7 | 403.7 | 436.9 | 15 | cpu: colour x14, texture / buffer upload x1 | 36.7 / 399.1 | 30.13 / 37.51 | 387 | 1123018 | 0 |
| lite | phone | spot | 830x1846 | 1 | 389 | 25.44 | 12.3 | 672.6 | 10 | sync read-back x1, cpu: shadow x7, cpu: output x1, outside the frame (GC, compositor, the tab) x1 | 24.74 / 14.2 | 24.94 / 31.7 | 296 | 997242 | 9 |
| lite | phone | flyover | 830x1846 | 1 | 443 | 23.62 | 232 | 387.1 | 20 | cpu: colour x14, texture / buffer upload x3, cpu: shadow x3 | 24.07 / 137.3 | 22.36 / 27.89 | 364 | 1088646 | 0 |
| classic | desktop | spot | 1920x1080 | 1 | 1387 | 7.25 | 9.7 | 20.7 | 0 | - | 5.28 / 7.8 | 4.22 / 5.4 | 68 | 307378 | 0 |
| classic | desktop | flyover | 1920x1080 | 1 | 1570 | 6.27 | 9.5 | 19.8 | 0 | - | 5.51 / 8.1 | 4.72 / 6.82 | 103 | 357476 | 0 |
| classic | phone | spot | 830x1846 | 1 | 2520 | 4 | 4.8 | 11 | 0 | - | 3.15 / 3.8 | 2.88 / 3.58 | 74 | 318216 | 0 |
| classic | phone | flyover | 830x1846 | 1 | 1303 | 7.52 | 13.1 | 25 | 0 | - | 6.04 / 10.8 | 5.35 / 10.36 | 84 | 326998 | 0 |

## GPU ms per pass (mean per drawn frame; EXT_disjoint_timer_query_webgl2, exclusive)

| tier | view | scenario | shadow | colour | aoNormal | ao | bloom | output | seeThrough | seePoll | total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 2.21 | 8.31 | 0.82 | 17.53 | 2.03 | 0.84 | 0.36 | 0 | 32.1 |
| full | desktop | flyover | 3.58 | 9.48 | 1.26 | 16.94 | 2.27 | 0.95 | - | 0 | 34.48 |
| full | phone | spot | 2.2 | 8.11 | 0.88 | 14.13 | 1.67 | 0.47 | 0.03 | 0.04 | 27.53 |
| full | phone | flyover | 3.33 | 6.15 | 0.83 | 10.97 | 1.56 | 0.39 | - | 0 | 23.23 |
| lite | desktop | spot | 2.15 | 8.04 | 0.91 | 17.43 | - | 0.85 | 0.24 | 0 | 29.63 |
| lite | desktop | flyover | 3.14 | 8.26 | 1.16 | 16.69 | - | 0.87 | - | 0 | 30.13 |
| lite | phone | spot | 2.21 | 7.43 | 0.91 | 13.84 | - | 0.47 | 0.07 | 0 | 24.94 |
| lite | phone | flyover | 3.35 | 6.13 | 0.89 | 11.56 | - | 0.42 | - | 0 | 22.36 |
| classic | desktop | spot | 0 | 4.21 | - | - | - | - | 0 | 0 | 4.22 |
| classic | desktop | flyover | 0 | 4.72 | - | - | - | - | - | 0 | 4.72 |
| classic | phone | spot | 0 | 2.87 | - | - | - | - | 0 | 0 | 2.88 |
| classic | phone | flyover | 0 | 5.35 | - | - | - | - | - | 0 | 5.35 |

## CPU ms per section (mean per drawn frame, exclusive; `frame` is the game update outside the named sections)

| tier | view | scenario | frame | seePoll | render | env | colour | shadow | ao | aoNormal | bloom | output | seeThrough | syncRead |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | spot | 1.06 | 0.02 | 0.03 | 0.02 | 18.92 | 5.38 | 0.44 | 1.23 | 0.27 | 0.05 | 0.09 | 10.34 |
| full | desktop | flyover | 1.05 | 0.02 | 0.07 | 0.03 | 18.71 | 11.6 | 0.61 | 3.81 | 5.56 | 0.05 | - | - |
| full | phone | spot | 1 | 3.19 | 0.04 | 0.02 | 7.84 | 12.51 | 0.39 | 1.1 | 0.24 | 0.04 | 0.04 | 2.48 |
| full | phone | flyover | 0.86 | 0.02 | 0.05 | 0.02 | 10.71 | 10.31 | 0.49 | 1.69 | 1.34 | 0.6 | - | - |
| lite | desktop | spot | 1.09 | 0.02 | 0.04 | 0.01 | 5.04 | 12.51 | 0.42 | 4.32 | - | 0.05 | 0.05 | 9.82 |
| lite | desktop | flyover | 0.95 | 0.02 | 0.04 | 0.02 | 29.87 | 3.4 | 0.51 | 1.74 | - | 0.06 | - | - |
| lite | phone | spot | 1 | 0.02 | 0.04 | 0.01 | 2.15 | 13.36 | 2.06 | 1.15 | - | 1.68 | 0.03 | 3.17 |
| lite | phone | flyover | 0.91 | 0.02 | 0.04 | 0.02 | 15.11 | 5.66 | 0.48 | 1.69 | - | 0.05 | - | - |
| classic | desktop | spot | 2.1 | 0.02 | 0.01 | - | 3 | 0.05 | - | - | - | - | 0.03 | - |
| classic | desktop | flyover | 1.33 | 0.02 | 0.01 | - | 4.02 | 0.05 | - | - | - | - | - | - |
| classic | phone | spot | 1.15 | 0.02 | 0.01 | - | 1.89 | 0.03 | - | - | - | - | 0.02 | - |
| classic | phone | flyover | 1.37 | 0.03 | 0.01 | - | 4.47 | 0.08 | - | - | - | - | - | - |

## Worst frames (> 50 ms, top 5 per row)

- full desktop spot: 883.9 ms at 8.2 s (cpu 882.2, gpu 0, no flags; colour 875.1, shadow 2.9, aoNormal 1.7); 880.9 ms at 6 s (cpu 879.3, gpu 42.4, no flags; colour 873.6, shadow 2.5, aoNormal 1.4); 873.7 ms at 4.9 s (cpu 872, gpu 43.6, no flags; colour 864.8, shadow 3.3, aoNormal 1.9); 871.8 ms at 7.1 s (cpu 869.9, gpu 42.4, no flags; colour 860.0, shadow 3.2, frame 3.1); 849.7 ms at 2.7 s (cpu 848.3, gpu 46.1, syncRead; syncRead 836.9, shadow 3.8, colour 3.1)
- full desktop flyover: 461.1 ms at 7.8 s (cpu 458.6, gpu 42.7, upload+upload 444 ms; colour 450.5, shadow 3.5, aoNormal 2.4); 452.8 ms at 8.4 s (cpu 451.2, gpu 46.5, upload+upload 439 ms; colour 444.7, shadow 2.8, aoNormal 1.8); 449.1 ms at 9 s (cpu 447, gpu 0, no flags; colour 439.7, shadow 2.9, aoNormal 1.9); 445.8 ms at 7.2 s (cpu 444.3, gpu 45.7, no flags; colour 438.2, shadow 2.7, aoNormal 1.8); 441.5 ms at 6.6 s (cpu 439.8, gpu 42.7, no flags; colour 432.3, shadow 3.6, aoNormal 1.9)
- full phone spot: 869.6 ms at 1.9 s (cpu 866.7, gpu 41.1, syncRead; syncRead 848.7, shadow 5.6, colour 4.5); 645.5 ms at 3.8 s (cpu 643.2, gpu 35, no flags; shadow 637.9, colour 2.1, aoNormal 1.2); 636.5 ms at 6.3 s (cpu 634.7, gpu 35.7, no flags; colour 628.4, shadow 3.1, aoNormal 1.4); 636 ms at 7.9 s (cpu 634.2, gpu 35.3, no flags; shadow 628.7, colour 2.2, frame 1.5); 632.9 ms at 4.6 s (cpu 631.1, gpu 35.3, no flags; colour 624.5, shadow 2.9, aoNormal 1.5)
- full phone flyover: 390.5 ms at 9 s (cpu 388.4, gpu 0, no flags; shadow 382.7, aoNormal 2.0, colour 1.9); 369.1 ms at 8.5 s (cpu 367.8, gpu 29.4, no flags; shadow 360.6, colour 3.9, aoNormal 1.4); 343.2 ms at 7.9 s (cpu 340.8, gpu 30.2, upload+upload 328 ms; shadow 332.4, colour 4.7, aoNormal 1.7); 327.6 ms at 7.4 s (cpu 325.8, gpu 31.4, no flags; shadow 318.3, colour 3.7, aoNormal 2.0); 320.3 ms at 6.9 s (cpu 318.3, gpu 30.7, no flags; colour 311.1, shadow 3.1, aoNormal 2.0)
- lite desktop spot: 1345.7 ms at 3.2 s (cpu 1344.4, gpu 44.5, syncRead; syncRead 1335.5, shadow 3.1, colour 3.0); 915.7 ms at 5.7 s (cpu 914.1, gpu 40.2, no flags; aoNormal 906.6, shadow 2.8, colour 2.3); 867.2 ms at 8.1 s (cpu 865.8, gpu 0, no flags; shadow 860.4, colour 2.6, aoNormal 1.3); 862.7 ms at 6.9 s (cpu 861.5, gpu 39.7, no flags; colour 854.3, shadow 2.7, frame 1.7); 581.4 ms at 2.5 s (cpu 579.9, gpu 42, no flags; shadow 574.9, colour 2.1, frame 1.2)
- lite desktop flyover: 436.9 ms at 8.8 s (cpu 435.2, gpu 37.5, no flags; colour 426.9, aoNormal 3.2, shadow 3.0); 433 ms at 6.5 s (cpu 431.5, gpu 38, no flags; colour 423.7, shadow 3.5, aoNormal 2.5); 429.2 ms at 8.2 s (cpu 427.9, gpu 42.3, no flags; colour 420.3, shadow 3.5, aoNormal 2.5); 427.5 ms at 5.3 s (cpu 425.8, gpu 38.6, no flags; colour 417.5, shadow 3.7, aoNormal 3.0); 425.6 ms at 7.7 s (cpu 424.1, gpu 39.2, upload+upload 412 ms; colour 417.9, shadow 2.5, aoNormal 2.0)
- lite phone spot: 672.6 ms at 9 s (cpu 671.6, gpu 0, no flags; shadow 666.4, colour 2.4, aoNormal 1.6); 657.9 ms at 5.6 s (cpu 7, gpu 31.8, no flags; shadow 2.2, colour 1.9, frame 1.2); 650.9 ms at 7.3 s (cpu 649.7, gpu 31.8, no flags; shadow 644.1, colour 2.6, aoNormal 1.4); 649.4 ms at 8.2 s (cpu 647.9, gpu 31.4, no flags; shadow 642.5, colour 2.7, aoNormal 1.4); 642.1 ms at 3.9 s (cpu 640.9, gpu 32.4, no flags; output 635.5, shadow 1.8, colour 1.7)
- lite phone flyover: 387.1 ms at 8.8 s (cpu 385.7, gpu 30.5, upload+upload 375 ms; shadow 379.2, colour 3.3, aoNormal 2.1); 346 ms at 9.5 s (cpu 343.9, gpu 0, no flags; colour 333.2, shadow 4.8, aoNormal 4.2); 320.9 ms at 7.6 s (cpu 318.6, gpu 29.2, no flags; shadow 314.7, colour 1.7, aoNormal 1.5); 307.4 ms at 7.1 s (cpu 306.1, gpu 28.9, no flags; colour 300.7, shadow 2.3, aoNormal 1.7); 293.5 ms at 6.7 s (cpu 292.7, gpu 28.6, no flags; shadow 285.7, aoNormal 3.1, colour 2.7)

## Load and memory (the spot rows' pages; repeat: a second visit in the same browser context)

| tier | view | first frame ms | env build ms | bytes before first frame | files | repeat: first frame ms | repeat: env build ms | repeat: bytes | textures (est. MB) | render targets + shadow (est. MB) | GL textures | programs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | desktop | 3075 | 1244 (build 602.9) | 7.6 MB | 94 | 2710 | 978 (build 629.8) | 1.1 MB | 8.3 | 277.2 | 79 | 68 |
| full | phone | 3149 | 1239 (build 620.4) | 7.6 MB | 94 | 2758 | 1020 (build 657.9) | 1.1 MB | 8.3 | 213.2 | 82 | 68 |
| lite | desktop | 2606 | 930 (build 384.1) | 7.6 MB | 94 | 2606 | 824 (build 458.6) | 1.1 MB | 8.0 | 277.2 | 67 | 49 |
| lite | phone | 2863 | 1019 (build 422.4) | 7.6 MB | 94 | 2378 | 672 (build 385.5) | 1.1 MB | 8.0 | 213.2 | 70 | 49 |
| classic | desktop | 1962 | null (build 0) | 7.5 MB | 88 | 1323 | null (build 0) | 7.4 MB | 7.7 | 0.0 | 28 | 15 |
| classic | phone | 1423 | null (build 0) | 7.5 MB | 88 | 1227 | null (build 0) | 7.4 MB | 7.7 | 0.0 | 38 | 15 |

## The top 5 costs (ranked from the tables above, Full at 1920x1080 unless named)

1. **The see-through's synchronous read-back** (`seethrough.ts` sample(): after 3 async timeouts, or a decision older than 250 ms, it fell back to `readRenderTargetPixels`, which waits for the whole GPU queue). 15 of the 20 frames over 50 ms at the noodle shop, 21 sync reads in 10 s, 884 ms worst (Lite desktop 1346 ms); CPU `syncRead` ~10 ms a frame on average. The recurring "350 ms frames".
2. **GTAO at full resolution**: 17.5 ms GPU at the spot, 16.9 on the fly-over: 54 % of the 32 ms frame (normal / depth pre-pass 0.8-1.3 ms more; the phone rows 11-14 ms). Lite paid it too (17.4 ms): Lite was not cheaper on the GPU (29.6 vs 32.1 ms).
3. **The colour pass at 4x MSAA**: 8.3-9.5 ms GPU; measured by knob, 4x MSAA is ~4 ms of it (`msaa=0`: 5.5 ms) and the grass ~1.6 ms. Two 4x MSAA half-float composer targets plus resolves: 277 MB of render targets at 1080p.
4. **No frame cap, GPU-bound**: uncapped, the GPU queue ran hundreds of ms deep and a random GL call stalled on it: the fly-over's 15 long frames (no sync read there) sit in `cpu: colour / shadow / bloom` at 390-460 ms. (On a vsync-capped browser this is bounded; the fix is to fit the budget and pace.)
5. **The shadow map redrawn every frame**: 2.2 ms GPU at the spot, 3.6 ms on the fly-over, plus ~2.3 ms CPU (every caster traversed; the 14k leaf cards among them). Bloom is next (2.0-2.3 ms GPU at half resolution), then the DPR cap of 2 (a 2.6x phone draws 830x1846: 74 % of a 1080p desktop's pixels through every pass).

Env build: 384-620 ms per visit (textures 110-150 ms, field 210 ms, leaves 200 ms), rebuilt on every visit. Bytes before the first frame: 7.6 MB (94 files).
