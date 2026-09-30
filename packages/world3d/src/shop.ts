// Shop goods (layout.json `interiors.<id>.goods`): the item the player took off a shelf, in their
// hand until the sale at the counter ends or they put it back, and the walk from the shelf to the
// counter through the aisles. What taking it leads to is core's (game.ts shopItem: the clerk's
// scene with the item picked, their other scenes, or only its word); this module only holds and
// walks. The route is pure (tests walk it); ShopHand touches three.js only through the actor.
import * as THREE from "three";
import type { CharacterActor } from "./actor";
import type { Blocker, Box2, GoodsSpot, HandSpec, LayoutIndex } from "./layout";
import { blocked, PLAYER_RADIUS } from "./movement";
import { buildPathGrid, findPath } from "./wayfind";

type P2 = [number, number];

/** The straight segment a→b keeps `radius` clear of every blocker (sampled every 5 cm). */
function clearLine(a: P2, b: P2, blockers: Blocker[], bounds: Box2, radius: number): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05));
  for (let i = 0; i <= n; i++) if (blocked(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, blockers, bounds, radius)) return false;
  return true;
}

/**
 * The walk from `from` to `to` among `blockers`: A* on a `cell` grid with `radius` clear (the
 * player's by default), pulled tight into the corners to walk to (the last one `to`); null when
 * there is no way. A start or goal inside a blocker snaps to the nearest open cell within 0.5 m.
 */
export function aisleRoute(bounds: Box2, blockers: Blocker[], from: P2, to: P2, radius = PLAYER_RADIUS, cell = 0.1): P2[] | null {
  const grid = buildPathGrid(bounds, cell, () => 1, (x, z) => blocked(x, z, blockers, bounds, radius));
  const path = findPath(grid, from, to, 0.5);
  if (!path) return null;
  const pts: P2[] = [from, ...path.slice(1, -1), to];
  const out: P2[] = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clearLine(pts[i], pts[j], blockers, bounds, radius)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** What `hand` builds from: the asset cache's instances and flat materials, the index's sizes. */
export interface HandAssets {
  instance(name: string): Promise<THREE.Object3D>;
  toon: { flat(colour: string): THREE.Material };
}

/** The item as it sits in the hand: its middle on the grip bone (props/ assets stand on their feet origin), or a plain box. */
export async function handProp(L: LayoutIndex, assets: HandAssets, hand: HandSpec): Promise<THREE.Object3D> {
  const root = new THREE.Group();
  root.name = "shop_item";
  if ("box" in hand) {
    const [w, h, d] = hand.box;
    root.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), assets.toon.flat(hand.colour)));
    return root;
  }
  const o = await assets.instance(hand.asset);
  o.position.y = -L.asset(hand.asset).size_m[1] / 2;
  root.add(o);
  return root;
}

/**
 * The item in the player's hand (their right grip), one at a time. Taking another puts the first
 * back; a hand already holding something else (an errand's parcel) takes nothing, but the item is
 * still the one being bought (`spot`).
 */
export class ShopHand {
  /** the product taken (null: nothing) */
  spot: GoodsSpot | null = null;
  private prop: THREE.Object3D | null = null;
  private seq = 0;

  constructor(
    private actor: CharacterActor,
    private make: (hand: HandSpec) => Promise<THREE.Object3D>,
  ) {}

  /** Takes `spot`'s item. Resolves true once it is in the hand (false: the hand is busy, or it was put back meanwhile). */
  async take(spot: GoodsSpot): Promise<boolean> {
    this.putBack();
    this.spot = spot;
    if (this.actor.held) return false;
    const token = ++this.seq;
    const prop = await this.make(spot.hand);
    if (token !== this.seq || this.actor.held) return false;
    this.actor.hold(prop);
    this.prop = prop;
    return true;
  }

  /** Back on the shelf (the sale is over, the player put it back or left the shop). */
  putBack() {
    this.seq++;
    if (this.prop && this.actor.held === this.prop) this.actor.release();
    this.prop = null;
    this.spot = null;
  }

  /** the item is on the grip bone now */
  get inHand(): boolean {
    return !!this.prop && this.actor.held === this.prop;
  }
}
