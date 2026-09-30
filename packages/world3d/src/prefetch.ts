// Prefetch (README "Prefetch"): the next spaces built and their shaders compiled while the player is
// busy with something else (a dialogue, the fly-over, the notebook / a menu, the sleep's day card,
// the title and loading screens). Pure (no three.js, no DOM): main.ts owns the host (what a space's
// build is, how one is dropped) and calls frame() once per animation frame.
//
// - TimeSlicer: the gate a build awaits between its steps. A step runs at once while the frame's
//   slice has budget left (sliceMs, 4 ms: the step's cost estimated from the longest one before it),
//   else at the next slice. The first step of a slice always runs (a step that alone is longer than
//   the slice still makes progress). wait(p) takes an async wait (a fetch, a compile) off the budget.
//   rush(): every gate opens at once (the player walked through the door: finish now).
// - PrefetchScheduler: one space at a time, the most wanted first (the guide's space, then the doors
//   from here, nearest first: rankCandidates); slices only while the player is busy and the frame
//   has slack; paused (the build waits at its next gate) as soon as they aren't, resumed later; at
//   most maxPrebuilt spaces built ahead and not yet entered, the least recently wanted dropped first.

/** The frame's slice (ms of prefetch work in one animation frame) */
export const PREFETCH_SLICE_MS = 4;
/** Spaces built ahead and not yet entered, at most */
export const PREFETCH_MAX = 2;

/** `?prefetch=0` turns the prefetcher off (the old path: every interior built at idle after the first frame). */
export function prefetchEnabled(search: string): boolean {
  return new URLSearchParams(search).get("prefetch") !== "0";
}

/** What a build awaits between steps (world.ts SceneSpace.create's `gate`, main.ts's warm-up). */
export interface Gate {
  /** ends the step running now; resolves when the next one may run */
  step(): Promise<void>;
  /** an async wait (a fetch, a driver compile): off the budget; resolves with `p` at the next step's turn */
  wait<T>(p: Promise<T>): Promise<T>;
}

export class TimeSlicer implements Gate {
  /** ms of work granted in slices so far (the sync steps' own time) */
  spent = 0;
  /** the longest step seen (the next step's estimate) */
  estimate = 0;
  /** the steps run, and the longest (a step alone over the slice: one driver compile, one warm frame) */
  steps = 0;
  maxStep = 0;
  private sliceStart = -Infinity;
  private segStart: number | null = null;
  private queue: (() => void)[] = [];
  private rushed = false;

  constructor(
    private readonly now: () => number,
    readonly budgetMs = PREFETCH_SLICE_MS,
  ) {}

  /** a slice starts now (the frame loop, when the player is busy and the frame has slack): the first queued step runs */
  beginSlice() {
    this.sliceStart = this.now();
    const next = this.queue.shift();
    if (next) this.grant(next);
  }

  /** every gate open from now on (the space is needed now) */
  rush() {
    this.rushed = true;
    for (const f of this.queue.splice(0)) this.grant(f);
  }

  get isRushed(): boolean {
    return this.rushed;
  }

  /** whether a step is waiting for the next slice */
  get waiting(): boolean {
    return this.queue.length > 0;
  }

  step(): Promise<void> {
    this.endSegment();
    return new Promise<void>((resolve) => {
      const t = this.now();
      if (this.rushed || t - this.sliceStart + this.estimate <= this.budgetMs) this.grant(resolve);
      else this.queue.push(resolve);
    });
  }

  async wait<T>(p: Promise<T>): Promise<T> {
    this.endSegment();
    const v = await p;
    await this.step();
    return v;
  }

  private grant(resolve: () => void) {
    this.segStart = this.now();
    this.steps++;
    resolve();
  }

  private endSegment() {
    if (this.segStart === null) return;
    const ms = this.now() - this.segStart;
    this.segStart = null;
    this.spent += ms;
    this.maxStep = Math.max(this.maxStep, ms);
    // the estimate follows the steps: the longest recent one, decaying
    this.estimate = Math.max(ms, this.estimate * 0.5);
  }
}

/**
 * The spaces to build ahead, most wanted first: the guide's space, then the ones reachable from
 * here (`reachable`, already nearest first), never the current one; each once.
 */
export function rankCandidates(current: string, guide: string | null, reachable: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of [guide, ...reachable]) if (s && s !== current && !out.includes(s)) out.push(s);
  return out;
}

/**
 * The spaces a space's doors and ways out lead to (layout.ts Trigger: its place, where it stands),
 * nearest to the player (x, z) first, each once, never `here`.
 */
export function reachableFrom(triggers: readonly { place: string; at: readonly number[] }[], spaceOf: (place: string) => string, here: string, x: number, z: number): string[] {
  const best = new Map<string, number>();
  for (const t of triggers) {
    const s = spaceOf(t.place);
    if (s === here) continue;
    const d = Math.hypot(t.at[0] - x, t.at[2] - z);
    if (!(best.get(s)! <= d)) best.set(s, d);
  }
  return [...best].sort((a, b) => a[1] - b[1]).map(([s]) => s);
}

export interface PrefetchHost {
  /** the spaces worth building ahead, most wanted first (rankCandidates) */
  candidates(): string[];
  /** whether a space is built already (entered, or built ahead) */
  built(space: string): boolean;
  /** builds a space and warms it (textures, shaders, one frame), awaiting `gate` between steps */
  build(space: string, gate: TimeSlicer): Promise<void>;
  /** drops a space built ahead (its GPU resources disposed) */
  evict(space: string): void;
}

export type PrefetchState = "off" | "idle" | "working" | "paused";

export interface PrefetchStats {
  state: PrefetchState;
  /** the space being built, null: none */
  space: string | null;
  /** ms of prefetch work so far (every slice's steps) */
  ms: number;
  /** built ahead and not yet entered, least recently wanted first */
  prebuilt: string[];
  /** the longest single step so far (ms) */
  maxStep: number;
  /** builds finished / evicted / failed */
  done: number;
  evicted: number;
  failed: string[];
}

export class PrefetchScheduler {
  /** built ahead, not yet entered: least recently wanted first */
  readonly prebuilt: string[] = [];
  private job: { space: string; slicer: TimeSlicer; promise: Promise<void> } | null = null;
  private busy = false;
  private msDone = 0;
  private maxStep = 0;
  private done = 0;
  private evicted = 0;
  private readonly failed = new Set<string>();

  constructor(
    private readonly host: PrefetchHost,
    private readonly opts: { enabled: boolean; now: () => number; max?: number; sliceMs?: number },
  ) {}

  get max(): number {
    return this.opts.max ?? PREFETCH_MAX;
  }

  /** the player is busy (a dialogue, a cutscene, the notebook, the sleep, the title) or not */
  setBusy(busy: boolean) {
    this.busy = busy;
  }

  /**
   * Once per animation frame. `slack`: the frame has room for a slice. Busy with slack: a slice of
   * the current build (a new one started when none is running); otherwise nothing runs (the build
   * waits at its next gate).
   */
  frame(slack: boolean) {
    if (!this.opts.enabled || !this.busy || !slack) return;
    if (!this.job) this.startNext();
    this.job?.slicer.beginSlice();
  }

  /** The player went into `space`: it is theirs now (never evicted); a build of it in flight finishes at once. */
  entered(space: string) {
    const i = this.prebuilt.indexOf(space);
    if (i >= 0) this.prebuilt.splice(i, 1);
    this.rush(space);
  }

  /** a build of `space` in flight: every gate open (the door needs it now) */
  rush(space: string) {
    if (this.job?.space === space) this.job.slicer.rush();
  }

  /** a stall (boot.ts StartWatch) dropped the builds in flight: forget ours (the next slice starts over) */
  reset() {
    this.job = null;
  }

  get state(): PrefetchState {
    if (!this.opts.enabled) return "off";
    if (!this.job) return "idle";
    return this.busy || this.job.slicer.isRushed ? "working" : "paused";
  }

  get stats(): PrefetchStats {
    return {
      state: this.state,
      space: this.job?.space ?? null,
      ms: +(this.msDone + (this.job?.slicer.spent ?? 0)).toFixed(1),
      maxStep: +Math.max(this.maxStep, this.job?.slicer.maxStep ?? 0).toFixed(1),
      prebuilt: [...this.prebuilt],
      done: this.done,
      evicted: this.evicted,
      failed: [...this.failed],
    };
  }

  /** the next wanted space not built: its build starts (a space built ahead but no longer wanted is dropped first when the cap is reached) */
  private startNext() {
    const wanted = this.host.candidates().slice(0, this.max);
    // the wanted ones built ahead are used again: most recent last
    for (const s of [...wanted].reverse()) {
      const i = this.prebuilt.indexOf(s);
      if (i >= 0) this.prebuilt.push(...this.prebuilt.splice(i, 1));
    }
    const next = wanted.find((s) => !this.host.built(s) && !this.failed.has(s));
    if (!next) return;
    while (this.prebuilt.length >= this.max) {
      const lru = this.prebuilt.find((s) => !wanted.includes(s)) ?? this.prebuilt[0];
      this.prebuilt.splice(this.prebuilt.indexOf(lru), 1);
      this.host.evict(lru);
      this.evicted++;
    }
    const slicer = new TimeSlicer(this.opts.now, this.opts.sliceMs ?? PREFETCH_SLICE_MS);
    const job = { space: next, slicer, promise: Promise.resolve() };
    job.promise = (async () => {
      await slicer.step(); // the first step waits for its slice too
      await this.host.build(next, slicer);
    })().then(
      () => {
        if (this.job !== job) return; // reset() meanwhile
        this.job = null;
        this.msDone += slicer.spent;
        this.maxStep = Math.max(this.maxStep, slicer.maxStep);
        this.done++;
        // entered while it was built (rushed): the player's now, not a build ahead
        if (!slicer.isRushed && this.host.built(next) && !this.prebuilt.includes(next)) this.prebuilt.push(next);
      },
      () => {
        if (this.job !== job) return;
        this.job = null;
        this.msDone += slicer.spent;
        this.maxStep = Math.max(this.maxStep, slicer.maxStep);
        this.failed.add(next);
      },
    );
    this.job = job;
  }
}

/**
 * Whether a frame has room for a slice: the last interval between frames wasn't over `late` x the
 * frame's budget (a frame already late: the page is behind, no extra work that frame). The slice
 * itself is small against a frame (PREFETCH_SLICE_MS); only busy frames get one.
 */
export function frameSlack(intervalMs: number, targetMs: number, late = 2): boolean {
  return intervalMs <= targetMs * late;
}
