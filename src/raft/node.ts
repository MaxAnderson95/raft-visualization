/**
 * A single Raft node, implemented as a deterministic state machine.
 *
 * Follows the Raft paper (Ongaro & Ousterhout, "In Search of an
 * Understandable Consensus Algorithm", Figure 2) including:
 *  - leader election with randomized timeouts (§5.2)
 *  - log replication and the consistency check (§5.3)
 *  - election restriction: votes only for up-to-date logs (§5.4.1)
 *  - commit restriction: only current-term entries commit by counting (§5.4.2)
 *
 * Simplifications (deliberate, documented):
 *  - Cluster membership is managed out-of-band via `setPeers` rather than
 *    joint-consensus configuration entries (§6). All nodes are told about
 *    membership changes by the host.
 *  - No log compaction / install-snapshot RPC (§7).
 *
 * The node never schedules its own timers. Hosts must call `tick(now)`
 * whenever `nextWakeAt()` elapses, and deliver messages via `receive`.
 */

import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  LogEntry,
  NodeId,
  ProposeResult,
  RaftEvent,
  RaftMessage,
  RaftNodeOptions,
  RaftNodeSnapshot,
  RaftTimingOptions,
  RequestVoteRequest,
  RequestVoteResponse,
  Role,
  StepResult,
} from "./types.ts";

export const DEFAULT_TIMING: RaftTimingOptions = {
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50,
};

/** Mutable accumulator for one step's outputs. */
class Step<C> {
  messages: RaftMessage<C>[] = [];
  committed: LogEntry<C>[] = [];
  events: RaftEvent[] = [];

  result(): StepResult<C> {
    return { messages: this.messages, committed: this.committed, events: this.events };
  }
}

const EMPTY_STEP: StepResult<never> = { messages: [], committed: [], events: [] };

export class RaftNode<C = unknown> {
  readonly id: NodeId;

  private peers: NodeId[];
  private readonly rng: () => number;
  private timing: RaftTimingOptions;

  // --- Persistent state (would survive crashes on real hardware) ---
  private currentTerm = 0;
  private votedFor: NodeId | null = null;
  /** Copy-on-write: never mutated in place, so snapshots can share it. */
  private log: readonly LogEntry<C>[] = [];

  // --- Volatile state ---
  private role: Role = "follower";
  private commitIndex = 0;
  private lastApplied = 0;
  private knownLeader: NodeId | null = null;
  private stopped = false;
  private electionDeadline: number;
  private electionTimeoutSpan = 0;
  private heartbeatDue: number | null = null;
  private votesGranted = new Set<NodeId>();

  // --- Leader volatile state ---
  private nextIndex = new Map<NodeId, number>();
  private matchIndex = new Map<NodeId, number>();

  constructor(options: RaftNodeOptions<C>) {
    this.id = options.id;
    this.peers = [...options.peers];
    this.rng = options.rng ?? Math.random;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.electionDeadline = 0;
    this.resetElectionTimer(options.now);

    const snap = options.restoreFrom;
    if (snap) {
      this.currentTerm = snap.currentTerm;
      this.votedFor = snap.votedFor;
      this.log = snap.log;
      this.role = snap.role;
      this.commitIndex = snap.commitIndex;
      this.lastApplied = snap.lastApplied;
      this.knownLeader = snap.knownLeader;
      this.stopped = snap.stopped;
      this.peers = [...snap.peers];
      this.electionDeadline = snap.electionDeadline;
      this.electionTimeoutSpan = snap.electionTimeoutSpan;
      this.heartbeatDue = snap.heartbeatDue;
      this.votesGranted = new Set(snap.votesGranted);
      this.nextIndex = new Map(Object.entries(snap.nextIndex ?? {}));
      this.matchIndex = new Map(Object.entries(snap.matchIndex ?? {}));
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Earliest host time at which `tick` must be called, or null if idle. */
  nextWakeAt(): number | null {
    if (this.stopped) return null;
    if (this.role === "leader") return this.heartbeatDue;
    return this.electionDeadline;
  }

  /** Advance timers. Call when `nextWakeAt()` has elapsed. */
  tick(now: number): StepResult<C> {
    if (this.stopped) return EMPTY_STEP;
    const step = new Step<C>();

    if (this.role === "leader") {
      if (this.heartbeatDue !== null && now >= this.heartbeatDue) {
        this.heartbeatDue = now + this.timing.heartbeatInterval;
        for (const peer of this.peers) {
          step.messages.push(this.buildAppendEntries(peer));
        }
      }
    } else if (now >= this.electionDeadline) {
      this.startElection(now, step);
    }

    return step.result();
  }

  /** Deliver a message from the network. */
  receive(message: RaftMessage<C>, now: number): StepResult<C> {
    if (this.stopped) return EMPTY_STEP;
    const step = new Step<C>();

    // Any RPC with a newer term forces us to follower (Figure 2, "All Servers").
    if (message.term > this.currentTerm) {
      this.becomeFollower(message.term, `saw newer term from ${message.from}`, now, step);
    }

    switch (message.kind) {
      case "RequestVote":
        this.handleRequestVote(message, now, step);
        break;
      case "RequestVoteResponse":
        this.handleRequestVoteResponse(message, now, step);
        break;
      case "AppendEntries":
        this.handleAppendEntries(message, now, step);
        break;
      case "AppendEntriesResponse":
        this.handleAppendEntriesResponse(message, step);
        break;
    }

    return step.result();
  }

  /** Propose a client command. Only leaders accept. */
  propose(command: C, now: number): ProposeResult<C> {
    if (this.stopped) return { accepted: false, reason: "stopped" };
    if (this.role !== "leader") return { accepted: false, reason: "not-leader" };

    const step = new Step<C>();
    const entry: LogEntry<C> = {
      term: this.currentTerm,
      index: this.lastLogIndex() + 1,
      command,
    };
    this.log = [...this.log, entry];

    // Replicate eagerly rather than waiting for the next heartbeat.
    for (const peer of this.peers) {
      step.messages.push(this.buildAppendEntries(peer));
    }
    this.heartbeatDue = now + this.timing.heartbeatInterval;

    // A single-node cluster commits instantly.
    this.tryAdvanceCommit(step);

    return { accepted: true, index: entry.index, step: step.result() };
  }

  /**
   * Out-of-band membership change (see class docs). `peers` excludes self.
   */
  setPeers(peers: readonly NodeId[]): StepResult<C> {
    const s = new Step<C>();
    this.peers = [...peers];

    for (const peer of this.peers) {
      if (!this.nextIndex.has(peer)) this.nextIndex.set(peer, this.lastLogIndex() + 1);
      if (!this.matchIndex.has(peer)) this.matchIndex.set(peer, 0);
    }
    for (const known of this.nextIndex.keys()) {
      if (!this.peers.includes(known)) {
        this.nextIndex.delete(known);
        this.matchIndex.delete(known);
      }
    }
    for (const voter of this.votesGranted) {
      if (voter !== this.id && !this.peers.includes(voter)) this.votesGranted.delete(voter);
    }

    // A shrinking quorum can unblock commits.
    if (this.role === "leader") this.tryAdvanceCommit(s);

    return s.result();
  }

  /** Simulate a crash. Volatile state is lost; persistent state survives. */
  stop(): void {
    this.stopped = true;
    this.role = "follower";
    this.heartbeatDue = null;
    this.knownLeader = null;
    this.votesGranted = new Set();
    this.nextIndex = new Map();
    this.matchIndex = new Map();
  }

  /** Recover from a crash: persistent state intact, volatile state reset. */
  restart(now: number): void {
    this.stopped = false;
    this.role = "follower";
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.knownLeader = null;
    this.resetElectionTimer(now);
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Retune timers live. New values apply from the next timer reset /
   * heartbeat cycle; the currently armed deadline is left alone.
   */
  setTiming(timing: Partial<RaftTimingOptions>): void {
    this.timing = { ...this.timing, ...timing };
  }

  snapshot(): RaftNodeSnapshot<C> {
    return {
      id: this.id,
      role: this.role,
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      log: this.log,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      knownLeader: this.knownLeader,
      peers: [...this.peers],
      stopped: this.stopped,
      electionDeadline: this.electionDeadline,
      electionTimeoutSpan: this.electionTimeoutSpan,
      heartbeatDue: this.heartbeatDue,
      votesGranted: [...this.votesGranted],
      nextIndex: this.role === "leader" ? Object.fromEntries(this.nextIndex) : null,
      matchIndex: this.role === "leader" ? Object.fromEntries(this.matchIndex) : null,
    };
  }

  // -------------------------------------------------------------------------
  // RPC handlers
  // -------------------------------------------------------------------------

  private handleRequestVote(req: RequestVoteRequest, now: number, step: Step<C>): void {
    const deny = (reason: string): void => {
      step.events.push({ type: "deniedVote", to: req.from, term: this.currentTerm, reason });
      step.messages.push(this.voteResponse(req.from, false));
    };

    if (req.term < this.currentTerm) {
      deny(`stale term ${req.term} < ${this.currentTerm}`);
      return;
    }

    // Election restriction (§5.4.1): only vote for logs at least as up-to-date.
    const myLastTerm = this.lastLogTerm();
    const myLastIndex = this.lastLogIndex();
    const logOk =
      req.lastLogTerm > myLastTerm ||
      (req.lastLogTerm === myLastTerm && req.lastLogIndex >= myLastIndex);

    if (!logOk) {
      deny(
        `candidate log (term ${req.lastLogTerm}, idx ${req.lastLogIndex}) ` +
          `behind mine (term ${myLastTerm}, idx ${myLastIndex})`,
      );
      return;
    }
    if (this.votedFor !== null && this.votedFor !== req.from) {
      deny(`already voted for ${this.votedFor} in term ${this.currentTerm}`);
      return;
    }

    this.votedFor = req.from;
    this.resetElectionTimer(now);
    step.events.push({ type: "grantedVote", to: req.from, term: this.currentTerm });
    step.messages.push(this.voteResponse(req.from, true));
  }

  private handleRequestVoteResponse(resp: RequestVoteResponse, now: number, step: Step<C>): void {
    if (this.role !== "candidate" || resp.term < this.currentTerm) return;
    if (!resp.granted) return;

    this.votesGranted.add(resp.from);
    step.events.push({ type: "receivedVote", from: resp.from, term: this.currentTerm });

    if (this.votesGranted.size >= this.quorum()) {
      this.becomeLeader(now, step);
    }
  }

  private handleAppendEntries(req: AppendEntriesRequest<C>, now: number, step: Step<C>): void {
    if (req.term < this.currentTerm) {
      step.events.push({
        type: "rejectedAppend",
        fromLeader: req.from,
        reason: `stale term ${req.term} < ${this.currentTerm}`,
      });
      step.messages.push(this.appendResponse(req.from, false, 0, 0));
      return;
    }

    // Equal term + AppendEntries means a legitimate leader exists.
    if (this.role === "candidate") {
      this.becomeFollower(req.term, `leader ${req.from} elected for term ${req.term}`, now, step);
    }
    this.knownLeader = req.from;
    this.resetElectionTimer(now);

    // Consistency check (§5.3): our log must contain prevLogIndex@prevLogTerm.
    if (req.prevLogIndex > 0) {
      const prev = this.entryAt(req.prevLogIndex);
      if (!prev || prev.term !== req.prevLogTerm) {
        // Fast backup hint: skip the leader straight past the conflict
        // instead of letting it probe back one entry per round trip.
        let conflictIndex: number;
        if (!prev) {
          conflictIndex = this.lastLogIndex() + 1;
        } else {
          conflictIndex = req.prevLogIndex;
          while (conflictIndex > 1 && this.termAt(conflictIndex - 1) === prev.term) {
            conflictIndex -= 1;
          }
        }
        step.events.push({
          type: "rejectedAppend",
          fromLeader: req.from,
          reason: prev
            ? `log mismatch at index ${req.prevLogIndex}: have term ${prev.term}, leader says ${req.prevLogTerm}`
            : `missing entry at index ${req.prevLogIndex}`,
        });
        step.messages.push(this.appendResponse(req.from, false, 0, conflictIndex));
        return;
      }
    }

    // Append entries, truncating on the first conflict.
    let appended = 0;
    let firstNewIndex = 0;
    for (const entry of req.entries) {
      const existing = this.entryAt(entry.index);
      if (existing && existing.term !== entry.term) {
        this.log = this.log.slice(0, entry.index - 1);
        step.events.push({ type: "truncatedLog", fromIndex: entry.index });
      }
      if (!this.entryAt(entry.index)) {
        this.log = [...this.log, entry];
        appended += 1;
        if (firstNewIndex === 0) firstNewIndex = entry.index;
      }
    }
    if (appended > 0) {
      step.events.push({
        type: "appendedEntries",
        fromLeader: req.from,
        count: appended,
        firstIndex: firstNewIndex,
      });
    }

    // Advance commit index from the leader's.
    const lastNewIndex = req.prevLogIndex + req.entries.length;
    if (req.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(req.leaderCommit, lastNewIndex);
      this.applyCommitted(step);
    }

    step.messages.push(this.appendResponse(req.from, true, lastNewIndex, 0));
  }

  private handleAppendEntriesResponse(resp: AppendEntriesResponse, step: Step<C>): void {
    if (this.role !== "leader" || resp.term < this.currentTerm) return;
    if (!this.peers.includes(resp.from)) return;

    if (resp.success) {
      const match = Math.max(this.matchIndex.get(resp.from) ?? 0, resp.matchIndex);
      this.matchIndex.set(resp.from, match);
      this.nextIndex.set(resp.from, match + 1);
      this.tryAdvanceCommit(step);
    } else {
      // Back up and probe again (§5.3) — jumping straight to the
      // follower's conflict hint when it gave one, otherwise one entry.
      const current = this.nextIndex.get(resp.from) ?? 1;
      const hinted = resp.conflictIndex > 0 ? resp.conflictIndex : current - 1;
      const next = Math.max(1, Math.min(hinted, current - 1));
      this.nextIndex.set(resp.from, next);
      step.messages.push(this.buildAppendEntries(resp.from));
    }
  }

  // -------------------------------------------------------------------------
  // Role transitions
  // -------------------------------------------------------------------------

  private startElection(now: number, step: Step<C>): void {
    this.role = "candidate";
    this.currentTerm += 1;
    this.votedFor = this.id;
    this.knownLeader = null;
    this.votesGranted = new Set([this.id]);
    this.resetElectionTimer(now);

    step.events.push({ type: "electionTimeout", term: this.currentTerm });
    step.events.push({ type: "becameCandidate", term: this.currentTerm });

    if (this.votesGranted.size >= this.quorum()) {
      // Single-node cluster: win immediately.
      this.becomeLeader(now, step);
      return;
    }

    for (const peer of this.peers) {
      step.messages.push({
        kind: "RequestVote",
        term: this.currentTerm,
        from: this.id,
        to: peer,
        lastLogIndex: this.lastLogIndex(),
        lastLogTerm: this.lastLogTerm(),
      });
    }
  }

  private becomeLeader(now: number, step: Step<C>): void {
    this.role = "leader";
    this.knownLeader = this.id;
    this.heartbeatDue = now + this.timing.heartbeatInterval;
    this.electionDeadline = Number.POSITIVE_INFINITY;
    this.nextIndex = new Map(this.peers.map((p) => [p, this.lastLogIndex() + 1]));
    this.matchIndex = new Map(this.peers.map((p) => [p, 0]));

    step.events.push({ type: "becameLeader", term: this.currentTerm });

    // Announce leadership immediately with empty heartbeats.
    for (const peer of this.peers) {
      step.messages.push(this.buildAppendEntries(peer));
    }
  }

  private becomeFollower(term: number, reason: string, now: number, step: Step<C>): void {
    const roleChanged = this.role !== "follower";
    const wasLeader = this.role === "leader";

    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
    }
    this.role = "follower";
    this.heartbeatDue = null;
    this.votesGranted = new Set();

    // A deposed leader has no live election timer; give it a fresh one.
    if (wasLeader || !Number.isFinite(this.electionDeadline)) {
      this.resetElectionTimer(now);
    }

    if (roleChanged) {
      step.events.push({ type: "becameFollower", term: this.currentTerm, reason });
    }
  }

  // -------------------------------------------------------------------------
  // Commit machinery
  // -------------------------------------------------------------------------

  private tryAdvanceCommit(step: Step<C>): void {
    if (this.role !== "leader") return;

    for (let n = this.lastLogIndex(); n > this.commitIndex; n -= 1) {
      // Commit restriction (§5.4.2): only count replicas for current-term entries.
      if (this.termAt(n) !== this.currentTerm) break;

      let replicas = 1; // self
      for (const peer of this.peers) {
        if ((this.matchIndex.get(peer) ?? 0) >= n) replicas += 1;
      }
      if (replicas >= this.quorum()) {
        this.commitIndex = n;
        this.applyCommitted(step);
        break;
      }
    }
  }

  /** Emit every entry in (lastApplied, commitIndex] exactly once. */
  private applyCommitted(step: Step<C>): void {
    if (this.commitIndex <= this.lastApplied) return;
    for (let i = this.lastApplied + 1; i <= this.commitIndex; i += 1) {
      const entry = this.entryAt(i);
      if (entry) step.committed.push(entry);
    }
    this.lastApplied = this.commitIndex;
    step.events.push({ type: "advancedCommit", commitIndex: this.commitIndex });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildAppendEntries(peer: NodeId): AppendEntriesRequest<C> {
    const next = this.nextIndex.get(peer) ?? this.lastLogIndex() + 1;
    const prevLogIndex = next - 1;
    return {
      kind: "AppendEntries",
      term: this.currentTerm,
      from: this.id,
      to: peer,
      prevLogIndex,
      prevLogTerm: this.termAt(prevLogIndex),
      entries: this.log.slice(next - 1),
      leaderCommit: this.commitIndex,
    };
  }

  private voteResponse(to: NodeId, granted: boolean): RequestVoteResponse {
    return { kind: "RequestVoteResponse", term: this.currentTerm, from: this.id, to, granted };
  }

  private appendResponse(
    to: NodeId,
    success: boolean,
    matchIndex: number,
    conflictIndex: number,
  ): AppendEntriesResponse {
    return {
      kind: "AppendEntriesResponse",
      term: this.currentTerm,
      from: this.id,
      to,
      success,
      matchIndex,
      conflictIndex,
    };
  }

  private entryAt(index: number): LogEntry<C> | undefined {
    return this.log[index - 1];
  }

  private termAt(index: number): number {
    if (index === 0) return 0;
    return this.entryAt(index)?.term ?? 0;
  }

  private lastLogIndex(): number {
    return this.log.length;
  }

  private lastLogTerm(): number {
    return this.termAt(this.log.length);
  }

  private quorum(): number {
    return Math.floor((this.peers.length + 1) / 2) + 1;
  }

  private randomElectionTimeout(): number {
    const { electionTimeoutMin: min, electionTimeoutMax: max } = this.timing;
    return min + this.rng() * (max - min);
  }

  private resetElectionTimer(now: number): void {
    this.electionTimeoutSpan = this.randomElectionTimeout();
    this.electionDeadline = now + this.electionTimeoutSpan;
  }
}
