import * as THREE from "three";
import { FLIGHT_COLORS, type FlightKind } from "../theme.ts";
import type { FlightView } from "./types.ts";

const TRAIL_POINTS = 16;
const TRAIL_SPAN = 0.2; // fraction of the curve behind the head

/** Both head textures a flight may use; heartbeats get the hollow ring. */
export interface FlightTextures {
  readonly glow: THREE.Texture;
  readonly ring: THREE.Texture;
}

const HEAD_SCALE: Record<FlightKind, number> = {
  voteReq: 0.42,
  voteGrant: 0.42,
  voteDeny: 0.3,
  append: 0.44,
  // Slightly larger than its old 0.26 so the hollow centre reads through bloom.
  heartbeat: 0.32,
  ackOk: 0.24,
  ackNo: 0.3,
};

/** Cargo beads trailing an AppendEntries packet, one per replicated entry. */
const BEAD_CAP = 5; // beyond this the train just reads as "lots"
const BEAD_HEAD_SCALE = 0.2; // nearest-to-head bead size
const BEAD_SPACING = 0.04; // fraction of curve between beads

/**
 * The arc a message travels: lifted off the plane and pushed sideways so
 * opposing directions get separate lanes. Shared with the fx system so
 * mid-flight explosions land exactly where the packet died.
 */
export function flightCurve(
  from: THREE.Vector3,
  to: THREE.Vector3,
  laneSign: number,
): THREE.QuadraticBezierCurve3 {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  const along = to.clone().sub(from).normalize();
  const perp = new THREE.Vector3(-along.z, 0, along.x);
  const span = from.distanceTo(to);
  const control = mid
    .clone()
    .add(new THREE.Vector3(0, 0.9 + span * 0.12, 0))
    .add(perp.multiplyScalar(laneSign * 0.55));
  return new THREE.QuadraticBezierCurve3(from.clone(), control, to.clone());
}

const DEATH_COLOR = new THREE.Color(0xff4040);

/**
 * A message travelling along a raised bezier arc. The trail is sampled
 * directly from the curve behind the head, so it renders correctly even
 * when time is scrubbed backwards.
 */
export class FlightVisual {
  readonly group: THREE.Group;

  private readonly curve: THREE.QuadraticBezierCurve3;
  private readonly head: THREE.Sprite;
  /** Ring drawn around the head while this flight is being inspected. */
  private readonly selection: THREE.Sprite;
  private readonly trail: THREE.Line;
  private readonly trailPositions: Float32Array;
  private readonly baseColor: THREE.Color;
  /** One glowing orb per carried log entry, towed behind the head. */
  private readonly beads: THREE.Sprite[] = [];

  constructor(
    kind: FlightKind,
    from: THREE.Vector3,
    to: THREE.Vector3,
    textures: FlightTextures,
    laneSign: number,
    entryCount = 0,
  ) {
    this.group = new THREE.Group();
    const color = new THREE.Color(FLIGHT_COLORS[kind]);
    this.baseColor = color.clone();
    this.curve = flightCurve(from, to, laneSign);

    // A heartbeat carries no entries, so it flies as a hollow ring; everything
    // else is a solid glow.
    this.head = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: kind === "heartbeat" ? textures.ring : textures.glow,
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.head.scale.setScalar(HEAD_SCALE[kind]);
    this.group.add(this.head);

    // A bright ring that appears only while the packet is being inspected.
    this.selection = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: textures.ring,
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.selection.scale.setScalar(HEAD_SCALE[kind] * 2.6);
    this.selection.visible = false;
    this.group.add(this.selection);

    // Cargo: a bead for each replicated entry, tapering away from the head.
    const beadCount = kind === "append" ? Math.min(entryCount, BEAD_CAP) : 0;
    for (let i = 0; i < beadCount; i += 1) {
      const bead = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: textures.glow,
          color,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      bead.scale.setScalar(BEAD_HEAD_SCALE * (1 - i * 0.12));
      this.beads.push(bead);
      this.group.add(bead);
    }

    this.trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailColors = new Float32Array(TRAIL_POINTS * 3);
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      // Additive blending: fading to black fades the trail out.
      const fade = (i / (TRAIL_POINTS - 1)) ** 1.6;
      trailColors[i * 3] = color.r * fade;
      trailColors[i * 3 + 1] = color.g * fade;
      trailColors[i * 3 + 2] = color.b * fade;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
    this.trail = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.group.add(this.trail);
  }

  apply(view: FlightView, wallProgress?: number): void {
    // A partitioned packet only travels as far as the barrier before it dies.
    const limit = wallProgress ?? 1;
    const p = Math.min(Math.max(view.progress, 0), 1, limit);
    const headPos = this.curve.getPoint(p);
    this.head.position.copy(headPos);
    this.selection.position.copy(headPos);

    if (view.dying) {
      // A doomed packet reddens over the last stretch before it dies at 0.5.
      const redness = Math.min(Math.max((p - 0.2) / 0.3, 0), 1);
      this.head.material.color.copy(this.baseColor).lerp(DEATH_COLOR, redness);
    } else if (wallProgress !== undefined && wallProgress > 0) {
      // Heading into the wall: redden over the final approach to it.
      const redness = Math.min(Math.max(view.progress / wallProgress - 0.55, 0) / 0.45, 1);
      this.head.material.color.copy(this.baseColor).lerp(DEATH_COLOR, redness);
    } else {
      this.head.material.color.copy(this.baseColor);
    }

    const tailStart = Math.max(0, p - TRAIL_SPAN);
    const scratch = new THREE.Vector3();
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const t = tailStart + ((p - tailStart) * i) / (TRAIL_POINTS - 1);
      this.curve.getPoint(t, scratch);
      this.trailPositions[i * 3] = scratch.x;
      this.trailPositions[i * 3 + 1] = scratch.y;
      this.trailPositions[i * 3 + 2] = scratch.z;
    }
    const attr = this.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;

    // Tow the cargo beads behind the head, matching its (possibly reddened)
    // colour so the payload dies with the packet. Beads not yet off the
    // sender are hidden.
    for (let i = 0; i < this.beads.length; i += 1) {
      const bead = this.beads[i];
      if (!bead) continue;
      const t = p - BEAD_SPACING * (i + 1);
      if (t <= 0) {
        bead.visible = false;
        continue;
      }
      bead.visible = true;
      this.curve.getPoint(t, scratch);
      bead.position.copy(scratch);
      bead.material.color.copy(this.head.material.color);
    }
  }

  /**
   * Fraction along the arc where it crosses a vertical plane (point +
   * XZ normal), or null if it never does. Used to find where a partitioned
   * packet meets the wall.
   */
  crossing(planePoint: THREE.Vector3, planeNormal: THREE.Vector3): number | null {
    const SAMPLES = 24;
    const scratch = new THREE.Vector3();
    const signed = (t: number): number =>
      this.curve.getPoint(t, scratch).sub(planePoint).dot(planeNormal);

    let prev = signed(0);
    for (let i = 1; i <= SAMPLES; i += 1) {
      const t = i / SAMPLES;
      const d = signed(t);
      if (prev <= 0 !== d <= 0) {
        const t0 = (i - 1) / SAMPLES;
        return t0 + (prev / (prev - d)) * (t - t0);
      }
      prev = d;
    }
    return null;
  }

  /** World position at a given progress along the arc. */
  pointAt(progress: number): THREE.Vector3 {
    return this.curve.getPoint(Math.min(Math.max(progress, 0), 1));
  }

  /** Current world position of the head, for screen-space picking. */
  worldHead(target: THREE.Vector3): THREE.Vector3 {
    return this.head.getWorldPosition(target);
  }

  setSelected(on: boolean): void {
    this.selection.visible = on;
  }

  dispose(): void {
    this.head.material.dispose();
    this.selection.material.dispose();
    this.trail.geometry.dispose();
    (this.trail.material as THREE.Material).dispose();
    for (const bead of this.beads) bead.material.dispose();
  }
}
