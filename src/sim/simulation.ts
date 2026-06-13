/**
 * Discrete-event simulation of a Raft cluster, with a fully recorded
 * timeline. Every event produces a Frame (complete cluster state), so the
 * UI can scrub to any past moment losslessly and resume — or fork the
 * timeline by intervening in the past.
 */

import { DEFAULT_TIMING, RaftNode } from "../raft/index.ts";
import type {
  NodeId,
  RaftEvent,
  RaftMessage,
  RaftNodeSnapshot,
  RaftTimingOptions,
  StepResult,
} from "../raft/index.ts";
import { applyCommand, type KVCommand } from "./kv.ts";
import { mulberry32, uniform } from "./prng.ts";

export type SimMessage = RaftMessage<KVCommand>;

/** A message travelling between nodes. */
export interface MessageFlight {
  readonly id: number;
  readonly message: SimMessage;
  readonly sentAt: number;
  readonly deliverAt: number;
  /** Doomed by packet loss: it travels, but never arrives. */
  readonly lost?: boolean;
}

/** Live-tunable network conditions (one-way, in sim-ms). */
export interface NetworkConditions {
  /** Base one-way latency. */
  latency: number;
  /** Additional random spread on top of the base. */
  jitter: number;
  /** Fraction of messages dropped in transit (0..1). */
  loss: number;
}

/**
 * A two-way network split. Messages between the two groups never arrive —
 * exactly as if a link between them went down. Each group is a contiguous
 * arc of the ring so the split has a clean dividing line.
 */
export interface PartitionState {
  /** The smaller, "split-away" side (a contiguous ring arc). */
  readonly groupA: readonly NodeId[];
  /** Everyone else. */
  readonly groupB: readonly NodeId[];
}

/** Why a frame was recorded. */
export type SimCause =
  | { readonly kind: "init" }
  | { readonly kind: "reset" }
  | { readonly kind: "delivery"; readonly flight: MessageFlight }
  | { readonly kind: "drop"; readonly flight: MessageFlight; readonly reason: string }
  | { readonly kind: "wake"; readonly nodeId: NodeId }
  | {
      readonly kind: "clientPropose";
      readonly nodeId: NodeId;
      readonly command: KVCommand;
      readonly index: number;
    }
  | { readonly kind: "nodeAdded"; readonly nodeId: NodeId }
  | { readonly kind: "nodeRemoved"; readonly nodeId: NodeId }
  | { readonly kind: "nodeStopped"; readonly nodeId: NodeId }
  | { readonly kind: "nodeRestarted"; readonly nodeId: NodeId }
  | { readonly kind: "partitioned"; readonly partition: PartitionState }
  | { readonly kind: "partitionHealed" };

export interface NarratedEvent {
  readonly nodeId: NodeId;
  readonly event: RaftEvent;
}

/** One recorded instant: complete cluster state after an event. */
export interface Frame {
  readonly time: number;
  readonly cause: SimCause;
  readonly raftEvents: readonly NarratedEvent[];
  readonly nodes: readonly RaftNodeSnapshot<KVCommand>[];
  readonly kv: ReadonlyMap<NodeId, ReadonlyMap<string, string>>;
  readonly inFlight: readonly MessageFlight[];
  /** Active network split at this instant, or null if the network is whole. */
  readonly partition: PartitionState | null;
}

export interface SimulationOptions {
  readonly nodeCount?: number;
  readonly seed?: number;
  readonly timing?: Partial<RaftTimingOptions>;
  readonly latencyMin?: number;
  readonly latencyMax?: number;
  /** Leaders propose a no-op on election (like etcd) so commits stay live. */
  readonly autoNoopOnElection?: boolean;
  /** Cap on retained frames; oldest are trimmed (bounds scrub history). */
  readonly maxFrames?: number;
}

// Default network: a teaching network, not a true LAN — latency is
// stretched to ~10% of the election timeout (raftscope uses the same
// trick) so message flights are watchable at human playback speeds.
// Dial latency down to 0.5 ms for honest same-datacenter behavior.
const DEFAULTS = {
  nodeCount: 5,
  seed: 1,
  latencyMin: 10,
  latencyMax: 15,
  autoNoopOnElection: true,
  maxFrames: 30_000,
} as const;

export class RaftSimulation {
  readonly seed: number;

  /**
   * Mutable network conditions — dial these live. Stability rule of thumb:
   * keep the worst round trip, 2 × (latency + jitter), well under the
   * minimum election timeout or healthy followers start campaigning.
   */
  readonly network: NetworkConditions;

  private timing: Partial<RaftTimingOptions>;
  private readonly autoNoop: boolean;
  private readonly maxFrames: number;

  private nodes = new Map<NodeId, RaftNode<KVCommand>>();
  private kv = new Map<NodeId, ReadonlyMap<string, string>>();
  private flights: MessageFlight[] = [];
  private framesInternal: Frame[] = [];

  // Active network split (null = whole network). `partitionA` is the group-A
  // membership set, kept in sync with `partitionState` for fast lookups.
  private partitionState: PartitionState | null = null;
  private partitionA: Set<NodeId> | null = null;

  private now = 0;
  private flightSeq = 0;
  private nodeOrdinal = 0;
  private forkCount = 0;
  private rngNet: () => number;

  constructor(options: SimulationOptions = {}) {
    this.seed = options.seed ?? DEFAULTS.seed;
    this.timing = options.timing ?? {};
    const latencyMin = options.latencyMin ?? DEFAULTS.latencyMin;
    const latencyMax = options.latencyMax ?? DEFAULTS.latencyMax;
    this.network = { latency: latencyMin, jitter: Math.max(0, latencyMax - latencyMin), loss: 0 };
    this.autoNoop = options.autoNoopOnElection ?? DEFAULTS.autoNoopOnElection;
    this.maxFrames = options.maxFrames ?? DEFAULTS.maxFrames;
    this.rngNet = mulberry32(this.seed ^ 0x9e3779b9);

    const count = options.nodeCount ?? DEFAULTS.nodeCount;
    const ids: NodeId[] = [];
    for (let i = 0; i < count; i += 1) ids.push(this.nextNodeId());
    for (const id of ids) {
      // Backdate construction so the opening election timers start mostly
      // elapsed — nobody wants to watch the first full timeout tick down.
      // The randomized spread is untouched, so election dynamics are
      // unchanged; everything just happens sooner.
      this.nodes.set(
        id,
        this.createNode(
          id,
          ids.filter((p) => p !== id),
          -this.firstElectionBoost(),
        ),
      );
      this.kv.set(id, new Map());
    }
    this.record({ kind: "init" }, []);
  }

  // -------------------------------------------------------------------------
  // Reading the timeline
  // -------------------------------------------------------------------------

  get frames(): readonly Frame[] {
    return this.framesInternal;
  }

  /** Current simulated time (the live edge). */
  get duration(): number {
    return this.now;
  }

  /** Earliest scrubbable time (older frames may have been trimmed). */
  get horizon(): number {
    return this.framesInternal[0]?.time ?? 0;
  }

  /** Latest recorded frame at or before `t`. */
  frameAt(t: number): Frame {
    const frames = this.framesInternal;
    const first = frames[0];
    if (!first) throw new Error("timeline is empty");

    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const frame = frames[mid];
      if (frame && frame.time <= t) lo = mid;
      else hi = mid - 1;
    }
    return frames[lo] ?? first;
  }

  nodeIds(): NodeId[] {
    return [...this.nodes.keys()];
  }

  // Resolved timing values (defaults applied) for display and stability hints.
  get electionTimeoutMin(): number {
    return this.timing.electionTimeoutMin ?? DEFAULT_TIMING.electionTimeoutMin;
  }

  get electionTimeoutMax(): number {
    return this.timing.electionTimeoutMax ?? DEFAULT_TIMING.electionTimeoutMax;
  }

  get heartbeatInterval(): number {
    return this.timing.heartbeatInterval ?? DEFAULT_TIMING.heartbeatInterval;
  }

  /** Retune Raft timers live, across every node (current and future). */
  setTiming(timing: Partial<RaftTimingOptions>): void {
    this.timing = { ...this.timing, ...timing };
    for (const node of this.nodes.values()) node.setTiming(timing);
  }

  /** Restore default network conditions. */
  resetNetwork(): void {
    this.network.latency = DEFAULTS.latencyMin;
    this.network.jitter = DEFAULTS.latencyMax - DEFAULTS.latencyMin;
    this.network.loss = 0;
  }

  /** The live leader (highest term wins if a stale leader lingers). */
  leaderId(): NodeId | null {
    let best: { id: NodeId; term: number } | null = null;
    for (const node of this.nodes.values()) {
      if (node.isStopped()) continue;
      const snap = node.snapshot();
      if (snap.role === "leader" && (!best || snap.currentTerm > best.term)) {
        best = { id: snap.id, term: snap.currentTerm };
      }
    }
    return best?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Advancing time
  // -------------------------------------------------------------------------

  /** Run the discrete-event loop up to time `t`. */
  advanceTo(t: number): void {
    if (t <= this.now) return;

    for (;;) {
      let nextFlight: MessageFlight | null = null;
      for (const f of this.flights) {
        if (!nextFlight || f.deliverAt < nextFlight.deliverAt) nextFlight = f;
      }
      let nextWake: { at: number; id: NodeId } | null = null;
      for (const [id, node] of this.nodes) {
        const at = node.nextWakeAt();
        if (at !== null && Number.isFinite(at) && (!nextWake || at < nextWake.at)) {
          nextWake = { at, id };
        }
      }

      const flightAt = nextFlight?.deliverAt ?? Number.POSITIVE_INFINITY;
      const wakeAt = nextWake?.at ?? Number.POSITIVE_INFINITY;
      const eventAt = Math.min(flightAt, wakeAt);
      if (eventAt > t) break;

      this.now = eventAt;
      if (flightAt <= wakeAt && nextFlight) {
        this.deliver(nextFlight);
      } else if (nextWake) {
        const node = this.nodes.get(nextWake.id);
        if (node) {
          const events = this.absorb(nextWake.id, node.tick(this.now));
          this.record({ kind: "wake", nodeId: nextWake.id }, events);
          this.afterEvents(events);
        }
      }
    }

    this.now = t;
  }

  // -------------------------------------------------------------------------
  // Interventions (all happen at the live edge; fork first to act in the past)
  // -------------------------------------------------------------------------

  /** Propose a client command to the current leader. */
  propose(command: KVCommand): boolean {
    const leaderId = this.leaderId();
    if (!leaderId) return false;
    return this.proposeTo(leaderId, command);
  }

  stopNode(id: NodeId): boolean {
    const node = this.nodes.get(id);
    if (!node || node.isStopped()) return false;
    node.stop();
    this.record({ kind: "nodeStopped", nodeId: id }, []);
    return true;
  }

  restartNode(id: NodeId): boolean {
    const node = this.nodes.get(id);
    if (!node || !node.isStopped()) return false;
    node.restart(this.now);
    // The state machine is rebuilt from scratch as the log re-commits.
    this.kv.set(id, new Map());
    this.record({ kind: "nodeRestarted", nodeId: id }, []);
    return true;
  }

  addNode(): NodeId {
    const id = this.nextNodeId();
    const existing = [...this.nodes.keys()];
    this.nodes.set(id, this.createNode(id, existing));
    this.kv.set(id, new Map());

    const events: NarratedEvent[] = [];
    for (const otherId of existing) {
      const other = this.nodes.get(otherId);
      if (!other) continue;
      const peers = [...this.nodes.keys()].filter((p) => p !== otherId);
      events.push(...this.absorb(otherId, other.setPeers(peers)));
    }
    this.repartitionForMembership();
    this.record({ kind: "nodeAdded", nodeId: id }, events);
    this.afterEvents(events);
    return id;
  }

  removeNode(id: NodeId): boolean {
    if (!this.nodes.has(id) || this.nodes.size <= 1) return false;
    this.nodes.delete(id);
    this.kv.delete(id);

    const events: NarratedEvent[] = [];
    for (const [otherId, other] of this.nodes) {
      const peers = [...this.nodes.keys()].filter((p) => p !== otherId);
      events.push(...this.absorb(otherId, other.setPeers(peers)));
    }
    this.repartitionForMembership();
    this.record({ kind: "nodeRemoved", nodeId: id }, events);
    this.afterEvents(events);
    return true;
  }

  /** The live network split, or null. */
  get activePartition(): PartitionState | null {
    return this.partitionState;
  }

  /**
   * Sever the network into two groups. `fraction` (≈ 1/2, 1/3, 1/4) sets how
   * many nodes are split away into the smaller, isolated group, chosen as a
   * random contiguous arc of the ring — so it may or may not contain the
   * current leader. Messages between the groups are dropped until healed.
   */
  partition(fraction: number): PartitionState | null {
    const ids = this.ringOrder();
    const n = ids.length;
    if (n < 2) return null;

    // Floor keeps group A the minority (or exactly half on an even split);
    // clamp guarantees both sides keep at least one node.
    const k = Math.max(1, Math.min(n - 1, Math.floor(n * fraction)));
    const start = Math.floor(this.rngNet() * n);
    const groupA: NodeId[] = [];
    for (let i = 0; i < k; i += 1) groupA.push(ids[(start + i) % n] as NodeId);

    const aSet = new Set(groupA);
    const groupB = ids.filter((id) => !aSet.has(id));
    const state: PartitionState = { groupA, groupB };

    this.partitionState = state;
    this.partitionA = aSet;
    this.record({ kind: "partitioned", partition: state }, []);
    return state;
  }

  /** Reconnect the two groups; in-flight messages flow again. */
  healPartition(): boolean {
    if (!this.partitionState) return false;
    this.partitionState = null;
    this.partitionA = null;
    this.record({ kind: "partitionHealed" }, []);
    return true;
  }

  /**
   * Start history over without rebuilding the cluster: same members and
   * up/down states, but everyone becomes a term-0 follower with an empty
   * log and store, the timeline goes blank, and a fresh election decides
   * the new leader.
   */
  reset(): void {
    const min = this.timing.electionTimeoutMin ?? DEFAULT_TIMING.electionTimeoutMin;
    const max = this.timing.electionTimeoutMax ?? DEFAULT_TIMING.electionTimeoutMax;

    this.forkCount += 1;
    this.now = 0;
    this.flights = [];
    this.framesInternal = [];
    this.partitionState = null;
    this.partitionA = null;
    this.rngNet = mulberry32((this.seed ^ 0x9e3779b9) + this.forkCount * 0x85eb);

    const ids = [...this.nodes.keys()];
    const fresh = new Map<NodeId, RaftNode<KVCommand>>();
    for (const [id, node] of this.nodes) {
      const peers = ids.filter((p) => p !== id);
      const span = uniform(this.rngNet, min, max);
      const snapshot: RaftNodeSnapshot<KVCommand> = {
        id,
        role: "follower",
        currentTerm: 0,
        votedFor: null,
        log: [],
        commitIndex: 0,
        lastApplied: 0,
        knownLeader: null,
        peers,
        stopped: node.isStopped(),
        // Mostly elapsed, like the initial construction: the post-reset
        // election starts within a beat instead of a full timeout.
        electionDeadline: span - this.firstElectionBoost(),
        electionTimeoutSpan: span,
        heartbeatDue: null,
        votesGranted: [],
        nextIndex: null,
        matchIndex: null,
      };
      fresh.set(
        id,
        new RaftNode<KVCommand>({
          id,
          peers,
          now: 0,
          rng: this.nodeRng(id),
          timing: this.timing,
          restoreFrom: snapshot,
        }),
      );
    }
    this.nodes = fresh;
    this.kv = new Map(ids.map((id) => [id, new Map()]));
    this.record({ kind: "reset" }, []);
  }

  /**
   * Rewind reality to time `t`: drop all frames after it and restore live
   * state from the last frame at or before `t`. The discarded future never
   * happened; simulation continues from here (and will diverge).
   */
  forkAt(t: number): void {
    const frame = this.frameAt(t);
    const cut = this.framesInternal.indexOf(frame);
    this.framesInternal = this.framesInternal.slice(0, cut + 1);
    this.forkCount += 1;
    this.now = frame.time;

    this.rngNet = mulberry32((this.seed ^ 0x9e3779b9) + this.forkCount * 0x85eb);
    this.nodes = new Map();
    for (const snap of frame.nodes) {
      this.nodes.set(
        snap.id,
        new RaftNode<KVCommand>({
          id: snap.id,
          peers: snap.peers,
          now: frame.time,
          rng: this.nodeRng(snap.id),
          timing: this.timing,
          restoreFrom: snap,
        }),
      );
    }
    this.kv = new Map(frame.kv);
    this.flights = frame.inFlight.filter((f) => f.deliverAt > frame.time);
    this.partitionState = frame.partition;
    this.partitionA = frame.partition ? new Set(frame.partition.groupA) : null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private proposeTo(nodeId: NodeId, command: KVCommand): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    const result = node.propose(command, this.now);
    if (!result.accepted) return false;
    const events = this.absorb(nodeId, result.step);
    this.record({ kind: "clientPropose", nodeId, command, index: result.index }, events);
    return true;
  }

  private deliver(flight: MessageFlight): void {
    this.flights = this.flights.filter((f) => f.id !== flight.id);

    if (flight.lost) {
      this.record({ kind: "drop", flight, reason: "packet loss" }, []);
      return;
    }
    // A live partition severs the link the moment a crossing message would
    // arrive — so messages already on the wire when the split forms die too,
    // and any still crossing when it heals get through.
    if (this.crossesPartition(flight.message.from, flight.message.to)) {
      this.record({ kind: "drop", flight, reason: "partitioned" }, []);
      return;
    }
    const target = this.nodes.get(flight.message.to);

    if (!target) {
      this.record({ kind: "drop", flight, reason: "node removed" }, []);
      return;
    }
    if (target.isStopped()) {
      this.record({ kind: "drop", flight, reason: "node down" }, []);
      return;
    }

    const events = this.absorb(flight.message.to, target.receive(flight.message, this.now));
    this.record({ kind: "delivery", flight }, events);
    this.afterEvents(events);
  }

  /** Queue outgoing messages, apply commits, and narrate events. */
  private absorb(nodeId: NodeId, step: StepResult<KVCommand>): NarratedEvent[] {
    for (const message of step.messages) {
      const oneWay = this.sampleLatency();
      const lost = this.rngNet() < this.network.loss;
      // Lost packets die halfway along the route (at half the travel time,
      // so their speed matches surviving packets).
      this.flights.push({
        id: this.flightSeq++,
        message,
        sentAt: this.now,
        deliverAt: this.now + (lost ? oneWay * 0.5 : oneWay),
        lost,
      });
    }
    if (step.committed.length > 0) {
      let state = this.kv.get(nodeId) ?? new Map<string, string>();
      for (const entry of step.committed) state = applyCommand(state, entry.command);
      this.kv.set(nodeId, state);
    }
    return step.events.map((event) => ({ nodeId, event }));
  }

  /** Post-event hooks: etcd-style no-op proposal from a fresh leader. */
  private afterEvents(events: readonly NarratedEvent[]): void {
    if (!this.autoNoop) return;
    for (const { nodeId, event } of events) {
      if (event.type === "becameLeader") {
        this.proposeTo(nodeId, { op: "noop" });
      }
    }
  }

  private record(cause: SimCause, raftEvents: readonly NarratedEvent[]): void {
    this.framesInternal.push({
      time: this.now,
      cause,
      raftEvents,
      nodes: [...this.nodes.values()].map((n) => n.snapshot()),
      kv: new Map(this.kv),
      inFlight: [...this.flights],
      partition: this.partitionState,
    });
    if (this.framesInternal.length > this.maxFrames) {
      this.framesInternal.splice(0, this.framesInternal.length - this.maxFrames);
    }
  }

  /**
   * One-way delay: uniform within [latency, latency + jitter], with an 8%
   * long-tail straggler so out-of-order delivery stays visible. The RNG is
   * consumed a fixed number of times per call to keep runs deterministic.
   */
  private sampleLatency(): number {
    const { latency, jitter } = this.network;
    const base = latency + this.rngNet() * Math.max(jitter, 0.001);
    const straggle = this.rngNet();
    const factor = this.rngNet();
    return straggle < 0.08 ? base * (1.6 + factor * 0.6) : base;
  }

  private createNode(id: NodeId, peers: NodeId[], now = this.now): RaftNode<KVCommand> {
    return new RaftNode<KVCommand>({
      id,
      peers,
      now,
      rng: this.nodeRng(id),
      timing: this.timing,
    });
  }

  /** How much of the first election timeout to skip (75% of the minimum). */
  private firstElectionBoost(): number {
    return this.electionTimeoutMin * 0.75;
  }

  private nodeRng(id: NodeId): () => number {
    let hash = this.seed + this.forkCount * 104_729;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return mulberry32(hash);
  }

  private nextNodeId(): NodeId {
    this.nodeOrdinal += 1;
    return `n${this.nodeOrdinal}`;
  }

  /** Present node ids in ring order (by ordinal) — matches the visual layout. */
  private ringOrder(): NodeId[] {
    return [...this.nodes.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }

  /** True when `from` and `to` sit on opposite sides of a live partition. */
  private crossesPartition(from: NodeId, to: NodeId): boolean {
    if (!this.partitionA) return false;
    return this.partitionA.has(from) !== this.partitionA.has(to);
  }

  /**
   * Keep a live partition consistent after the membership changes: drop gone
   * nodes, drop fresh nodes onto the majority side, and heal entirely if a
   * side empties out.
   */
  private repartitionForMembership(): void {
    if (!this.partitionState) return;
    const present = new Set(this.nodes.keys());
    const groupA = this.partitionState.groupA.filter((id) => present.has(id));
    const groupB = this.partitionState.groupB.filter((id) => present.has(id));
    const known = new Set([...groupA, ...groupB]);
    for (const id of this.ringOrder()) {
      if (!known.has(id)) groupB.push(id);
    }
    if (groupA.length === 0 || groupB.length === 0) {
      this.partitionState = null;
      this.partitionA = null;
      return;
    }
    this.partitionState = { groupA, groupB };
    this.partitionA = new Set(groupA);
  }
}
