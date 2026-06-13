import * as THREE from "three";
import type { NodeId } from "../raft/index.ts";
import { createWallTexture } from "./textures.ts";

const TAU = Math.PI * 2;
/** The ring the nodes sit on. The dividing chord rides this radius so it
 * always passes *between* the two groups (not outside the isolated one). */
const RING_RADIUS = 6;
/** Extra length past the chord so the curtain slices clean across the scene. */
const WALL_OVERSHOOT = 2.6;
const WALL_HEIGHT = 4.2;
const GROUND_Y = -0.5;
const WALL_COLOR = 0xff4d57;

export interface PartitionNode {
  readonly id: NodeId;
  /** Member of the split-away group A (vs. the majority group B)? */
  readonly inA: boolean;
  readonly pos: THREE.Vector3;
}

/**
 * The dividing barrier between the two halves of a partitioned cluster: a
 * red energy curtain along the chord that separates the two ring arcs. It
 * also exposes the dividing plane (a point + an XZ normal pointing toward
 * group A) so the scene can test which side a node is on and find where a
 * packet's flight arc crosses it.
 */
export class PartitionVisual {
  readonly group: THREE.Group;
  /** A point on the dividing plane (ground level). */
  readonly point = new THREE.Vector3();
  /** Unit plane normal in the XZ ground plane, pointing toward group A. */
  readonly normal = new THREE.Vector3(1, 0, 0);
  /** Whether a valid dividing plane has been computed. */
  active = false;

  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private opacity = 0;
  private targetOpacity = 0;
  private elapsed = 0;

  constructor() {
    this.group = new THREE.Group();
    this.material = new THREE.MeshBasicMaterial({
      map: createWallTexture(),
      color: WALL_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, WALL_HEIGHT), this.material);
    this.group.add(this.mesh);
  }

  /** Reveal the wall and recompute its geometry for the current split. */
  show(nodes: readonly PartitionNode[]): void {
    this.targetOpacity = 1;
    this.computeGeometry(nodes);
  }

  /** Begin fading the wall out (the network healed). */
  hide(): void {
    this.targetOpacity = 0;
  }

  /** Advance fade + idle animation; returns the current opacity. */
  update(dt: number): number {
    this.elapsed += dt;
    const k = 1 - Math.exp(-dt * 6);
    this.opacity += (this.targetOpacity - this.opacity) * k;
    const pulse = 0.82 + 0.18 * Math.sin(this.elapsed * 3.1);
    this.material.opacity = this.opacity * pulse;
    if (this.targetOpacity === 0 && this.opacity < 0.02) this.active = false;
    return this.opacity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }

  // ------------------------------------------------------------------------

  private computeGeometry(nodes: readonly PartitionNode[]): void {
    const plane = dividingPlane(nodes);
    if (!plane) return;

    this.point.copy(plane.point);
    this.normal.copy(plane.normal);

    const yAxis = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3().crossVectors(plane.xAxis, yAxis).normalize();
    const basis = new THREE.Matrix4().makeBasis(plane.xAxis, yAxis, zAxis);
    this.mesh.quaternion.setFromRotationMatrix(basis);
    this.mesh.position.set(plane.mid.x, GROUND_Y + WALL_HEIGHT / 2, plane.mid.z);
    this.mesh.scale.set(plane.width, 1, 1);
    this.active = true;
  }
}

export interface DividingPlane {
  /** A point on the dividing plane, at ground level. */
  readonly point: THREE.Vector3;
  /** Unit normal in the XZ ground plane, pointing toward group A. */
  readonly normal: THREE.Vector3;
  /** Center of the wall (ground level). */
  readonly mid: THREE.Vector3;
  /** Unit vector along the wall's length. */
  readonly xAxis: THREE.Vector3;
  /** Wall length, including overshoot past the ring. */
  readonly width: number;
}

/**
 * The vertical plane that cleanly separates group A's ring arc from group B's,
 * passing through the two gaps between them. Pure geometry (no rendering), so
 * it is unit-testable. Returns null when there's nothing to divide.
 */
export function dividingPlane(nodes: readonly PartitionNode[]): DividingPlane | null {
  if (nodes.length < 2) return null;

  const angleOf = (p: THREE.Vector3): number => (Math.atan2(p.x, -p.z) + TAU) % TAU;
  const sorted = [...nodes].sort((a, b) => angleOf(a.pos) - angleOf(b.pos));

  // The two boundaries between A's arc and B's arc, as gap-midpoint angles.
  const gaps: number[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i] as PartitionNode;
    const nxt = sorted[(i + 1) % sorted.length] as PartitionNode;
    if (cur.inA === nxt.inA) continue;
    const a0 = angleOf(cur.pos);
    let a1 = angleOf(nxt.pos);
    if (a1 < a0) a1 += TAU; // wrap-around pair
    gaps.push(((a0 + a1) / 2) % TAU);
  }

  const aCentroid = new THREE.Vector3();
  let aCount = 0;
  for (const n of nodes) {
    if (n.inA) {
      aCentroid.add(n.pos);
      aCount += 1;
    }
  }
  if (aCount === 0) return null;
  aCentroid.divideScalar(aCount);

  let g0: number;
  let g1: number;
  if (gaps.length === 2) {
    g0 = gaps[0] as number;
    g1 = gaps[1] as number;
  } else {
    // Fallback for a (rare) non-contiguous group: a diameter perpendicular to
    // A's centroid direction still separates the two halves reasonably.
    const ca = angleOf(aCentroid);
    g0 = (ca + Math.PI / 2) % TAU;
    g1 = (ca + (3 * Math.PI) / 2) % TAU;
  }

  // Endpoints ride the node ring so the chord passes between the groups; the
  // chord midpoint is the foot of the perpendicular from center, the natural
  // place to center a wall that spans the whole cluster.
  const dir = (angle: number): THREE.Vector3 =>
    new THREE.Vector3(Math.sin(angle), 0, -Math.cos(angle));
  const p0 = dir(g0).multiplyScalar(RING_RADIUS);
  const p1 = dir(g1).multiplyScalar(RING_RADIUS);

  const mid = p0.clone().add(p1).multiplyScalar(0.5);
  const chord = p1.clone().sub(p0);
  const chordLen = chord.length();
  const xAxis = chord.normalize();
  // Always span at least the cluster's diameter so narrow arcs still get a
  // full barrier rather than a stubby segment.
  const width = Math.max(chordLen, RING_RADIUS * 2) + WALL_OVERSHOOT;

  // Plane normal: perpendicular to the wall in the ground plane, flipped to
  // point toward group A so side tests are consistent.
  const normal = new THREE.Vector3(-xAxis.z, 0, xAxis.x).normalize();
  if (aCentroid.clone().sub(mid).dot(normal) < 0) normal.multiplyScalar(-1);

  return { point: p0, normal, mid, xAxis, width };
}
