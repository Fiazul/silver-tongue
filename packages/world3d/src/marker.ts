// The first-steps guide's marker (guide.ts): a floating arrow over its target (an NPC, a door)
// and a ring on the ground under it, in the toon look (the town's banded shading and an ink
// outline: an inverted hull), gold with an ink rim. It bobs and the ring breathes; hidden when the
// step has no target in this space.
import * as THREE from "three";

const GOLD = 0xe8b64c;
const INK = 0x1d1714;
/** the arrow's tip this high over the target's feet (m): above a head */
const HEIGHT = 2.55;

function toon(color: number): THREE.MeshToonMaterial {
  const steps = new Uint8Array([90, 170, 255]);
  const g = new THREE.DataTexture(steps, 3, 1, THREE.RedFormat);
  g.minFilter = g.magFilter = THREE.NearestFilter;
  g.generateMipmaps = false;
  g.needsUpdate = true;
  return new THREE.MeshToonMaterial({ color, gradientMap: g });
}

/** A mesh with its ink hull (back faces, pushed out along the normals). */
function outlined(geo: THREE.BufferGeometry, mat: THREE.Material, width = 0.035): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mat));
  const hull = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { w: { value: width }, c: { value: new THREE.Color(INK) } },
      vertexShader: "uniform float w; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * w, 1.0); }",
      fragmentShader: "uniform vec3 c; void main() { gl_FragColor = vec4(c, 1.0); }",
      side: THREE.BackSide,
    }),
  );
  g.add(hull);
  return g;
}

export class GuideMarker {
  readonly root = new THREE.Group();
  private arrow: THREE.Group;
  private ring: THREE.Group;
  private t = 0;

  constructor() {
    const gold = toon(GOLD);
    // The arrow: a cone pointing down with a short shaft.
    const cone = new THREE.ConeGeometry(0.26, 0.42, 16);
    cone.rotateX(Math.PI);
    const shaft = new THREE.CylinderGeometry(0.1, 0.1, 0.34, 12);
    shaft.translate(0, 0.36, 0);
    this.arrow = new THREE.Group();
    this.arrow.add(outlined(cone, gold), outlined(shaft, gold));
    const ring = new THREE.TorusGeometry(0.62, 0.07, 8, 40);
    ring.rotateX(Math.PI / 2);
    this.ring = outlined(ring, gold, 0.025);
    this.root.add(this.arrow, this.ring);
    this.root.visible = false;
    this.root.renderOrder = 2;
  }

  /** Floats over `at` (the target's feet), or hides (null). */
  update(dt: number, at: THREE.Vector3 | null) {
    this.root.visible = !!at;
    if (!at) return;
    this.t += dt;
    this.root.position.copy(at);
    this.arrow.position.y = HEIGHT + 0.12 * Math.sin(this.t * 3.2);
    this.arrow.rotation.y = this.t * 1.4;
    const k = 1 + 0.08 * Math.sin(this.t * 3.2);
    this.ring.scale.set(k, 1, k);
    this.ring.position.y = 0.05;
  }
}
