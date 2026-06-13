import * as THREE from "three";
import { FLIGHT_COLORS, ROLE_COLORS } from "../theme.ts";
import type { FxKind } from "./types.ts";

/** A transient one-shot effect. Returns false from update() when finished. */
export interface Fx {
  readonly object: THREE.Object3D;
  update(dt: number): boolean;
  dispose(): void;
}

const FX_COLORS: Record<FxKind, number> = {
  election: ROLE_COLORS.leader,
  commit: 0x59d6f2,
  fizzle: FLIGHT_COLORS.ackNo,
};

/** Expanding ground ring — election victories and commits. */
class RippleFx implements Fx {
  readonly object: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private life = 0;
  private readonly duration: number;
  private readonly maxScale: number;

  constructor(position: THREE.Vector3, color: number, duration: number, maxScale: number) {
    this.duration = duration;
    this.maxScale = maxScale;
    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.object = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.9, 64), this.material);
    this.object.rotation.x = -Math.PI / 2;
    this.object.position.copy(position);
    this.object.position.y = 0.02;
  }

  update(dt: number): boolean {
    this.life += dt;
    const t = this.life / this.duration;
    if (t >= 1) return false;
    const eased = 1 - (1 - t) ** 3;
    this.object.scale.setScalar(0.6 + eased * this.maxScale);
    this.material.opacity = 0.85 * (1 - t);
    return true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

/** Brief burst where a message died. */
class FizzleFx implements Fx {
  readonly object: THREE.Sprite;
  private life = 0;

  constructor(position: THREE.Vector3, glowTexture: THREE.Texture) {
    this.object = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: FX_COLORS.fizzle,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.object.position.copy(position);
    this.object.position.y += 0.4;
  }

  update(dt: number): boolean {
    this.life += dt;
    const t = this.life / 0.5;
    if (t >= 1) return false;
    this.object.scale.setScalar(0.3 + t * 1.1);
    this.object.material.opacity = 0.9 * (1 - t);
    return true;
  }

  dispose(): void {
    this.object.material.dispose();
  }
}

export function createFx(kind: FxKind, position: THREE.Vector3, glowTexture: THREE.Texture): Fx {
  switch (kind) {
    case "election":
      return new RippleFx(position, FX_COLORS.election, 1.1, 4.6);
    case "commit":
      return new RippleFx(position, FX_COLORS.commit, 0.7, 2.2);
    case "fizzle":
      return new FizzleFx(position, glowTexture);
  }
}
