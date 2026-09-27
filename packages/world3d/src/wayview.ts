// Wayfinding's views (wayfind.ts has the maths): the ground path hint (breadcrumb dots on the
// ground, one merged mesh: one draw call), the screen-edge arrow (a DOM element moved by transform
// only: no layout reads per frame) and each space's walk grid for the A* (built once per space).
import * as THREE from "three";
import { gridClass, deckAt, LAYOUT, STREET, type Blocker, type Box2 } from "./layout";
import { blocked } from "./movement";
import { el } from "./ui/dom";
import { breadcrumbs, buildPathGrid, CLASS_COST, type EdgeArrow, type PathGrid } from "./wayfind";

/** the most dots drawn (at SPACING m: the path's first ~50 m) */
const MAX_DOTS = 64;
const SPACING = 0.8;
const DOT_R = 0.13;
/** dots fade out between these distances along the path (m) */
const FADE_FROM = 14;
const FADE_TO = 40;

/**
 * A space's walk grid for the path: the town's 1 m grid (classes 1..5 with their costs, decks as
 * bridge), an interior's floor at 0.4 m; blockers (the town's rects, pieces, NPC stands) out,
 * tested at a small radius so narrow lanes stay open.
 */
export function spaceGrid(space: { id: string; blockers: Blocker[]; layout: { bounds: Box2 } }): PathGrid {
  const bounds = space.layout.bounds;
  const hit = (x: number, z: number) => blocked(x, z, space.blockers, bounds, 0.15);
  if (space.id !== STREET) return buildPathGrid(bounds, 0.4, () => 1, hit);
  const t = LAYOUT.town;
  const g = t.grid;
  const box: Box2 = { min: [g.x0, g.z0], max: [g.x0 + g.cols * g.cell, g.z0 + g.rows * g.cell] };
  return buildPathGrid(
    box,
    g.cell,
    (x, z) => {
      if (deckAt(t.decks, x, z)) return CLASS_COST[5];
      return CLASS_COST[gridClass(g, x, z)] ?? 0;
    },
    hit,
  );
}

/** Breadcrumb dots along a path on the ground, fading with distance; one mesh, `set` rewrites its buffers. */
export class PathTrail {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private alpha: THREE.BufferAttribute;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(MAX_DOTS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(new Float32Array(MAX_DOTS * 4), 1).setUsage(THREE.DynamicDrawUsage);
    const corner = new Float32Array(MAX_DOTS * 4 * 2);
    const index: number[] = [];
    for (let k = 0; k < MAX_DOTS; k++) {
      corner.set([-1, -1, 1, -1, 1, 1, -1, 1], k * 8);
      const b = k * 4;
      index.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    geo.setAttribute("position", this.pos);
    geo.setAttribute("alpha", this.alpha);
    geo.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0xfbf3e2) }, rim: { value: new THREE.Color(0xe8b64c) } },
      vertexShader: /* glsl */ `
        attribute float alpha; attribute vec2 corner;
        varying float vA; varying vec2 vC;
        void main() { vA = alpha; vC = corner; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color; uniform vec3 rim;
        varying float vA; varying vec2 vC;
        void main() {
          float r = length(vC);
          if (r > 1.0) discard;
          vec3 c = mix(color, rim, smoothstep(0.55, 0.75, r));
          gl_FragColor = vec4(c, vA * (1.0 - smoothstep(0.85, 1.0, r)));
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; // the buffers change every rebuild; the dots are few
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /** Dots along `path` (x/z), on the ground under each (`heightAt`); null or too short: hidden. */
  set(path: [number, number][] | null, heightAt: (x: number, z: number) => number) {
    const dots = path ? breadcrumbs(path, SPACING).slice(0, MAX_DOTS) : [];
    const p = this.pos.array as Float32Array;
    const a = this.alpha.array as Float32Array;
    dots.forEach((d, k) => {
      const y = heightAt(d.x, d.z) + 0.05;
      const fade = 1 - THREE.MathUtils.smoothstep(d.d, FADE_FROM, FADE_TO);
      const alpha = 0.85 * fade * Math.min(1, d.d / 1.6);
      for (let c = 0; c < 4; c++) {
        const [cx, cz] = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ][c];
        p.set([d.x + cx * DOT_R, y, d.z + cz * DOT_R], (k * 4 + c) * 3);
        a[k * 4 + c] = alpha;
      }
    });
    this.pos.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, dots.length * 6);
    this.mesh.visible = dots.length > 0;
  }

  hide() {
    this.mesh.visible = false;
  }
}

/** The screen-edge arrow: a gold badge pointing at an off-screen target, with its name and distance. */
export class EdgeArrowView {
  readonly node = el("div", { className: "way-edge hidden" });
  private arrow = el("span", { className: "way-edge-arrow" });
  private label = el("span", { className: "way-edge-label" });
  private text = "";
  private shown = false;

  constructor() {
    this.node.setAttribute("aria-hidden", "true");
    this.node.append(this.arrow, this.label);
  }

  /** At the arrow's spot, pointing along its angle; null or on screen: hidden. */
  update(a: EdgeArrow | null, text: string) {
    const show = !!a && !a.onScreen;
    if (show !== this.shown) {
      this.shown = show;
      this.node.classList.toggle("hidden", !show);
    }
    if (!show) return;
    if (text !== this.text) {
      this.text = text;
      this.label.textContent = text;
    }
    this.node.style.transform = `translate3d(${a!.x.toFixed(1)}px, ${a!.y.toFixed(1)}px, 0)`;
    this.arrow.style.transform = `rotate(${a!.angle.toFixed(3)}rad)`;
  }
}
