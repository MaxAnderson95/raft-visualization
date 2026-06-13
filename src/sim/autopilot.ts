/**
 * Auto mode: drives the cluster so the visualization tells a story without
 * user interaction — a steady trickle of client writes, plus periodic
 * "chaos" (crashing the leader) to trigger elections.
 */

import type { NodeId } from "../raft/index.ts";
import { mulberry32, pick, uniform } from "./prng.ts";
import type { RaftSimulation } from "./simulation.ts";

const KEYS = ["x", "y", "z", "k", "v", "q"] as const;

export interface AutopilotOptions {
  readonly seed?: number;
  /** Crash nodes periodically to showcase elections. Default false. */
  readonly chaos?: boolean;
}

export class Autopilot {
  enabled = false;
  chaos: boolean;

  private readonly sim: RaftSimulation;
  private readonly rng: () => number;
  private nextProposeAt = 0;
  private nextChaosAt = 0;
  private pendingRestarts: { id: NodeId; at: number }[] = [];
  private counters = new Map<string, number>();

  constructor(sim: RaftSimulation, options: AutopilotOptions = {}) {
    this.sim = sim;
    this.rng = mulberry32(options.seed ?? 7);
    this.chaos = options.chaos ?? false;
    // Let the opening election play out before touching anything.
    this.nextProposeAt = uniform(this.rng, 500, 800);
    this.nextChaosAt = uniform(this.rng, 2500, 4500);
  }

  /** Re-arm schedules from t=0 (call after the simulation is reset). */
  rearm(): void {
    this.pendingRestarts = [];
    this.counters.clear();
    this.nextProposeAt = uniform(this.rng, 500, 800);
    this.nextChaosAt = uniform(this.rng, 2500, 4500);
  }

  /** Call after each sim advance, at the live edge. */
  step(): void {
    const now = this.sim.duration;

    // Honor scheduled restarts even when auto mode has been switched off,
    // so a chaos-killed node never stays dead forever.
    this.pendingRestarts = this.pendingRestarts.filter((r) => {
      if (now < r.at) return true;
      this.sim.restartNode(r.id);
      return false;
    });

    // Client writes need the autopilot master switch…
    if (this.enabled) {
      if (now >= this.nextProposeAt) {
        const key = pick(this.rng, KEYS);
        const value = (this.counters.get(key) ?? 0) + 1;
        if (this.sim.propose({ op: "set", key, value: String(value) })) {
          this.counters.set(key, value);
          this.nextProposeAt = now + uniform(this.rng, 150, 450);
        } else {
          // No leader right now (election in progress) — retry soon.
          this.nextProposeAt = now + 100;
        }
      }
    } else {
      // Re-arm so enabling later doesn't fire a burst of stale actions.
      this.nextProposeAt = Math.max(this.nextProposeAt, now + uniform(this.rng, 100, 300));
    }

    // …but chaos stands on its own: the toggle means what it says.
    if (this.chaos) {
      if (now >= this.nextChaosAt) {
        const leader = this.sim.leaderId();
        if (leader) {
          this.sim.stopNode(leader);
          this.pendingRestarts.push({ id: leader, at: now + uniform(this.rng, 400, 800) });
          this.nextChaosAt = now + uniform(this.rng, 1500, 3000);
        } else {
          this.nextChaosAt = now + 500;
        }
      }
    } else {
      this.nextChaosAt = Math.max(this.nextChaosAt, now + uniform(this.rng, 250, 600));
    }
  }

  /** Schedule the next crash soon — called when chaos is switched on. */
  armChaosSoon(): void {
    this.nextChaosAt = this.sim.duration + uniform(this.rng, 150, 400);
  }
}
