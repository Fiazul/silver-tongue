// What the player carries: the parcel of an errand (core state.errand), from layout.json
// `player.errandProp`. Synced from the model after every change, so a save restored mid-errand
// has the parcel in hand again; the carry clips (carry_idle / carry_walk) follow from `carry: true`.
import type * as THREE from "three";
import type { CharacterActor } from "./actor";
import { heldProp, type HeldPropSpec } from "./layout";

export class PlayerCarry {
  private readonly spec: { asset: string; carry: boolean } | undefined;

  constructor(
    private actor: CharacterActor,
    /** the prop instance (one, reused for every errand) */
    private prop: THREE.Object3D | null,
    spec: HeldPropSpec | undefined,
  ) {
    this.spec = heldProp(spec);
  }

  /** Holds the parcel while `errand` is set, puts it down when it isn't. */
  sync(errand: unknown) {
    const want = !!errand && !!this.prop && !!this.spec;
    const has = this.actor.held === this.prop && this.prop !== null;
    if (want && !has) this.actor.hold(this.prop!, { carry: this.spec!.carry });
    else if (!want && has) this.actor.release();
  }

  get holding(): boolean {
    return this.prop !== null && this.actor.held === this.prop;
  }
}
