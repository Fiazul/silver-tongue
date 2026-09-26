// The camera: fixed high three-quarter view (the owner's design; the mock-up renders use the same
// angles, tools/blender/lib/sheet.py ELEVATION / AZIMUTH), following the player with damping and
// closing in on player + NPC during a scene. Jamil's spec asks for orbit: set CAMERA.mode to
// "orbit" (the one-line switch) to let the player drag the view round.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export const CAMERA = {
  mode: "fixed" as "fixed" | "orbit",
  elevationDeg: 42,
  azimuthDeg: 36,
  distance: 19,
  fovDeg: 30,
  /** distance multiplier while a scene runs */
  sceneZoom: 0.6,
  /** the same on a portrait phone: pulled back so player, NPC and the bubble fit above the reply sheet */
  sceneZoomPortrait: 0.78,
  /** portrait phone in a scene: shift the picture up by this fraction of the height (the reply sheet covers the bottom) */
  sceneLiftPortrait: 0.16,
  /** follow damping, 1/s */
  follow: 3.5,
  /** aim this far above the feet */
  aimHeight: 1.0,
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private aim = new THREE.Vector3();
  private dist = CAMERA.distance;
  /** this space's follow distance (interiors frame the room closer) */
  private base = CAMERA.distance;
  private portrait = false;
  /** a phone (ui/viewport.ts isCompact) */
  private compact = false;
  private size = { w: 1, h: 1 };
  /** current view lift (fraction of the height), eased */
  private lift = 0;
  private offsetDir: THREE.Vector3;
  private controls?: OrbitControls;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fovDeg, 1, 0.5, 400);
    const el = (CAMERA.elevationDeg * Math.PI) / 180;
    const az = (CAMERA.azimuthDeg * Math.PI) / 180;
    // The camera sits in front (+z) and to the right (+x) of what it looks at, looking down.
    this.offsetDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    if (CAMERA.mode === "orbit") {
      this.controls = new OrbitControls(this.camera, dom);
      this.controls.enablePan = false;
      this.controls.maxPolarAngle = Math.PI * 0.45;
    }
  }

  /** Screen-space walking axes on the ground: [right, up-the-screen] as x/z unit vectors. */
  groundAxes(): { right: THREE.Vector2; up: THREE.Vector2 } {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    const up = new THREE.Vector2(f.x, f.z).normalize();
    return { right: new THREE.Vector2(-up.y, up.x), up };
  }

  resize(w: number, h: number, compact = false) {
    this.size = { w, h };
    this.compact = compact;
    this.camera.aspect = w / Math.max(1, h);
    // Portrait phones: widen the view so the street still fits across.
    this.portrait = this.camera.aspect < 1;
    this.camera.fov = this.portrait ? CAMERA.fovDeg / Math.max(0.55, this.camera.aspect) : CAMERA.fovDeg;
    this.camera.updateProjectionMatrix();
  }

  /** The follow distance for the current space (layout `camera.distance`), or the street's. */
  setDistance(d: number | undefined) {
    this.base = d ?? CAMERA.distance;
  }

  snap(focus: THREE.Vector3) {
    this.dist = this.base;
    this.aim.copy(focus).setY(focus.y + CAMERA.aimHeight);
    this.camera.position.copy(this.aim).addScaledVector(this.offsetDir, this.dist);
    this.camera.lookAt(this.aim);
    if (this.controls) {
      this.controls.target.copy(this.aim);
      this.controls.update();
    }
  }

  /** `focus`: the player, or the midpoint of player and NPC during a scene. */
  update(dt: number, focus: THREE.Vector3, inScene: boolean) {
    const k = 1 - Math.exp(-CAMERA.follow * dt);
    this.aim.lerp(new THREE.Vector3(focus.x, focus.y + CAMERA.aimHeight, focus.z), k);
    // Interiors (a short base distance) on a portrait phone: pull back a little so the room's width fits.
    const fit = this.portrait && this.base < CAMERA.distance ? 1.25 : 1;
    const phonePortrait = this.portrait && this.compact;
    const want = this.base * fit * (inScene ? (phonePortrait ? CAMERA.sceneZoomPortrait : CAMERA.sceneZoom) : 1);
    this.dist += (want - this.dist) * k;
    this.lift += ((inScene && phonePortrait ? CAMERA.sceneLiftPortrait : 0) - this.lift) * k;
    const { w, h } = this.size;
    if (this.lift > 1e-3) this.camera.setViewOffset(w, h, 0, this.lift * h, w, h);
    else if (this.camera.view) this.camera.clearViewOffset();
    this.apply();
  }

  private apply() {
    if (this.controls) {
      // Orbit: keep the player's chosen angle, move the pivot with the player.
      const delta = this.aim.clone().sub(this.controls.target);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      this.controls.update();
      return;
    }
    this.camera.position.copy(this.aim).addScaledVector(this.offsetDir, this.dist);
    this.camera.lookAt(this.aim);
  }
}

/** Outline width multiplier: 1 on a desktop; a phone draws it thicker, more so on denser screens (pixel ratio capped at 2, as the renderer's). */
export function outlineScale(devicePixelRatio: number, compact: boolean): number {
  return compact ? 1 + 0.3 * Math.min(2, Math.max(1, devicePixelRatio)) : 1;
}
