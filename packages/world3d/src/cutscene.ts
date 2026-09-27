// The fly-over at the start of a new game: town.json's camera path (cubic Hermite on the camera's
// position and look-at point with the stored tangents, fov linear), letterbox bars and a "tap to
// skip" hint. Its last key is the game camera at the spawn (camera.ts CAMERA), so handing over to
// CameraRig.snap there is seamless (test/cutscene.test.ts checks it to 1e-3). Skipped by any tap,
// click or key; never played for a loaded save. The maths (CameraPathPlayer) is pure; Letterbox is
// the DOM part.
import * as THREE from "three";
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
  ) {
    this.root = document.createElement("div");
    this.root.className = "letterbox";
    this.root.setAttribute("role", "button");
    this.root.setAttribute("aria-label", hint);
    const top = document.createElement("div");
    top.className = "letterbox-bar top";
    const bottom = document.createElement("div");
    bottom.className = "letterbox-bar bottom";
    const tip = document.createElement("div");
    tip.className = "letterbox-hint";
    tip.textContent = hint;
    bottom.append(tip);
    this.root.append(top, bottom);
    this.root.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.skip();
    });
    parent.append(this.root);
    window.addEventListener("keydown", this.onKey, { capture: true });
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
    window.removeEventListener("keydown", this.onKey, { capture: true });
    this.root.classList.remove("on");
    this.root.style.pointerEvents = "none";
    setTimeout(() => this.root.remove(), 450);
  }
}
