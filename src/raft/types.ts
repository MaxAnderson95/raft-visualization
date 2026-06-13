/**
 * Core types for the Raft consensus library.
 *
 * This library is "sans-I/O": it never touches the network, timers, or
 * randomness directly. The host application drives every node by delivering
 * messages, advancing time, and supplying a seeded RNG. This makes the
 * library deterministic, testable, and embeddable anywhere (browser,
 * worker, server, simulation).
 */

export type NodeId = string;

export type Role = "follower" | "candidate" | "leader";

/** A single immutable entry in the replicated log. Indexes are 1-based. */
export interface LogEntry<C = unknown> {
  readonly term: number;
  readonly index: number;
  readonly command: C;
}

// ---------------------------------------------------------------------------
// RPC messages (Raft paper, Figure 2)
// ---------------------------------------------------------------------------

export interface RequestVoteRequest {
  readonly kind: "RequestVote";
  readonly term: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

export interface RequestVoteResponse {
  readonly kind: "RequestVoteResponse";
  readonly term: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly granted: boolean;
}

export interface AppendEntriesRequest<C = unknown> {
  readonly kind: "AppendEntries";
  readonly term: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly LogEntry<C>[];
  readonly leaderCommit: number;
}

export interface AppendEntriesResponse {
  readonly kind: "AppendEntriesResponse";
  readonly term: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly success: boolean;
  /** Highest log index known to be replicated on the follower (valid when success). */
  readonly matchIndex: number;
  /**
   * On failure: where the leader should resume — the first index of the
   * follower's conflicting term, or one past its last entry if its log is
   * short. Lets the leader skip whole terms instead of probing one entry
   * per round trip (the dissertation's fast-backup optimization). 0 when
   * unused.
   */
  readonly conflictIndex: number;
}

export type RaftMessage<C = unknown> =
  | RequestVoteRequest
  | RequestVoteResponse
  | AppendEntriesRequest<C>
  | AppendEntriesResponse;

// ---------------------------------------------------------------------------
// Semantic events — emitted so hosts can narrate / visualize what happened
// ---------------------------------------------------------------------------

export type RaftEvent =
  | { readonly type: "becameFollower"; readonly term: number; readonly reason: string }
  | { readonly type: "becameCandidate"; readonly term: number }
  | { readonly type: "becameLeader"; readonly term: number }
  | { readonly type: "electionTimeout"; readonly term: number }
  | { readonly type: "grantedVote"; readonly to: NodeId; readonly term: number }
  | {
      readonly type: "deniedVote";
      readonly to: NodeId;
      readonly term: number;
      readonly reason: string;
    }
  | { readonly type: "receivedVote"; readonly from: NodeId; readonly term: number }
  | {
      readonly type: "appendedEntries";
      readonly fromLeader: NodeId;
      readonly count: number;
      readonly firstIndex: number;
    }
  | { readonly type: "truncatedLog"; readonly fromIndex: number }
  | { readonly type: "advancedCommit"; readonly commitIndex: number }
  | { readonly type: "rejectedAppend"; readonly fromLeader: NodeId; readonly reason: string };

/** Everything a node wants the outside world to do after one input. */
export interface StepResult<C = unknown> {
  /** Messages to put on the wire. Delivery (and loss) is the host's job. */
  readonly messages: readonly RaftMessage<C>[];
  /** Entries newly committed by this step, in order. Apply them to the state machine. */
  readonly committed: readonly LogEntry<C>[];
  /** Semantic events for narration/visualization. */
  readonly events: readonly RaftEvent[];
}

// ---------------------------------------------------------------------------
// Node construction & introspection
// ---------------------------------------------------------------------------

export interface RaftTimingOptions {
  /** Minimum randomized election timeout, in host time units. Default 150. */
  readonly electionTimeoutMin: number;
  /** Maximum randomized election timeout, in host time units. Default 300. */
  readonly electionTimeoutMax: number;
  /** Leader heartbeat interval, in host time units. Default 50. */
  readonly heartbeatInterval: number;
}

export interface RaftNodeOptions<C = unknown> {
  readonly id: NodeId;
  /** Peer ids, excluding this node. */
  readonly peers: readonly NodeId[];
  /** Current host time when the node starts. */
  readonly now: number;
  /**
   * Random source in [0, 1). Inject a seeded PRNG for determinism.
   * Defaults to Math.random (NOT deterministic).
   */
  readonly rng?: () => number;
  readonly timing?: Partial<RaftTimingOptions>;
  /** Restore persistent + volatile state from a snapshot (time travel / restart). */
  readonly restoreFrom?: RaftNodeSnapshot<C>;
}

/**
 * A complete, immutable view of a node's state. Cheap to take every step:
 * the log array is copy-on-write inside the node, so snapshots share it.
 */
export interface RaftNodeSnapshot<C = unknown> {
  readonly id: NodeId;
  readonly role: Role;
  readonly currentTerm: number;
  readonly votedFor: NodeId | null;
  readonly log: readonly LogEntry<C>[];
  readonly commitIndex: number;
  readonly lastApplied: number;
  /** Who this node believes is the current leader (from AppendEntries). */
  readonly knownLeader: NodeId | null;
  readonly peers: readonly NodeId[];
  readonly stopped: boolean;
  /** Host time when the election timer fires (followers/candidates). */
  readonly electionDeadline: number;
  /** Length of the currently armed election timeout (for progress display). */
  readonly electionTimeoutSpan: number;
  /** Host time when the next heartbeat is due (leaders only). */
  readonly heartbeatDue: number | null;
  /** Votes received so far (candidates; includes self). */
  readonly votesGranted: readonly NodeId[];
  /** Per-peer replication state (leaders only). */
  readonly nextIndex: Readonly<Record<NodeId, number>> | null;
  readonly matchIndex: Readonly<Record<NodeId, number>> | null;
}

/** Result of proposing a client command to a node. */
export type ProposeResult<C = unknown> =
  | { readonly accepted: true; readonly index: number; readonly step: StepResult<C> }
  | { readonly accepted: false; readonly reason: "not-leader" | "stopped" };
