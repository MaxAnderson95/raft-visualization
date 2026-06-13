import type { App } from "../app.ts";
import { DEFAULT_TIMING } from "../raft/index.ts";
import { el } from "./format.ts";

interface DialOptions {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  /** Read the current value from the source of truth. */
  readonly read: () => number;
  readonly onInput: (value: number) => void;
}

interface Dial {
  readonly row: HTMLElement;
  /** Pull the source-of-truth value back into the slider + readout. */
  sync(): void;
}

/**
 * A labelled slider with a live value readout. `sync` re-reads the model
 * every frame, so resets (mini or global) reflect immediately; while the
 * user drags, the model already equals the slider so sync is a no-op.
 */
function dial(options: DialOptions): Dial {
  const row = el("div", "dial");
  const head = el("div", "dial-head");
  const value = el("span", "v", options.format(options.read()));
  head.append(el("span", "", options.label), value);

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

/** Failure & network conditions: leader crashes, loss, latency, jitter. */
export class ChaosPanel {
  private readonly chaosBtn: HTMLButtonElement;
  private readonly dials: Dial[];

  constructor(container: HTMLElement, app: App) {
    const panel = el("div", "panel");
    const net = app.sim.network;

    const title = titleBar("chaos", () => {
      app.sim.resetNetwork();
      app.autopilot.chaos = false;
    });

    const body = el("div", "dials-body");
    this.chaosBtn = el("button", "btn", "Leader crashes");
    this.chaosBtn.title = "Periodically crash the leader";
    this.chaosBtn.addEventListener("click", () => app.toggleChaos());
    body.appendChild(this.chaosBtn);

    this.dials = [
      dial({
        label: "packet loss",
        min: 0,
        max: 100,
        step: 1,
        format: pct,
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
