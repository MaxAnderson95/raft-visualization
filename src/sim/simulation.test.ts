import { describe, expect, it } from "vite-plus/test";
import { Autopilot } from "./autopilot.ts";
import { RaftSimulation } from "./simulation.ts";

function lastFrame(sim: RaftSimulation) {
  const frame = sim.frames[sim.frames.length - 1];
  if (!frame) throw new Error("no frames");
  return frame;
}

describe("RaftSimulation", () => {
  it("elects a leader and records frames", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    expect(sim.leaderId()).not.toBeNull();
    expect(sim.frames.length).toBeGreaterThan(10);
    // Frames are time-ordered.
    for (let i = 1; i < sim.frames.length; i += 1) {
      expect(sim.frames[i]!.time).toBeGreaterThanOrEqual(sim.frames[i - 1]!.time);
    }
  });

  it("is deterministic for a given seed", () => {
    const run = (): string => {
      const sim = new RaftSimulation({ seed: 11 });
      sim.advanceTo(3000);
      const f = lastFrame(sim);
      return JSON.stringify({
        frames: sim.frames.length,
        leader: sim.leaderId(),
        terms: f.nodes.map((n) => n.currentTerm),
        logs: f.nodes.map((n) => n.log.length),
      });
    };
    expect(run()).toEqual(run());
  });

  it("replicates a SET to every node's key-value store", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    expect(sim.propose({ op: "set", key: "color", value: "teal" })).toBe(true);
    sim.advanceTo(4000);

    const f = lastFrame(sim);
    for (const id of sim.nodeIds()) {
      expect(f.kv.get(id)?.get("color")).toBe("teal");
    }
  });

  it("commits a no-op after election so the log is never stuck", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    const f = lastFrame(sim);
    const leader = f.nodes.find((n) => n.role === "leader");
    expect(leader).toBeDefined();
    expect(leader!.log.some((e) => e.command.op === "noop")).toBe(true);
    expect(leader!.commitIndex).toBeGreaterThanOrEqual(1);
  });

  it("frameAt finds the right frame", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    const mid = sim.frames[Math.floor(sim.frames.length / 2)]!;
    expect(sim.frameAt(mid.time).time).toBe(mid.time);
    expect(sim.frameAt(mid.time + 0.0001).time).toBeGreaterThanOrEqual(mid.time);
    expect(sim.frameAt(0).time).toBe(0);
    expect(sim.frameAt(99_999).time).toBe(lastFrame(sim).time);
  });

  it("forkAt truncates the future and produces a divergent but valid run", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(3000);
    const framesBefore = sim.frames.length;

    sim.forkAt(1500);
    expect(sim.frames.length).toBeLessThan(framesBefore);
    expect(sim.duration).toBeLessThanOrEqual(1500);
    expect(lastFrame(sim).time).toBe(sim.duration);

    sim.advanceTo(4000);
    expect(sim.leaderId()).not.toBeNull();
  });

  it("a stopped node loses leadership; a restarted node rebuilds its store", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    sim.propose({ op: "set", key: "k", value: "1" });
    sim.advanceTo(2500);

    const victim = sim.leaderId();
    expect(victim).not.toBeNull();
    sim.stopNode(victim!);
    sim.advanceTo(4500);

    const newLeader = sim.leaderId();
    expect(newLeader).not.toBeNull();
    expect(newLeader).not.toBe(victim);

    sim.restartNode(victim!);
    sim.advanceTo(7000);
    const f = lastFrame(sim);
    expect(f.kv.get(victim!)?.get("k")).toBe("1");
    expect(f.nodes.find((n) => n.id === victim)?.role).toBe("follower");
  });

  it("added nodes catch up; removed nodes disappear", () => {
    const sim = new RaftSimulation({ seed: 3, nodeCount: 3 });
    sim.advanceTo(2000);
    sim.propose({ op: "set", key: "joined", value: "late" });
    sim.advanceTo(2500);

    const added = sim.addNode();
    expect(sim.nodeIds()).toHaveLength(4);
    sim.advanceTo(5000);
    expect(lastFrame(sim).kv.get(added)?.get("joined")).toBe("late");

    expect(sim.removeNode(added)).toBe(true);
    expect(sim.nodeIds()).toHaveLength(3);
    sim.advanceTo(6000);
    expect(sim.leaderId()).not.toBeNull();
  });

  it("survives removing the leader", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    const leader = sim.leaderId();
    expect(leader).not.toBeNull();
    sim.removeNode(leader!);
    sim.advanceTo(5000);
    const fresh = sim.leaderId();
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(leader);
  });

  it("a node added behind a long log catches up in a few round trips", () => {
    const sim = new RaftSimulation({ seed: 3, nodeCount: 3 });
    sim.advanceTo(2000);
    // Build a long committed history.
    for (let i = 0; i < 30; i += 1) {
      sim.propose({ op: "set", key: `k${i}`, value: String(i) });
      sim.advanceTo(sim.duration + 60);
    }
    const leaderCommit = lastFrame(sim).nodes.find((n) => n.role === "leader")?.commitIndex ?? 0;
    expect(leaderCommit).toBeGreaterThanOrEqual(30);

    // With one-entry-per-RTT backup this would need ~30 round trips
    // (≈2000ms); the conflict hint should land it in a handful.
    const added = sim.addNode();
    const joinedAt = sim.duration;
    sim.advanceTo(joinedAt + 1000);
    const snap = lastFrame(sim).nodes.find((n) => n.id === added);
    expect(snap?.commitIndex).toBeGreaterThanOrEqual(leaderCommit);
  });

  it("total packet loss prevents consensus; healing restores it", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.network.loss = 1;
    sim.advanceTo(3000);
    expect(sim.leaderId()).toBeNull();

    sim.network.loss = 0;
    sim.advanceTo(8000);
    expect(sim.leaderId()).not.toBeNull();
  });

  it("reset keeps the cluster shape, wipes history, and triggers a new election", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(3000);
    sim.propose({ op: "set", key: "old", value: "data" });
    sim.advanceTo(4000);

    expect(sim.leaderId()).not.toBeNull();
    const follower = sim.nodeIds().find((id) => id !== sim.leaderId());
    sim.stopNode(follower!);
    sim.advanceTo(4200);

    sim.reset();
    expect(sim.duration).toBe(0);
    expect(sim.frames).toHaveLength(1);
    expect(sim.frames[0]!.cause.kind).toBe("reset");
    expect(sim.nodeIds()).toHaveLength(5);
    // Nobody leads until the cluster elects fresh.
    expect(sim.leaderId()).toBeNull();

    const frame = sim.frames[0]!;
    for (const node of frame.nodes) {
      expect(node.role).toBe("follower");
      expect(node.currentTerm).toBe(0);
      expect(node.votedFor).toBeNull();
      expect(node.log).toHaveLength(0);
      expect(node.commitIndex).toBe(0);
      expect(frame.kv.get(node.id)?.size).toBe(0);
      expect(node.stopped).toBe(node.id === follower);
    }

    // A fresh election runs and the new leader commits new writes.
    sim.advanceTo(2000);
    const leader = sim.leaderId();
    expect(leader).not.toBeNull();
    expect(sim.propose({ op: "set", key: "new", value: "era" })).toBe(true);
    sim.advanceTo(4000);
    const after = sim.frames[sim.frames.length - 1]!;
    expect(after.kv.get(leader!)?.get("new")).toBe("era");
    expect(after.kv.get(leader!)?.has("old")).toBe(false);
  });

  it("the opening election starts mostly elapsed, on load and after reset", () => {
    const sim = new RaftSimulation({ seed: 3 });
    const boostCeiling = sim.electionTimeoutMax - sim.electionTimeoutMin * 0.75;

    const initial = sim.frames[0]!.nodes.map((n) => n.electionDeadline);
    expect(Math.max(...initial)).toBeLessThanOrEqual(boostCeiling);

    sim.advanceTo(2000);
    sim.reset();
    const afterReset = sim.frames[0]!.nodes.map((n) => n.electionDeadline);
    expect(Math.max(...afterReset)).toBeLessThanOrEqual(boostCeiling);

    // And it still produces a working cluster.
    sim.advanceTo(1000);
    expect(sim.leaderId()).not.toBeNull();
  });

  it("chaos crashes leaders even with autopilot disabled", () => {
    const sim = new RaftSimulation({ seed: 3 });
    const autopilot = new Autopilot(sim, { seed: 9 });
    expect(autopilot.enabled).toBe(false);
    autopilot.chaos = true;
    autopilot.armChaosSoon();

    // Drive like the app does: advance, then let the autopilot act.
    let crashed = false;
    let restarted = false;
    for (let t = 100; t <= 10_000; t += 100) {
      sim.advanceTo(t);
      autopilot.step();
      for (const frame of sim.frames) {
        if (frame.cause.kind === "nodeStopped") crashed = true;
        if (frame.cause.kind === "nodeRestarted") restarted = true;
      }
      if (crashed && restarted) break;
    }
    expect(crashed).toBe(true);
    expect(restarted).toBe(true);
  });

  it("a partition splits the ring into two contiguous, complete arcs", () => {
    const sim = new RaftSimulation({ seed: 5, nodeCount: 7 });
    sim.advanceTo(2000);

    const part = sim.partition(1 / 3);
    expect(part).not.toBeNull();
    // floor(7 / 3) = 2 split away into the minority.
    expect(part!.groupA).toHaveLength(2);
    expect(part!.groupB).toHaveLength(5);
    // Every node assigned exactly once.
    expect(new Set([...part!.groupA, ...part!.groupB]).size).toBe(7);

    // Group A is one contiguous run around the ring (exactly two boundaries).
    const order = sim.nodeIds().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const inA = order.map((id) => part!.groupA.includes(id));
    let boundaries = 0;
    for (let i = 0; i < order.length; i += 1) {
      if (inA[i] !== inA[(i + 1) % order.length]) boundaries += 1;
    }
    expect(boundaries).toBe(2);
  });

  it("the fraction sets how many nodes are split away", () => {
    const sim = new RaftSimulation({ seed: 1, nodeCount: 8 });
    expect(sim.partition(1 / 2)!.groupA).toHaveLength(4);
    sim.healPartition();
    expect(sim.partition(1 / 3)!.groupA).toHaveLength(2);
    sim.healPartition();
    expect(sim.partition(1 / 4)!.groupA).toHaveLength(2);
  });

  it("the majority side makes progress while the minority is starved", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    expect(sim.leaderId()).not.toBeNull();

    const part = sim.partition(1 / 2)!;
    const majority = part.groupB.length >= part.groupA.length ? part.groupB : part.groupA;
    const minority = majority === part.groupB ? part.groupA : part.groupB;
    sim.advanceTo(6000);

    // The majority converges on a single leader; the minority can't (no quorum).
    const f = lastFrame(sim);
    const role = (id: string): string => f.nodes.find((n) => n.id === id)!.role;
    expect(majority.filter((id) => role(id) === "leader")).toHaveLength(1);

    // A write reaches every majority node and no minority node.
    expect(sim.propose({ op: "set", key: "side", value: "majority" })).toBe(true);
    sim.advanceTo(sim.duration + 2000);
    const g = lastFrame(sim);
    for (const id of majority) expect(g.kv.get(id)?.get("side")).toBe("majority");
    for (const id of minority) expect(g.kv.get(id)?.get("side")).toBeUndefined();
  });

  it("healing a partition reunifies the cluster on one leader", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    sim.partition(1 / 3);
    sim.advanceTo(7000);

    expect(sim.healPartition()).toBe(true);
    sim.advanceTo(13000);

    const f = lastFrame(sim);
    expect(f.nodes.filter((n) => n.role === "leader" && !n.stopped)).toHaveLength(1);

    // The real convergence proof: a fresh write now reaches every node.
    expect(sim.propose({ op: "set", key: "k", value: "healed" })).toBe(true);
    sim.advanceTo(sim.duration + 3000);
    const g = lastFrame(sim);
    for (const id of sim.nodeIds()) expect(g.kv.get(id)?.get("k")).toBe("healed");
  });

  it("partition state lives in the timeline (fork before it = gone)", () => {
    const sim = new RaftSimulation({ seed: 3 });
    sim.advanceTo(2000);
    sim.partition(1 / 2);
    sim.advanceTo(4000);
    expect(sim.activePartition).not.toBeNull();
    expect(lastFrame(sim).partition).not.toBeNull();

    sim.forkAt(1000);
    expect(sim.activePartition).toBeNull();
    expect(lastFrame(sim).partition).toBeNull();
  });

  it("reset and node removal heal an active partition", () => {
    const sim = new RaftSimulation({ seed: 7, nodeCount: 3 });
    sim.advanceTo(2000);

    const part = sim.partition(1 / 3)!;
    expect(part.groupA).toHaveLength(1);
    sim.removeNode(part.groupA[0]!);
    // The isolated side emptied out, so the split heals.
    expect(sim.activePartition).toBeNull();

    sim.partition(1 / 2);
    expect(sim.activePartition).not.toBeNull();
    sim.reset();
    expect(sim.activePartition).toBeNull();
    expect(lastFrame(sim).partition).toBeNull();
  });

  it("trims history beyond maxFrames but keeps the live edge consistent", () => {
    const sim = new RaftSimulation({ seed: 3, maxFrames: 200 });
    sim.advanceTo(10_000);
    expect(sim.frames.length).toBeLessThanOrEqual(200);
    expect(sim.horizon).toBeGreaterThan(0);
    expect(lastFrame(sim).nodes).toHaveLength(5);
  });
});
