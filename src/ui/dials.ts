import type { App } from "../app.ts";
import { DEFAULT_TIMING } from "../raft/index.ts";
import { el } from "./format.ts";

interface DialOptions {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  /** Hover explanation of what the setting controls. */
  readonly tooltip?: string;
  /** Read the current value from the source of truth. */
  readonly read: () => number;
  readonly onInput: (value: number) => void;
}

interface Dial {
  readonly row: HTMLElement;
  /** Pull the source-of-truth value back into the slider + readout. */
  sync(): void;
}

// One document-level listener closes any open tap-tooltip when you click away.
let tipDismissArmed = false;
function armTipDismiss(): void {
  if (tipDismissArmed) return;
  tipDismissArmed = true;
  document.addEventListener("click", () => {
    for (const open of document.querySelectorAll(".info.is-open")) {
      open.classList.remove("is-open");
    }
  });
}

/**
 * A small "ⓘ" badge that reveals an explanation. Hover works on desktop;
 * on touch (no hover) a tap toggles it open, and a tap elsewhere closes it.
 */
function infoBadge(text: string): HTMLElement {
  armTipDismiss();
  const badge = el("span", "info", "i");
  badge.tabIndex = 0;
  badge.setAttribute("role", "button");
  badge.setAttribute("aria-label", text);

  const tip = el("span", "info-tip", text);
  tip.setAttribute("role", "tooltip");
  badge.appendChild(tip);

  const toggle = (): void => {
    const willOpen = !badge.classList.contains("is-open");
    for (const open of document.querySelectorAll(".info.is-open")) {
      open.classList.remove("is-open");
    }
    badge.classList.toggle("is-open", willOpen);
  };

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  badge.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return badge;
}

/**
 * A labelled slider with a live value readout. `sync` re-reads the model
 * every frame, so resets (mini or global) reflect immediately; while the
 * user drags, the model already equals the slider so sync is a no-op.
 */
function dial(options: DialOptions): Dial {
  const row = el("div", "dial");
  const head = el("div", "dial-head");
  const label = el("span", "dial-label");
  label.append(el("span", "", options.label));
  if (options.tooltip) label.appendChild(infoBadge(options.tooltip));
  const value = el("span", "v", options.format(options.read()));
  head.append(label, value);

  const input = el("input") as HTMLInputElement;
  input.type = "range";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.read());
  input.setAttribute("aria-label", options.label);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    value.textContent = options.format(v);
    options.onInput(v);
  });

  row.append(head, input);
  return {
    row,
    sync(): void {
      const v = options.read();
      if (Number(input.value) !== v) {
        input.value = String(v);
        value.textContent = options.format(v);
      }
    },
  };
}

function titleBar(name: string, onReset: () => void): HTMLElement {
  const title = el("div", "panel-title");
  const reset = el("button", "mini-reset", "reset");
  reset.title = `Reset ${name} to defaults`;
  reset.addEventListener("click", onReset);
  title.append(el("span", "", name), reset);
  return title;
}

const ms = (v: number): string => `${v} ms`;
const pct = (v: number): string => `${v}%`;
const roundHalf = (v: number): number => Math.round(v * 2) / 2;

/** Failure & network conditions: leader crashes, partition, loss, latency, jitter. */
export class ChaosPanel {
  private readonly chaosBtn: HTMLButtonElement;
  private readonly partitionBtns: HTMLButtonElement[];
  private readonly healBtn: HTMLButtonElement;
  private readonly partitionStatus: HTMLElement;
  private readonly dials: Dial[];

  constructor(container: HTMLElement, app: App) {
    const panel = el("div", "panel");
    const net = app.sim.network;

    const title = titleBar("chaos", () => {
      app.sim.resetNetwork();
      app.sim.healPartition();
      app.autopilot.chaos = false;
    });

    const body = el("div", "dials-body");

    const crashLabel = el("div", "sub-label", "leader failure");
    crashLabel.appendChild(
      infoBadge(
        "Periodically crash whichever node is leader, forcing the cluster to elect a new one. Crashed nodes restart on their own after a short delay.",
      ),
    );
    this.chaosBtn = el("button", "btn", "Leader crashes");
    this.chaosBtn.addEventListener("click", () => app.toggleChaos());
    body.append(crashLabel, this.chaosBtn);

    // Network partition: split a fraction of the cluster off into its own
    // group. Messages across the divide are dropped until healed.
    const partLabel = el("div", "sub-label", "network partition");
    partLabel.appendChild(
      infoBadge(
        "Split the cluster into two groups that can't reach each other. Only a side holding a majority can elect a leader and commit — the other stalls. Heal to reconnect.",
      ),
    );
    const partRow = el("div", "seg-row");
    this.partitionBtns = [
      { label: "½", fraction: 1 / 2, title: "Split off about half the nodes" },
      { label: "⅓", fraction: 1 / 3, title: "Split off about a third of the nodes" },
      { label: "¼", fraction: 1 / 4, title: "Split off about a quarter of the nodes" },
    ].map(({ label, fraction, title: t }) => {
      const btn = el("button", "btn seg", label);
      btn.title = t;
      btn.addEventListener("click", () => app.partition(fraction));
      return btn;
    });
    partRow.append(...this.partitionBtns);

    this.healBtn = el("button", "btn", "Heal partition");
    this.healBtn.title = "Reconnect the two groups";
    this.healBtn.addEventListener("click", () => app.healPartition());
    this.partitionStatus = el("div", "dials-status", "network whole");

    body.append(partLabel, partRow, this.healBtn, this.partitionStatus);

    this.dials = [
      dial({
        label: "packet loss",
        min: 0,
        max: 100,
        step: 1,
        format: pct,
        tooltip:
          "Chance each message is dropped in flight. Raft recovers dropped AppendEntries on the next heartbeat, but high loss stalls replication and can trigger re-elections.",
        read: () => Math.round(net.loss * 100),
        onInput: (v) => {
          net.loss = v / 100;
        },
      }),
      dial({
        label: "latency",
        min: 0.5,
        max: 150,
        step: 0.5,
        format: ms,
        tooltip:
          "Base one-way network delay before a message is delivered. Raises round-trip time; if it approaches the election timeout, followers start campaigning.",
        read: () => roundHalf(net.latency),
        onInput: (v) => {
          net.latency = v;
        },
      }),
      dial({
        label: "jitter",
        min: 0,
        max: 100,
        step: 0.5,
        format: (v) => `± ${v} ms`,
        tooltip:
          "Random extra delay added on top of latency (0 up to this much, per message). Models an unsteady network where delivery times vary.",
        read: () => roundHalf(net.jitter),
        onInput: (v) => {
          net.jitter = v;
        },
      }),
    ];
    body.append(...this.dials.map((d) => d.row));

    panel.append(title, body);
    container.appendChild(panel);
  }

  update(app: App): void {
    this.chaosBtn.classList.toggle("is-on", app.autopilot.chaos);

    const frame = app.frame();
    const part = frame.partition;
    const canSplit = frame.nodes.length >= 2;
    for (const btn of this.partitionBtns) btn.disabled = !canSplit;
    this.healBtn.disabled = !part;
    this.healBtn.classList.toggle("is-danger", !!part);
    this.partitionStatus.classList.toggle("is-split", !!part);
    this.partitionStatus.textContent = part
      ? `split — ${part.groupA.join(", ")}  ⇿  ${part.groupB.join(", ")}`
      : "network whole";

    for (const d of this.dials) d.sync();
  }
}

/** Raft's own dials: election timeout window and heartbeat cadence. */
export class TimingPanel {
  private readonly status: HTMLElement;
  private readonly dials: Dial[];

  constructor(container: HTMLElement, app: App) {
    const panel = el("div", "panel");
    const sim = app.sim;

    const title = titleBar("raft timing", () => {
      sim.setTiming({ ...DEFAULT_TIMING });
    });

    const body = el("div", "dials-body");
    this.dials = [
      dial({
        label: "election timeout",
        min: 50,
        max: 600,
        step: 10,
        format: ms,
        tooltip:
          "Minimum time a follower waits without hearing from the leader before starting a new election. Lower = faster failover, but more spurious elections.",
        read: () => sim.electionTimeoutMin,
        onInput: (v) => {
          const spread = sim.electionTimeoutMax - sim.electionTimeoutMin;
          sim.setTiming({ electionTimeoutMin: v, electionTimeoutMax: v + spread });
        },
      }),
      dial({
        label: "timeout spread",
        min: 10,
        max: 400,
        step: 10,
        format: (v) => `+ ${v} ms`,
        tooltip:
          "Random window added above the minimum. Each node picks its timeout in [min, min+spread], so followers don't all campaign at once — this is what breaks split votes.",
        read: () => sim.electionTimeoutMax - sim.electionTimeoutMin,
        onInput: (v) => {
          sim.setTiming({ electionTimeoutMax: sim.electionTimeoutMin + v });
        },
      }),
      dial({
        label: "heartbeat",
        min: 10,
        max: 200,
        step: 5,
        format: ms,
        tooltip:
          "How often the leader sends AppendEntries heartbeats to keep followers from timing out. Must stay well below the election timeout.",
        read: () => sim.heartbeatInterval,
        onInput: (v) => {
          sim.setTiming({ heartbeatInterval: v });
        },
      }),
    ];
    body.append(...this.dials.map((d) => d.row));

    this.status = el("div", "dials-status");
    body.appendChild(this.status);

    panel.append(title, body);
    container.appendChild(panel);
  }

  update(app: App): void {
    for (const d of this.dials) d.sync();

    const { latency, jitter, loss } = app.sim.network;
    const worstRtt = Math.round(2 * (latency + jitter));
    const electionMin = app.sim.electionTimeoutMin;
    const heartbeatGap = app.sim.heartbeatInterval + jitter;

    const risky = worstRtt >= electionMin || heartbeatGap >= electionMin || loss >= 0.25;
    this.status.classList.toggle("is-risky", risky);
    this.status.textContent = risky
      ? `⚠ messages can outlive the election timer (worst RTT ${worstRtt} ms) — expect re-elections`
      : `worst round trip ${worstRtt} ms · election ≥ ${electionMin} ms — stable`;
  }
}
