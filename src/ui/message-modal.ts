import type { App } from "../app.ts";
import { formatCommand } from "../sim/index.ts";
import type { MessageFlight, SimMessage } from "../sim/index.ts";
import { FLIGHT_COLORS } from "../theme.ts";
import { el, formatTime } from "./format.ts";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

interface Described {
  readonly label: string;
  readonly sub: string;
  readonly color: string;
}

/** Human-readable title, one-line summary, and accent colour for a message. */
function describe(msg: SimMessage): Described {
  switch (msg.kind) {
    case "RequestVote":
      return {
        label: "Request Vote",
        sub: `candidate ${msg.from} seeks a vote`,
        color: hex(FLIGHT_COLORS.voteReq),
      };
    case "RequestVoteResponse":
      return msg.granted
        ? { label: "Vote Response", sub: "vote granted", color: hex(FLIGHT_COLORS.voteGrant) }
        : { label: "Vote Response", sub: "vote denied", color: hex(FLIGHT_COLORS.voteDeny) };
    case "AppendEntries":
      return msg.entries.length > 0
        ? {
            label: "Append Entries",
            sub: `${msg.entries.length} ${msg.entries.length === 1 ? "entry" : "entries"} to replicate`,
            color: hex(FLIGHT_COLORS.append),
          }
        : {
            label: "Heartbeat",
            sub: "leader keep-alive, no entries",
            color: hex(FLIGHT_COLORS.heartbeat),
          };
    case "AppendEntriesResponse":
      return msg.success
        ? { label: "Append Response", sub: "accepted", color: hex(FLIGHT_COLORS.ackOk) }
        : { label: "Append Response", sub: "rejected", color: hex(FLIGHT_COLORS.ackNo) };
  }
}

/**
 * A modal that freezes the simulation and explains a single message comet:
 * what kind it is, where it's going, the RPC fields, any replicated payload,
 * and transit metadata. Rebuilds only when the inspected flight changes;
 * progress/ETA refresh every frame so it stays live if playback resumes.
 */
export class MessageModal {
  private readonly app: App;
  private readonly overlay: HTMLElement;
  private readonly dialog: HTMLElement;
  private currentId: number | null = null;
  private dyn: { progress: HTMLElement; eta: HTMLElement } | null = null;

  constructor(mount: HTMLElement, app: App) {
    this.app = app;

    this.overlay = el("div", "msg-overlay");
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) app.closeFlight();
    });

    this.dialog = el("div", "panel msg-modal");
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "Message inspector");
    this.overlay.appendChild(this.dialog);
    mount.appendChild(this.overlay);
  }

  update(app: App): void {
    const id = app.selectedFlight;
    if (id === null) {
      this.hide();
      return;
    }
    const flight = app.findFlight(id);
    if (!flight) {
      // Delivered or dropped while we looked away — nothing left to inspect.
      app.closeFlight();
      this.hide();
      return;
    }

    if (id !== this.currentId) {
      this.currentId = id;
      this.build(flight);
    }
    this.refresh(flight, app.playhead);
    this.overlay.classList.add("is-open");
  }

  // -------------------------------------------------------------------------

  private hide(): void {
    if (this.currentId === null && !this.overlay.classList.contains("is-open")) return;
    this.overlay.classList.remove("is-open");
    this.currentId = null;
    this.dyn = null;
  }

  private build(flight: MessageFlight): void {
    const msg = flight.message;
    const d = describe(msg);

    const head = el("div", "msg-head");
    const dot = el("span", "msg-dot");
    dot.style.color = d.color;
    const titles = el("div", "msg-titles");
    titles.append(el("div", "msg-kind", d.label), el("div", "msg-sub", d.sub));
    const close = el("button", "msg-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.app.closeFlight());
    head.append(dot, titles, close);

    const route = el("div", "msg-route");
    route.append(
      el("span", "msg-node", msg.from),
      el("span", "msg-arrow", "\u2192"),
      el("span", "msg-node", msg.to),
    );

    const grid = el("div", "inspector-grid msg-grid");
    const addRow = (k: string, v: string): HTMLElement => {
      const value = el("span", "v", v);
      grid.append(el("span", "k", k), value);
      return value;
    };
    addRow("term", String(msg.term));
    fieldsFor(msg, addRow);
    const progress = addRow("progress", "");
    const eta = addRow(flight.lost ? "drops in" : "arrives in", "");
    this.dyn = { progress, eta };

    const sections: HTMLElement[] = [head, route, grid];

    if (msg.kind === "AppendEntries" && msg.entries.length > 0) {
      const list = el("div", "msg-entries");
      for (const entry of msg.entries) {
        const row = el("div", "msg-entry");
        row.append(
          el("span", "msg-entry-idx", `#${entry.index}`),
          el("span", "msg-entry-term", `term ${entry.term}`),
          el("span", "msg-entry-cmd", formatCommand(entry.command)),
        );
        list.append(row);
      }
      sections.push(el("div", "msg-section-label", "payload"), list);
    }

    const meta = el("div", "inspector-grid msg-grid msg-meta");
    const addMeta = (k: string, v: string): void => {
      meta.append(el("span", "k", k), el("span", "v", v));
    };
    addMeta("message id", `#${flight.id}`);
    addMeta("sent at", formatTime(flight.sentAt));
    addMeta(flight.lost ? "would arrive" : "arrives at", formatTime(flight.deliverAt));
    addMeta("one-way delay", `${Math.round(flight.deliverAt - flight.sentAt)} ms`);
    addMeta("delivery", flight.lost ? "dropped in transit" : "in flight");
    sections.push(el("div", "msg-section-label", "metadata"), meta);

    this.dialog.replaceChildren(...sections);
  }

  private refresh(flight: MessageFlight, playhead: number): void {
    if (!this.dyn) return;
    const span = flight.deliverAt - flight.sentAt;
    const frac = span > 0 ? Math.min(Math.max((playhead - flight.sentAt) / span, 0), 1) : 1;
    this.dyn.progress.textContent = `${Math.round(frac * 100)}%`;
    this.dyn.eta.textContent = `${Math.round(Math.max(0, flight.deliverAt - playhead))} ms`;
  }
}

/** RPC-specific fields appended to the key/value grid. */
function fieldsFor(msg: SimMessage, addRow: (k: string, v: string) => HTMLElement): void {
  switch (msg.kind) {
    case "RequestVote":
      addRow("last log index", String(msg.lastLogIndex));
      addRow("last log term", String(msg.lastLogTerm));
      break;
    case "RequestVoteResponse":
      addRow("vote", msg.granted ? "granted" : "denied");
      break;
    case "AppendEntries":
      addRow("prev log index", String(msg.prevLogIndex));
      addRow("prev log term", String(msg.prevLogTerm));
      addRow("leader commit", String(msg.leaderCommit));
      addRow("entries", String(msg.entries.length));
      break;
    case "AppendEntriesResponse":
      addRow("result", msg.success ? "accepted" : "rejected");
      if (msg.success) {
        addRow("match index", String(msg.matchIndex));
      } else if (msg.conflictIndex > 0) {
        addRow("conflict hint", `index ${msg.conflictIndex}`);
      }
      break;
  }
}
