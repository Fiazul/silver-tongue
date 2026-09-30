// The player character: click/tap-to-walk (straight line, sliding along blockers) and the held
// movement vector (WASD / arrows / the touch joystick, input.ts), facing the way it moves. Its
// CharacterActor plays idle / walk from the ground speed (or bobs when the GLB has no clips). In a
// scene the player stays on idle.
import * as THREE from "three";
import type { CharacterActor } from "./actor";
import { turnToward } from "./anim";
import type { Blocker, Box2 } from "./layout";
import { step, WALK_SPEED, type WalkableFn } from "./movement";

/** Where the player walks: the current scene space's bounds, blockers, walkable ground (the town's grid and decks) and walking height. */
export interface WalkArea {
  bounds: Box2;
  blockers: Blocker[];
  walkable?: WalkableFn;
  heightAt(x: number, z: number): number;
}

const ARRIVE = 0.08; // m
const TURN_RATE = 12; // 1/s, facing easing

export class Player {
  /** moves and turns; the actor's body inside it animates */
  readonly root: THREE.Group;
  private target: { x: number; z: number; face?: THREE.Vector3; arrive?: () => void } | null = null;
  private yaw = 0;
  /** input off (in a scene); scripted walks (to the talk stand) still run */
  locked = false;

  constructor(
    readonly actor: CharacterActor,
    public area: WalkArea,
  ) {
    this.root = actor.root;
  }

  get position(): THREE.Vector3 {
    return this.root.position;
  }

  place(x: number, z: number, face?: THREE.Vector3) {
    this.root.position.set(x, this.area.heightAt(x, z), z);
    if (face) this.yaw = Math.atan2(face.x, face.z);
    this.root.rotation.y = this.yaw;
    this.target = null;
  }

  /** Walk to (x, z) in a straight line; `face` turns the player on arrival, `arrive` is called then. */
  walkTo(x: number, z: number, opts: { face?: THREE.Vector3; arrive?: () => void; scripted?: boolean } = {}) {
    if (this.locked && !opts.scripted) return;
    this.target = { x, z, face: opts.face, arrive: opts.arrive };
  }

  stop() {
    this.target = null;
  }

  /** `dir`: the held movement (keys / joystick, input.ts) in world x/z, length 0..1 (a half-pushed stick walks at half speed). */
  update(dt: number, dir: THREE.Vector2) {
    const p = this.root.position;
    const { bounds, blockers, walkable } = this.area;
    let dx = 0;
    let dz = 0;
    let dist = WALK_SPEED * dt;
    const held = dir.length();
    if (!this.locked && held > 0) {
      this.target = null; // keys / the joystick take over from a tap
      dx = dir.x / held;
      dz = dir.y / held;
      dist *= Math.min(1, held);
    } else if (this.target) {
      const tx = this.target.x - p.x;
      const tz = this.target.z - p.z;
      const len = Math.hypot(tx, tz);
      if (len < ARRIVE) {
        const t = this.target;
        this.target = null;
        if (t.face) this.yaw = Math.atan2(t.face.x, t.face.z);
        t.arrive?.();
      } else {
        dx = tx / len;
        dz = tz / len;
        dist = Math.min(dist, len);
      }
    }
    let speed = 0;
    if (dx || dz) {
      const [nx, nz] = step(p.x, p.z, dx, dz, dist, blockers, bounds, walkable);
      const moved = Math.hypot(nx - p.x, nz - p.z);
      if (moved < 1e-5 && this.target) this.target = null; // stuck against something: give up the walk
      speed = dt > 0 ? moved / dt : 0;
      p.x = nx;
      p.z = nz;
      if (moved > 1e-5) this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), TURN_RATE * dt);
    }
    p.y += (this.area.heightAt(p.x, p.z) - p.y) * Math.min(1, dt * 15); // ease up/down slopes, steps and decks
    this.root.rotation.y = turnToward(this.root.rotation.y, this.yaw, TURN_RATE * dt);
    this.actor.update(dt, speed);
  }

  /** Turn (smoothly, in update) to look at world point (x, z): the NPC during a scene. */
  faceToward(x: number, z: number) {
    const p = this.root.position;
    if (Math.hypot(x - p.x, z - p.z) > 1e-3) this.yaw = Math.atan2(x - p.x, z - p.z);
  }

  get walking(): boolean {
    return this.target !== null;
  }
}
