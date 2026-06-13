import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";
import { type DividingPlane, dividingPlane, type PartitionNode } from "./partition-visual.ts";

const RING = 6;
const TAU = Math.PI * 2;

/** Build `n` nodes on the ring, marking the given indices as group A. */
function ringNodes(n: number, aIndices: number[]): PartitionNode[] {
  const aSet = new Set(aIndices);
  const nodes: PartitionNode[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    nodes.push({
      id: `n${i + 1}`,
      inA: aSet.has(i),
      pos: new THREE.Vector3(Math.sin(a) * RING, 0, -Math.cos(a) * RING),
    });
  }
  return nodes;
}

const side = (node: PartitionNode, plane: DividingPlane): number =>
  node.pos.clone().sub(plane.point).dot(plane.normal);

function expectClean(nodes: PartitionNode[]): void {
  const plane = dividingPlane(nodes);
  expect(plane).not.toBeNull();
  for (const node of nodes) {
    // Group A lands on the positive (normal) side; group B on the negative.
    if (node.inA) expect(side(node, plane as DividingPlane)).toBeGreaterThan(0);
    else expect(side(node, plane as DividingPlane)).toBeLessThan(0);
  }
}

describe("dividingPlane", () => {
  it("separates a minority arc from the majority", () => {
    expectClean(ringNodes(5, [0, 1]));
  });

  it("separates an arc that wraps across the 0 boundary", () => {
    expectClean(ringNodes(6, [5, 0]));
  });

  it("separates an even split", () => {
    expectClean(ringNodes(6, [0, 1, 2]));
  });

  it("separates a single isolated node", () => {
    expectClean(ringNodes(7, [3]));
  });

  it("returns null when there's nothing to divide", () => {
    expect(dividingPlane([])).toBeNull();
    expect(dividingPlane(ringNodes(4, []))).toBeNull();
  });
});
