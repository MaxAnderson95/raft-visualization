/**
 * Playback controller: owns the playhead, speed, pause state, and the
 * boundary between *replaying recorded history* and *simulating live*.
 *
 * - Scrubbing back is pure playback: the recorded future stays intact.
 * - Intervening while in the past forks the timeline: the future you saw
 *   is discarded and the simulation diverges from that moment.
 */

import { DEFAULT_TIMING } from "./raft/index.ts";
import type { NodeId } from "./raft/index.ts";
import { Autopilot, RaftSimulation } from "./sim/index.ts";
import type { Frame, KVCommand, MessageFlight } from "./sim/index.ts";
import type { FlightKind } from "./theme.ts";
import type { FlightView, FxSpawn, NodeLogCell, NodeView, RenderView } from "./viz/types.ts";

export const MIN_SPEED = 0.001;
export const MAX_SPEED = 1;
export const DEFAULT_SPEED = 0.01;
const LIVE_EPSILON = 0.001;
/** Entries shown in the mini log strip under each node. */
const NODE_STRIP_WINDOW = 8;

export class App {
  readonly sim: RaftSimulation;
  readonly autopilot: Autopilot;

  playhead = 0;
  speed = DEFAULT_SPEED;
  paused = false;
  selected: NodeId | null = null;
  /** Id of a message comet the user is inspecting (freezes the sim), or null. */
  selectedFlight: number | null = null;

  onToast: (message: string) => void = () => {};

  /** True when inspecting a message forced the pause, so closing can resume. */
  private pausedByInspect = false;

  private lastFxTime = 0;
  private pendingFx: FxSpawn[] = [];
  private fxEpoch = 0;

  constructor(seed: number) {
    this.sim = new RaftSimulation({ seed, nodeCount: 5 });
    this.autopilot = new Autopilot(this.sim, { seed: seed ^ 0x5f5f });
  }

  get live(): boolean {
    return this.playhead >= this.sim.duration - LIVE_EPSILON;
  }

  /** Advance wall time by `dt` seconds. */
  tick(dt: number): void {
    if (this.paused) return;
    this.playhead += dt * 1000 * this.speed;

    if (this.playhead > this.sim.duration) {
      this.sim.advanceTo(this.playhead);
      this.autopilot.step();
    }
    this.collectFx();
  }

  frame(): Frame {
    return this.sim.frameAt(this.playhead);
  }

  /** Build the scene's view of the world at the playhead. */
  renderView(): RenderView {
    const frame = this.frame();
    const t = this.playhead;

    // Mini log strips share one window so cells align across nodes,
    // mirroring the replicated-log matrix.
    let maxLen = 0;
    for (const snap of frame.nodes) maxLen = Math.max(maxLen, snap.log.length);
    const stripStart = Math.max(0, maxLen - NODE_STRIP_WINDOW);

    const nodes: NodeView[] = [...frame.nodes]
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
      .map((snap) => {
        const logCells: (NodeLogCell | null)[] = [];
        for (let index = stripStart + 1; index <= maxLen; index += 1) {
          const entry = snap.log[index - 1];
          logCells.push(entry ? { term: entry.term, committed: index <= snap.commitIndex } : null);
        }
        return {
          id: snap.id,
          role: snap.role,
          stopped: snap.stopped,
          term: snap.currentTerm,
          timerFraction:
            snap.stopped || snap.role === "leader" || !Number.isFinite(snap.electionDeadline)
              ? null
              : Math.min(1, Math.max(0, (snap.electionDeadline - t) / snap.electionTimeoutSpan)),
          selected: snap.id === this.selected,
          logCells,
        };
      });

    const flights: FlightView[] = frame.inFlight
      .filter((f) => f.sentAt <= t && t < f.deliverAt)
      .map((f) => ({
        id: f.id,
        kind: flightKind(f.message),
        from: f.message.from,
        to: f.message.to,
        // Lost packets die at deliverAt having covered only half the arc.
        progress: ((t - f.sentAt) / (f.deliverAt - f.sentAt)) * (f.lost ? 0.5 : 1),
        dying: f.lost === true,
        entryCount: entryCountOf(f.message),
      }));

    const fx = this.pendingFx;
    this.pendingFx = [];
    return {
      nodes,
      flights,
      fx,
      fxEpoch: this.fxEpoch,
      partition: frame.partition,
      selectedFlight: this.selectedFlight,
    };
  }

  // --------------------------------------------------------------- playback

  togglePause(): void {
    this.paused = !this.paused;
  }

  setSpeed(speed: number): void {
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  }

  scrub(t: number): void {
    const clamped = Math.min(Math.max(t, this.sim.horizon), this.sim.duration);
    if (clamped < this.playhead) {
      this.lastFxTime = clamped;
      this.pendingFx = [];
      this.fxEpoch += 1;
    }
    this.playhead = clamped;
  }

  goLive(): void {
    this.playhead = this.sim.duration;
    this.lastFxTime = this.playhead;
  }

  select(id: NodeId | null): void {
    this.selected = this.selected === id ? null : id;
  }

  /** Freeze on a message in flight and open its inspector. */
  inspectFlight(id: number): void {
    this.selectedFlight = id;
    if (!this.paused) {
      this.pausedByInspect = true;
      this.paused = true;
    }
  }

  /** Close the message inspector, resuming playback if inspecting paused it. */
  closeFlight(): void {
    this.selectedFlight = null;
    if (this.pausedByInspect) {
      this.paused = false;
      this.pausedByInspect = false;
    }
  }

  /** The in-flight message at the playhead with this id, if it still exists. */
  findFlight(id: number): MessageFlight | undefined {
    return this.frame().inFlight.find((f) => f.id === id);
  }

  // ----------------------------------------------------------- intervention

  proposeSet(key: string, value: string): boolean {
    return this.propose({ op: "set", key, value }, `SET ${key}`);
  }

  proposeDel(key: string): boolean {
    return this.propose({ op: "del", key }, `DEL ${key}`);
  }

  addNode(): void {
    this.ensureLive();
    const id = this.sim.addNode();
    this.onToast(`${id} joined the cluster`);
  }

  removeNode(id: NodeId): void {
    this.ensureLive();
    if (this.sim.removeNode(id)) {
      if (this.selected === id) this.selected = null;
      this.onToast(`${id} removed from the cluster`);
    } else {
      this.onToast("Can't remove the last node");
    }
  }

  /** Topbar counterpart to addNode: removes the newest member. */
  removeNewestNode(): void {
    let newest: NodeId | null = null;
    let best = -1;
    for (const id of this.sim.nodeIds()) {
      const ordinal = Number(id.slice(1));
      if (ordinal > best) {
        best = ordinal;
        newest = id;
      }
    }
    if (newest) this.removeNode(newest);
  }

  stopNode(id: NodeId): void {
    this.ensureLive();
    if (this.sim.stopNode(id)) this.onToast(`${id} crashed`);
  }

  /** Stopped node: bring it back. Running node: bounce it (crash + recover). */
  restartNode(id: NodeId): void {
    this.ensureLive();
    const snap = this.frame().nodes.find((n) => n.id === id);
    if (!snap) return;
    if (snap.stopped) {
      if (this.sim.restartNode(id)) this.onToast(`${id} is back up`);
    } else {
      this.sim.stopNode(id);
      this.sim.restartNode(id);
      this.onToast(`${id} restarted — rebuilding from its log`);
    }
  }

  /** Same cluster, fresh history: empty logs, blank timeline, new election. */
  reset(): void {
    this.sim.reset();
    this.sim.resetNetwork();
    this.sim.setTiming({ ...DEFAULT_TIMING });
    this.autopilot.rearm();
    this.autopilot.chaos = false;
    this.playhead = 0;
    this.lastFxTime = 0;
    this.pendingFx = [];
    this.fxEpoch += 1;
    this.onToast("Simulation reset — new election starting");
  }

  toggleAuto(): void {
    this.autopilot.enabled = !this.autopilot.enabled;
    this.onToast(this.autopilot.enabled ? "Autopilot on" : "Autopilot off");
  }

  toggleChaos(): void {
    this.autopilot.chaos = !this.autopilot.chaos;
    if (this.autopilot.chaos) this.autopilot.armChaosSoon();
    this.onToast(this.autopilot.chaos ? "Chaos on — leaders will crash" : "Chaos off");
  }

  /** Split the cluster into two groups (~fraction is isolated). */
  partition(fraction: number): void {
    this.ensureLive();
    const state = this.sim.partition(fraction);
    if (!state) {
      this.onToast("Need at least two nodes to split the network");
      return;
    }
    const leader = this.sim.leaderId();
    const isolated = leader !== null && state.groupA.includes(leader);
    this.onToast(
      `Network split — ${state.groupA.join(", ")} cut off from ${state.groupB.join(", ")}` +
        (leader ? ` · leader ${leader} is ${isolated ? "isolated" : "with the majority"}` : ""),
    );
    this.collectFx();
  }

  /** Reconnect a partitioned network. */
  healPartition(): void {
    this.ensureLive();
    if (this.sim.healPartition()) this.onToast("Partition healed — links restored");
  }

  // -------------------------------------------------------------- internals

  private propose(command: KVCommand, label: string): boolean {
    this.ensureLive();
    const ok = this.sim.propose(command);
    if (!ok) {
      this.onToast("No leader right now — wait for the election");
    } else {
      this.onToast(`${label} accepted by ${this.sim.leaderId() ?? "?"}`);
    }
    this.collectFx();
    return ok;
  }

  /** Interventions act on the present. If we're in the past, fork. */
  private ensureLive(): void {
    if (this.live) return;
    this.sim.forkAt(this.playhead);
    this.playhead = this.sim.duration;
    this.lastFxTime = this.playhead;
    this.pendingFx = [];
    this.fxEpoch += 1;
    this.onToast("Timeline forked — the old future is gone");
  }

  /** Turn frames crossed since the last call into one-shot effects. */
  private collectFx(): void {
    if (this.playhead <= this.lastFxTime) return;
    const frames = this.sim.frames;

    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (!frame || frame.time <= this.lastFxTime) break;
      if (frame.time > this.playhead) continue;

      // Partitioned drops are exploded against the wall by the scene itself
      // (it knows where the barrier is), so skip the generic burst for them.
      if (frame.cause.kind === "drop" && frame.cause.reason !== "partitioned") {
        const flight = frame.cause.flight;
        this.pendingFx.push({
          kind: "burst",
          from: flight.message.from,
          to: flight.message.to,
          // Packet loss explodes mid-arc; node-down drops die at the door.
          progress: flight.lost ? 0.5 : 1,
        });
      }
      for (const { nodeId, event } of frame.raftEvents) {
        if (event.type === "becameLeader") {
          this.pendingFx.push({ kind: "election", nodeId });
        } else if (event.type === "advancedCommit") {
          const snap = frame.nodes.find((n) => n.id === nodeId);
          if (snap?.role === "leader") this.pendingFx.push({ kind: "commit", nodeId });
        }
      }
    }
    this.lastFxTime = this.playhead;
  }
}

function flightKind(message: {
  kind: string;
  granted?: boolean;
  success?: boolean;
  entries?: readonly unknown[];
}): FlightKind {
  switch (message.kind) {
    case "RequestVote":
      return "voteReq";
    case "RequestVoteResponse":
      return message.granted ? "voteGrant" : "voteDeny";
    case "AppendEntries":
      return (message.entries?.length ?? 0) > 0 ? "append" : "heartbeat";
    default:
      return message.success ? "ackOk" : "ackNo";
  }
}

/** Number of log entries a message carries — only AppendEntries ever has any. */
function entryCountOf(message: { kind: string; entries?: readonly unknown[] }): number {
  return message.entries?.length ?? 0;
}
