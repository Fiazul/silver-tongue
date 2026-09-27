// Street life motion, pure x/z maths (the actors that show it live in world.ts): walkers pacing
// waypoint paths there and back, stopping to wait while the player is in their way, and
// scatterers (pigeons) that dart away when the player comes within SCATTER_RANGE and drift home.
import type { Vec2 } from "./layout";

/** A walker stops while the player is this close (m) and roughly ahead. */
export const WAIT_RANGE = 1.3;
export const SCATTER_RANGE = 2;
const SCATTER_SPEED = 2.6; // m/s
const HOME_SPEED = 0.5; // m/s
const SCATTER_MAX = 3.5; // m from home at most
const SETTLE = 2.5; // s before drifting home

/** Turns `m` to face (px, pz) (yaw as atan2(dx, dz)); a player on top of it leaves the yaw as it is. */
function faceFrom(m: { x: number; z: number; yaw: number }, px: number, pz: number) {
  const dx = px - m.x;
  const dz = pz - m.z;
  if (Math.hypot(dx, dz) > 1e-3) m.yaw = Math.atan2(dx, dz);
}

export class WalkerMotion {
  x: number;
  z: number;
  /** facing (radians, atan2(dx, dz)) */
  yaw = 0;
  waiting = false;
  /** talked to (a bark, main.ts): stands still facing the player until let go, then walks on */
  held = false;
  private next = 1;
  private dir = 1;

  constructor(
    readonly path: Vec2[],
    readonly speed = 1.1,
  ) {
    [this.x, this.z] = path[0];
    if (path.length > 1) this.yaw = Math.atan2(path[1][0] - path[0][0], path[1][1] - path[0][1]);
  }

  /** One frame; returns the ground speed (m/s) for the walk clip. */
  update(dt: number, px: number, pz: number): number {
    if (this.held) {
      this.waiting = true;
      faceFrom(this, px, pz);
      return 0;
    }
    if (this.path.length < 2 || dt <= 0) return 0;
    const [tx, tz] = this.path[this.next];
    const dx = tx - this.x;
    const dz = tz - this.z;
    const len = Math.hypot(dx, dz);
    const ux = len > 1e-6 ? dx / len : 0;
    const uz = len > 1e-6 ? dz / len : 0;
    // Stop and wait while the player stands in the way (close, and in front).
    const ox = px - this.x;
    const oz = pz - this.z;
    const od = Math.hypot(ox, oz);
    this.waiting = od < WAIT_RANGE && (od < 0.4 || (ox * ux + oz * uz) / od > 0.2);
    if (this.waiting) return 0;
    const step = Math.min(len, this.speed * dt);
    this.x += ux * step;
    this.z += uz * step;
    if (len > 1e-6) this.yaw = Math.atan2(ux, uz);
    if (len - step < 0.05) {
      // There and back: turn round at either end.
      if (this.next + this.dir < 0 || this.next + this.dir >= this.path.length) this.dir = -this.dir;
      this.next += this.dir;
    }
    return step / dt;
  }
}

export class ScatterMotion {
  x: number;
  z: number;
  yaw: number;
  /** talked to (a bark): stays put facing the player */
  held = false;
  private settle = 0;

  constructor(
    readonly home: Vec2,
    yaw = 0,
  ) {
    [this.x, this.z] = home;
    this.yaw = yaw;
  }

  /** One frame; returns the ground speed (m/s). */
  update(dt: number, px: number, pz: number): number {
    if (this.held) {
      faceFrom(this, px, pz);
      return 0;
    }
    const ox = this.x - px;
    const oz = this.z - pz;
    const od = Math.hypot(ox, oz);
    let vx = 0;
    let vz = 0;
    if (od < SCATTER_RANGE) {
      // Away from the player, but never too far from home.
      vx = od > 1e-6 ? ox / od : 1;
      vz = od > 1e-6 ? oz / od : 0;
      const hx = this.x + vx * 0.3 - this.home[0];
      const hz = this.z + vz * 0.3 - this.home[1];
      if (Math.hypot(hx, hz) > SCATTER_MAX) [vx, vz] = [-vz, vx]; // sidestep along the leash instead
      vx *= SCATTER_SPEED;
      vz *= SCATTER_SPEED;
      this.settle = SETTLE;
    } else {
      this.settle = Math.max(0, this.settle - dt);
      const hx = this.home[0] - this.x;
      const hz = this.home[1] - this.z;
      const hd = Math.hypot(hx, hz);
      if (this.settle === 0 && hd > 0.05) {
        // Only while the player is well away from home.
        const back = Math.hypot(this.home[0] - px, this.home[1] - pz) > SCATTER_RANGE + 0.5;
        if (back) {
          vx = (hx / hd) * Math.min(HOME_SPEED, hd / Math.max(dt, 1e-3));
          vz = (hz / hd) * Math.min(HOME_SPEED, hd / Math.max(dt, 1e-3));
        }
      }
    }
    this.x += vx * dt;
    this.z += vz * dt;
    const speed = Math.hypot(vx, vz);
    if (speed > 1e-3) this.yaw = Math.atan2(vx, vz);
    return speed;
  }

  get away(): number {
    return Math.hypot(this.x - this.home[0], this.z - this.home[1]);
  }
}
