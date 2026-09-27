// The fly-over at the start of a new game: town.json's camera path (cubic Hermite on the camera's
// position and look-at point with the stored tangents, fov linear), letterbox bars and a "tap to
// skip" hint. Its last key is the game camera at the spawn (camera.ts CAMERA), so handing over to
// CameraRig.snap there is seamless (test/cutscene.test.ts checks it to 1e-3). Skipped by any tap,
// click or key; never played for a loaded save. The maths (CameraPathPlayer) is pure; Letterbox is
// the DOM part.
import * as THREE from "three";
import { CAMERA } from "./camera";
import type { CameraKey, CameraPath, Vec3 } from "./layout";

export interface CameraPose {
  pos: Vec3;
  lookAt: Vec3;
  fovDeg: number;
}

/** h00 p0 + h10 dt m0 + h01 p1 + h11 dt m1, per axis (town.json camera_path.note). */
function hermite(p0: Vec3, m0: Vec3, p1: Vec3, m1: Vec3, dt: number, s: number): Vec3 {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return [0, 1, 2].map((i) => h00 * p0[i] + h10 * dt * m0[i] + h01 * p1[i] + h11 * dt * m1[i]) as Vec3;
}

/** The camera pose at time `t` (s) along a path: clamped to its first and last key. */
export function poseAt(keys: CameraKey[], t: number): CameraPose {
  if (!keys.length) throw new Error("camera path has no keys");
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.t) return { pos: [...first.pos], lookAt: [...first.lookAt], fovDeg: first.fovDeg };
  if (t >= last.t) return { pos: [...last.pos], lookAt: [...last.lookAt], fovDeg: last.fovDeg };
  let i = 0;
  while (i + 1 < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const dt = b.t - a.t;
  const s = (t - a.t) / dt;
  return {
    pos: hermite(a.pos, a.posTangent, b.pos, b.posTangent, dt, s),
    lookAt: hermite(a.lookAt, a.lookTangent, b.lookAt, b.lookTangent, dt, s),
    fovDeg: a.fovDeg + (b.fovDeg - a.fovDeg) * s,
  };
}

/** Plays a path on a camera: `update(dt)` each frame until it returns true (the end, or skipped). */
export class CameraPathPlayer {
  t = 0;
  done = false;

  constructor(readonly path: CameraPath) {}

  get duration(): number {
    return this.path.keys.at(-1)?.t ?? 0;
  }

  /** The skip: the fly-over is over at once (the game camera takes it from the spawn). */
  skip() {
    this.done = true;
  }

  /**
   * One frame: the pose at the new time on `camera`. `fovScale` is the play fov over CAMERA.fovDeg
   * (a portrait phone widens both alike, so the last key still lands on the game camera).
   */
  update(dt: number, camera: THREE.PerspectiveCamera, fovScale = 1): boolean {
    if (this.done) return true;
    this.t = Math.min(this.duration, this.t + Math.max(0, dt));
    apply(poseAt(this.path.keys, this.t), camera, fovScale);
    if (this.t >= this.duration) this.done = true;
    return this.done;
  }
}

/** Puts a pose on a camera. */
export function apply(p: CameraPose, camera: THREE.PerspectiveCamera, fovScale = 1) {
  camera.position.set(...p.pos);
  camera.lookAt(...p.lookAt);
  const fov = p.fovDeg * fovScale;
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

/**
 * The letterbox: two bars that slide in, and the skip hint. It covers the page while it shows, so
 * the tap that skips reaches nothing else; `onSkip` fires once, on the first tap / click / key.
 * `skippable: false` (promo capture only, main.ts world3d.promo("flyover")): the bars show with no
 * hint and no tap / click / key reaches `onSkip` (a recording tool's stray input mustn't cut the
 * trailer's fly-over short); only `close()` ends it.
 */
export class Letterbox {
  private root: HTMLElement;
  private skipped = false;
  private onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    this.skip();
  };

  constructor(
    parent: HTMLElement,
    hint: string,
    private onSkip: () => void,
    private skippable = true,
  ) {
    this.root = document.createElement("div");
    this.root.className = "letterbox";
    if (this.skippable) {
      this.root.setAttribute("role", "button");
      this.root.setAttribute("aria-label", hint);
    }
    const top = document.createElement("div");
    top.className = "letterbox-bar top";
    const bottom = document.createElement("div");
    bottom.className = "letterbox-bar bottom";
    const tip = document.createElement("div");
    tip.className = "letterbox-hint";
    tip.textContent = hint;
    bottom.append(tip);
    this.root.append(top, bottom);
    if (this.skippable) {
      this.root.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.skip();
      });
      window.addEventListener("keydown", this.onKey, { capture: true });
    } else this.root.style.pointerEvents = "none"; // covers nothing: a promo recording tool's clicks pass through to the canvas
    parent.append(this.root);
    requestAnimationFrame(() => this.root.classList.add("on"));
  }

  private skip() {
    if (this.skipped) return;
    this.skipped = true;
    this.onSkip();
  }

  /** Bars out, then gone. */
  close() {
    this.skipped = true;
    if (this.skippable) window.removeEventListener("keydown", this.onKey, { capture: true });
    this.root.classList.remove("on");
    this.root.style.pointerEvents = "none";
    setTimeout(() => this.root.remove(), 450);
  }
}

/**
 * Promo capture only (main.ts world3d.promo("orbit")): a slow orbit of the game camera round a
 * ground point at the game's own elevation (CAMERA.elevationDeg over CAMERA.aimHeight), one full
 * turn over `seconds`. `update` is called each frame (as CameraPathPlayer's); main.ts drives the
 * camera with it in place of CameraRig.update while it runs, and restores the rig (`rig.snap`) once
 * it reports done.
 */
export class OrbitPath {
  private t = 0;

  constructor(
    private readonly centre: [number, number],
    private readonly radius: number,
    private readonly seconds: number,
  ) {}

  get duration(): number {
    return this.seconds;
  }

  skip() {
    this.t = this.seconds;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): boolean {
    this.t = Math.min(this.seconds, this.t + Math.max(0, dt));
    const angle = (this.t / this.seconds) * Math.PI * 2;
    const el = (CAMERA.elevationDeg * Math.PI) / 180;
    const height = CAMERA.aimHeight + this.radius * Math.tan(el);
    camera.position.set(this.centre[0] + Math.sin(angle) * this.radius, height, this.centre[1] + Math.cos(angle) * this.radius);
    camera.lookAt(this.centre[0], CAMERA.aimHeight, this.centre[1]);
    return this.t >= this.seconds;
  }
}

/**
 * Promo capture only (main.ts world3d.promo("dolly")): a straight, eased camera move from one point
 * to another, looking at a fixed point throughout, over `seconds`. Same calling convention as
 * OrbitPath.
 */
export class DollyPath {
  private t = 0;

  constructor(
    private readonly from: Vec3,
    private readonly to: Vec3,
    private readonly lookAt: Vec3,
    private readonly seconds: number,
  ) {}

  get duration(): number {
    return this.seconds;
  }

  skip() {
    this.t = this.seconds;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): boolean {
    this.t = Math.min(this.seconds, this.t + Math.max(0, dt));
    const s = this.t / this.seconds;
    const e = s * s * (3 - 2 * s); // smoothstep: eased in and out, as the fly-over's own ends
    camera.position.set(...([0, 1, 2].map((i) => this.from[i] + (this.to[i] - this.from[i]) * e) as Vec3));
    camera.lookAt(...this.lookAt);
    return this.t >= this.seconds;
  }
}
