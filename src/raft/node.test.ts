import { describe, expect, it } from "vite-plus/test";
import { RaftNode } from "./node.ts";
import type { LogEntry, NodeId, RaftMessage } from "./types.ts";

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATENCY = 10;

/**
 * Minimal deterministic cluster harness for testing the library.
 * (The full visualization simulator lives in src/sim — this one is
 * intentionally tiny and test-only.)
 */
class TestCluster {
  readonly nodes = new Map<NodeId, RaftNode<string>>();
  readonly committed = new Map<NodeId, LogEntry<string>[]>();
  readonly isolated = new Set<NodeId>();
  now = 0;

  private inFlight: { deliverAt: number; seq: number; msg: RaftMessage<string> }[] = [];
  private seq = 0;

  constructor(ids: NodeId[], seed = 42) {
    for (const [i, id] of ids.entries()) {
      const peers = ids.filter((p) => p !== id);
      this.nodes.set(
        id,
        new RaftNode<string>({ id, peers, now: 0, rng: mulberry32(seed + i * 1000) }),
      );
      this.committed.set(id, []);
    }
  }

  node(id: NodeId): RaftNode<string> {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  absorb(
    id: NodeId,
    step: { messages: readonly RaftMessage<string>[]; committed: readonly LogEntry<string>[] },
  ): void {
    for (const msg of step.messages) {
      this.inFlight.push({ deliverAt: this.now + LATENCY, seq: this.seq++, msg });
    }
    this.committed.get(id)?.push(...step.committed);
  }

  /** Process the single next event. Returns false when nothing is scheduled. */
  stepOnce(maxTime: number): boolean {
    let nextDelivery: { deliverAt: number; seq: number } | null = null;
    for (const f of this.inFlight) {
      if (!nextDelivery || f.deliverAt < nextDelivery.deliverAt) nextDelivery = f;
    }
    let nextWake: { at: number; id: NodeId } | null = null;
    for (const [id, n] of this.nodes) {
      const at = n.nextWakeAt();
      if (at !== null && Number.isFinite(at) && (!nextWake || at < nextWake.at)) {
        nextWake = { at, id };
      }
    }

    const deliveryAt = nextDelivery?.deliverAt ?? Number.POSITIVE_INFINITY;
    const wakeAt = nextWake?.at ?? Number.POSITIVE_INFINITY;
    const t = Math.min(deliveryAt, wakeAt);
    if (!Number.isFinite(t) || t > maxTime) return false;
    this.now = t;

    if (deliveryAt <= wakeAt && nextDelivery) {
      const idx = this.inFlight.findIndex((f) => f.seq === nextDelivery.seq);
      const [flight] = this.inFlight.splice(idx, 1);
      if (!flight) return true;
      const { msg } = flight;
      if (this.isolated.has(msg.from) || this.isolated.has(msg.to)) return true;
      const target = this.nodes.get(msg.to);
      if (!target) return true;
      this.absorb(msg.to, target.receive(msg, this.now));
    } else if (nextWake) {
      this.absorb(nextWake.id, this.node(nextWake.id).tick(this.now));
    }
    return true;
  }

  runUntil(pred: () => boolean, maxTime = 60_000): boolean {
    while (this.now <= maxTime) {
      if (pred()) return true;
      if (!this.stepOnce(maxTime)) return pred();
    }
    return pred();
  }

  run(duration: number): void {
    const end = this.now + duration;
    while (this.stepOnce(end)) {
      /* drain */
    }
    this.now = end;
  }

  leaders(): NodeId[] {
    return [...this.nodes.values()]
      .filter((n) => !n.isStopped() && n.snapshot().role === "leader")
      .map((n) => n.id);
  }

  leader(): RaftNode<string> | null {
    const ids = this.leaders();
    if (ids.length !== 1) return null;
    const id = ids[0];
    return id ? this.node(id) : null;
  }

  /**
   * True when exactly one live node leads AND every live node follows it in
   * the same term. Rules out stale leaders that haven't stepped down yet.
   */
  hasStableLeader(): boolean {
    const ids = this.leaders();
    if (ids.length !== 1) return false;
    const leaderId = ids[0];
    if (!leaderId) return false;
    const term = this.node(leaderId).snapshot().currentTerm;
    return [...this.nodes.values()]
      .filter((n) => !n.isStopped() && !this.isolated.has(n.id))
      .every((n) => {
        const s = n.snapshot();
        return s.knownLeader === leaderId && s.currentTerm === term;
      });
  }

  propose(command: string): boolean {
    const leader = this.leader();
    if (!leader) return false;
    return this.proposeVia(leader.id, command);
  }

  proposeVia(id: NodeId, command: string): boolean {
    const result = this.node(id).propose(command, this.now);
    if (!result.accepted) return false;
    this.absorb(id, result.step);
    return true;
  }
}

describe("leader election", () => {
  it("elects exactly one leader in a 3-node cluster", () => {
    const c = new TestCluster(["a", "b", "c"]);
    expect(c.runUntil(() => c.leaders().length === 1)).toBe(true);
    expect(c.leaders()).toHaveLength(1);
    const leader = c.leader();
    expect(leader).not.toBeNull();
    expect(leader?.snapshot().currentTerm).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic for a given seed", () => {
    const run = (): { id: NodeId; term: number; time: number } => {
      const c = new TestCluster(["a", "b", "c"], 7);
      c.runUntil(() => c.leaders().length === 1);
      const leader = c.leader();
      if (!leader) throw new Error("no leader");
      return { id: leader.id, term: leader.snapshot().currentTerm, time: c.now };
    };
    expect(run()).toEqual(run());
  });

  it("a single-node cluster elects itself immediately", () => {
    const c = new TestCluster(["solo"]);
    expect(c.runUntil(() => c.leaders().length === 1, 1000)).toBe(true);
    expect(c.leader()?.id).toBe("solo");
  });

  it("elects a new leader after the old one crashes", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    const old = c.leader();
    if (!old) throw new Error("no leader");
    const oldTerm = old.snapshot().currentTerm;
    old.stop();

    expect(c.runUntil(() => c.leaders().length === 1)).toBe(true);
    const fresh = c.leader();
    expect(fresh?.id).not.toBe(old.id);
    expect(fresh && fresh.snapshot().currentTerm).toBeGreaterThan(oldTerm);
  });

  it("a rejoining ex-leader steps down to follower", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    const old = c.leader();
    if (!old) throw new Error("no leader");
    old.stop();
    c.runUntil(() => c.leaders().length === 1 && c.leader()?.id !== old.id);

    old.restart(c.now);
    expect(
      c.runUntil(() => {
        const s = old.snapshot();
        return s.role === "follower" && s.knownLeader !== null && s.knownLeader !== old.id;
      }),
    ).toBe(true);
  });

  it("denies votes to candidates with stale logs (§5.4.1)", () => {
    const voter = new RaftNode<string>({ id: "v", peers: ["c"], now: 0, rng: mulberry32(1) });
    // Give the voter a log entry at term 2.
    voter.receive(
      {
        kind: "AppendEntries",
        term: 2,
        from: "c",
        to: "v",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [{ term: 2, index: 1, command: "x" }],
        leaderCommit: 0,
      },
      0,
    );
    // Candidate with an empty log at a newer term must be refused.
    const out = voter.receive(
      {
        kind: "RequestVote",
        term: 3,
        from: "c",
        to: "v",
        lastLogIndex: 0,
        lastLogTerm: 0,
      },
      10,
    );
    const resp = out.messages.find((m) => m.kind === "RequestVoteResponse");
    expect(resp && resp.kind === "RequestVoteResponse" && resp.granted).toBe(false);
  });

  it("votes at most once per term", () => {
    const voter = new RaftNode<string>({
      id: "v",
      peers: ["c1", "c2"],
      now: 0,
      rng: mulberry32(1),
    });
    const ask = (from: NodeId): boolean => {
      const out = voter.receive(
        { kind: "RequestVote", term: 5, from, to: "v", lastLogIndex: 0, lastLogTerm: 0 },
        0,
      );
      const resp = out.messages[0];
      return resp?.kind === "RequestVoteResponse" && resp.granted;
    };
    expect(ask("c1")).toBe(true);
    expect(ask("c2")).toBe(false);
    expect(ask("c1")).toBe(true); // idempotent re-grant to the same candidate
  });
});

describe("log replication", () => {
  it("replicates and commits entries on every node, in order", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    expect(c.propose("set x=1")).toBe(true);
    expect(c.propose("set y=2")).toBe(true);

    expect(c.runUntil(() => [...c.committed.values()].every((list) => list.length === 2))).toBe(
      true,
    );

    for (const list of c.committed.values()) {
      expect(list.map((e) => e.command)).toEqual(["set x=1", "set y=2"]);
    }
  });

  it("does not commit without a quorum", () => {
    const c = new TestCluster(["a", "b", "c", "d", "e"]);
    c.runUntil(() => c.leaders().length === 1);
    const leader = c.leader();
    if (!leader) throw new Error("no leader");

    // Cut the leader off from all but one follower: 2 < quorum(3).
    const others = [...c.nodes.keys()].filter((id) => id !== leader.id);
    for (const id of others.slice(1)) c.isolated.add(id);

    c.propose("doomed");
    c.run(2000);
    expect(c.committed.get(leader.id)).toHaveLength(0);

    // Heal the partition and wait for a stable leader. "doomed" was never
    // committed, so Raft makes no promise it survives — the empty-logged
    // ex-isolated majority may legally elect a leader that truncates it.
    // What MUST hold: the cluster recovers and commits new entries.
    c.isolated.clear();
    expect(c.runUntil(() => c.hasStableLeader(), 120_000)).toBe(true);
    expect(c.propose("after-heal")).toBe(true);

    const freshLeader = c.leader();
    if (!freshLeader) throw new Error("no leader");
    expect(
      c.runUntil(
        () => (c.committed.get(freshLeader.id) ?? []).some((e) => e.command === "after-heal"),
        240_000,
      ),
    ).toBe(true);

    // If "doomed" did survive, it must have committed before "after-heal".
    const list = c.committed.get(freshLeader.id) ?? [];
    const doomedAt = list.findIndex((e) => e.command === "doomed");
    const healAt = list.findIndex((e) => e.command === "after-heal");
    if (doomedAt !== -1) expect(doomedAt).toBeLessThan(healAt);
  });

  it("overwrites conflicting uncommitted entries from a deposed leader", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    const old = c.leader();
    if (!old) throw new Error("no leader");

    // Isolate the leader, then let it accept entries it can never commit.
    c.isolated.add(old.id);
    const r1 = old.propose("orphan-1", c.now);
    const r2 = old.propose("orphan-2", c.now);
    expect(r1.accepted && r2.accepted).toBe(true);

    // The remaining majority elects a new leader and commits real entries.
    c.runUntil(() => c.leaders().filter((id) => id !== old.id).length === 1);
    const fresh = c.leaders().find((id) => id !== old.id);
    if (!fresh) throw new Error("no fresh leader");
    expect(c.proposeVia(fresh, "survivor")).toBe(true);
    expect(c.runUntil(() => (c.committed.get(fresh)?.length ?? 0) >= 1, 120_000)).toBe(true);

    // Heal: the old leader must discard its orphans and adopt the new log.
    c.isolated.delete(old.id);
    expect(
      c.runUntil(() => {
        const s = old.snapshot();
        return (
          s.role === "follower" &&
          s.log.some((e) => e.command === "survivor") &&
          !s.log.some((e) => e.command.startsWith("orphan"))
        );
      }, 120_000),
    ).toBe(true);

    // Orphaned entries were never reported as committed by anyone.
    for (const list of c.committed.values()) {
      expect(list.every((e) => !e.command.startsWith("orphan"))).toBe(true);
    }
  });

  it("catches up a node that was down while entries were committed", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    const leader = c.leader();
    if (!leader) throw new Error("no leader");
    const follower = [...c.nodes.values()].find((n) => n.id !== leader.id);
    if (!follower) throw new Error("no follower");

    follower.stop();
    c.propose("while-you-were-out");
    c.runUntil(() => (c.committed.get(leader.id)?.length ?? 0) === 1);

    follower.restart(c.now);
    expect(
      c.runUntil(() => {
        const s = follower.snapshot();
        return s.log.length === 1 && s.commitIndex === 1;
      }),
    ).toBe(true);
  });

  it("followers redirect proposals (not-leader)", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    const follower = [...c.nodes.values()].find((n) => n.snapshot().role === "follower");
    if (!follower) throw new Error("no follower");
    const result = follower.propose("nope", c.now);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("not-leader");
  });
});

describe("fast log backup", () => {
  it("a follower with a short log hints the leader where to resume", () => {
    const follower = new RaftNode<string>({ id: "f", peers: ["l"], now: 0, rng: mulberry32(1) });
    const out = follower.receive(
      {
        kind: "AppendEntries",
        term: 1,
        from: "l",
        to: "f",
        prevLogIndex: 5,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 0,
      },
      0,
    );
    const resp = out.messages[0];
    expect(resp?.kind).toBe("AppendEntriesResponse");
    if (resp?.kind === "AppendEntriesResponse") {
      expect(resp.success).toBe(false);
      // Empty log: tell the leader to start from index 1, not probe 5,4,3…
      expect(resp.conflictIndex).toBe(1);
    }
  });

  it("a conflicting term hints its first index", () => {
    const follower = new RaftNode<string>({ id: "f", peers: ["l"], now: 0, rng: mulberry32(1) });
    // Give the follower three entries from (stale) term 2.
    follower.receive(
      {
        kind: "AppendEntries",
        term: 2,
        from: "x",
        to: "f",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [
          { term: 2, index: 1, command: "a" },
          { term: 2, index: 2, command: "b" },
          { term: 2, index: 3, command: "c" },
        ],
        leaderCommit: 0,
      },
      0,
    );
    // New leader at term 4 expects term 3 at index 3 — conflict.
    const out = follower.receive(
      {
        kind: "AppendEntries",
        term: 4,
        from: "l",
        to: "f",
        prevLogIndex: 3,
        prevLogTerm: 3,
        entries: [],
        leaderCommit: 0,
      },
      10,
    );
    const resp = out.messages.find((m) => m.kind === "AppendEntriesResponse");
    if (resp?.kind === "AppendEntriesResponse") {
      expect(resp.success).toBe(false);
      // First index of the follower's conflicting term (2) is 1.
      expect(resp.conflictIndex).toBe(1);
    }
  });
});

describe("membership changes", () => {
  it("a freshly added node is caught up by the leader", () => {
    const c = new TestCluster(["a", "b", "c"]);
    c.runUntil(() => c.leaders().length === 1);
    c.propose("pre-join");
    c.runUntil(() => [...c.committed.values()].every((l) => l.length === 1));

    // Out-of-band reconfiguration: everyone learns about "d".
    const all = ["a", "b", "c", "d"];
    const d = new RaftNode<string>({
      id: "d",
      peers: ["a", "b", "c"],
      now: c.now,
      rng: mulberry32(99),
    });
    c.nodes.set("d", d);
    c.committed.set("d", []);
    for (const id of ["a", "b", "c"]) {
      c.absorb(id, c.node(id).setPeers(all.filter((p) => p !== id)));
    }

    expect(
      c.runUntil(() => {
        const s = d.snapshot();
        return s.commitIndex === 1 && s.log.some((e) => e.command === "pre-join");
      }),
    ).toBe(true);
  });
});
