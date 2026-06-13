import type { NodeId, Role } from "../raft/index.ts";
import type { FlightKind } from "../theme.ts";

/** One slot of the per-node mini log strip. */
export interface NodeLogCell {
  readonly term: number;
  readonly committed: boolean;
}

/** Presentation-ready state for one node at the playhead instant. */
export interface NodeView {
  readonly id: NodeId;
  readonly role: Role;
  readonly stopped: boolean;
  readonly term: number;
  /** Remaining fraction (0..1) of the election timeout, null for leaders/stopped. */
  readonly timerFraction: number | null;
  readonly selected: boolean;
  /**
   * Tail of the replicated log, aligned across all nodes (same window):
   * null = this node is missing that entry entirely.
   */
  readonly logCells: readonly (NodeLogCell | null)[];
}

/** A message in flight at the playhead instant. */
export interface FlightView {
  readonly id: number;
  readonly kind: FlightKind;
  readonly from: NodeId;
  readonly to: NodeId;
  /** 0 at sender, 1 at receiver. */
  readonly progress: number;
  /** Doomed by packet loss — reddens as it approaches its death point. */
  readonly dying: boolean;
}

export type FxKind = "election" | "commit" | "fizzle";

/** One-shot effect to spawn this render frame. */
export type FxSpawn =
  | { readonly kind: FxKind; readonly nodeId: NodeId }
  | {
      /** Explosion somewhere along a flight arc (packet death). */
      readonly kind: "burst";
      readonly from: NodeId;
      readonly to: NodeId;
      readonly progress: number;
    };

/** Everything the scene needs to draw one frame. */
export interface RenderView {
  readonly nodes: readonly NodeView[];
  readonly flights: readonly FlightView[];
  readonly fx: readonly FxSpawn[];
  /** Bumped on backward scrub / fork — live effects are stale, clear them. */
  readonly fxEpoch: number;
}
