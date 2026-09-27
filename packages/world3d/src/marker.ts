// The objective's marker (guide.ts, wayfind.ts): a floating arrow over its target (an NPC, a door,
// the bed) and a ring on the ground under it, in the toon look (the town's banded shading and an
// ink outline: an inverted hull), gold with an ink rim. It bobs and the ring breathes; hidden when
// there is no target in this space. Arrow and ring are one geometry (a `part` attribute tells
// them apart; the bob and the breath are uniforms): two draw calls, the body and its hull.
// `ping()` (the objective card's "Take me there"): a short bigger pulse, to catch the eye.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const GOLD = 0xe8b64c;
const INK = 0x1d1714;
/** the arrow's tip this high over the target's feet (m): above a head */
const HEIGHT = 2.55;
const PING_S = 1.2;

/** part 0: the ring (breathes in x/z); part 1: the arrow (rides up and down). */
const PART_GLSL = /* glsl */ `
attribute float part;
uniform float uArrowY;
uniform float uRing;
vec3 markerPart(vec3 p) {
  if (part > 0.5) p.y += uArrowY; else p.xz *= uRing;
  return p;
}
`;

function toon(color: number, uniforms: Record<string, THREE.IUniform>): THREE.MeshToonMaterial {
  const steps = new Uint8Array([90, 170, 255]);
  const g = new THREE.DataTexture(steps, 3, 1, THREE.RedFormat);
  g.minFilter = g.magFilter = THREE.NearestFilter;
  g.generateMipmaps = false;
  g.needsUpdate = true;
  const m = new THREE.MeshToonMaterial({ color, gradientMap: g });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = PART_GLSL + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed = markerPart(transformed);");
  };
  m.customProgramCacheKey = () => "objective-marker";
  return m;
}

const withPart = (geo: THREE.BufferGeometry, part: number) => {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.setAttribute("part", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(part), 1));
  return g;
};

export class GuideMarker {
  readonly root = new THREE.Group();
  private t = 0;
  private ping = 0;
  private uniforms = { uArrowY: { value: HEIGHT }, uRing: { value: 1 } };

  constructor() {
    // The arrow: a cone pointing down with a short shaft; the ring round the target's feet.
    const cone = new THREE.ConeGeometry(0.26, 0.42, 16);
    cone.rotateX(Math.PI);
    const shaft = new THREE.CylinderGeometry(0.1, 0.1, 0.34, 12);
    shaft.translate(0, 0.36, 0);
    const ring = new THREE.TorusGeometry(0.62, 0.07, 8, 40);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.05, 0);
    const geo = mergeGeometries([withPart(cone, 1), withPart(shaft, 1), withPart(ring, 0)])!;
    const body = new THREE.Mesh(geo, toon(GOLD, this.uniforms));
    const hull = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, c: { value: new THREE.Color(INK) } },
        vertexShader:
          PART_GLSL +
          "void main() { float w = part > 0.5 ? 0.035 : 0.025; gl_Position = projectionMatrix * modelViewMatrix * vec4(markerPart(position + normal * w), 1.0); }",
        fragmentShader: "uniform vec3 c; void main() { gl_FragColor = vec4(c, 1.0); }",
        side: THREE.BackSide,
      }),
    );
    for (const m of [body, hull]) m.frustumCulled = false; // the arrow rides above the geometry's bounds
    this.root.add(body, hull);
    this.root.visible = false;
    this.root.renderOrder = 2;
  }

  /** Floats over `at` (the target's feet), or hides (null). */
  update(dt: number, at: THREE.Vector3 | null) {
    this.root.visible = !!at;
    this.ping = Math.max(0, this.ping - dt);
    if (!at) return;
    this.t += dt;
    this.root.position.copy(at);
    const p = this.ping > 0 ? Math.sin((this.ping / PING_S) * Math.PI) : 0; // 0 → 1 → 0 over the ping
    this.uniforms.uArrowY.value = HEIGHT + 0.12 * Math.sin(this.t * 3.2) + 0.5 * p;
    this.uniforms.uRing.value = (1 + 0.08 * Math.sin(this.t * 3.2)) * (1 + 0.6 * p);
    this.root.scale.setScalar(1 + 0.35 * p);
  }

  /** A short bigger pulse (the objective card's "Take me there"). */
  pulse() {
    this.ping = PING_S;
  }
}
