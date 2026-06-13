import type { Frame, NarratedEvent, SimCause } from "../sim/index.ts";
import { formatCommand } from "../sim/index.ts";
import type { App } from "../app.ts";
import { ROLE_CSS } from "../theme.ts";
import { el, formatTime } from "./format.ts";

const MAX_LINES = 60;

interface Line {
  readonly time: number;
  readonly nodeId: string | null;
  readonly html: string;
}

export class Feed {
  private readonly body: HTMLElement;
  private lastTime = -1;

  constructor(container: HTMLElement) {
    const panel = el("div", "panel feed");
    const title = el("div", "panel-title");
    title.append(el("span", "", "event feed"));
    this.body = el("div", "feed-body");
    this.body.append(el("div", "feed-empty", "Waiting for the first event…"));
    panel.append(title, this.body);
    container.appendChild(panel);
  }

  update(app: App): void {
    const t = app.playhead;
    if (t < this.lastTime) {
      // Scrubbed backwards: rebuild the feed as of the playhead.
      this.body.replaceChildren();
      this.lastTime = -1;
    }

    const fresh: Line[] = [];
    const frames = app.sim.frames;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (!frame || frame.time <= this.lastTime) break;
      if (frame.time > t) continue;
      fresh.push(...narrate(frame));
    }
    this.lastTime = t;
    if (fresh.length === 0) return;

    this.body.querySelector(".feed-empty")?.remove();
    // fresh is newest-first already (we iterated backwards).
    for (const line of fresh.reverse()) {
      // Coalesce repeats (e.g. heartbeats dropping at a dead node).
      const newest = this.body.firstElementChild?.querySelector("span:last-child");
      if (newest && newest.innerHTML === line.html) continue;
      const div = el("div", "feed-line");
      const dot = el("span", "dot");
      if (line.nodeId) {
        const frame = app.frame();
        const snap = frame.nodes.find((n) => n.id === line.nodeId);
        const role = snap ? (snap.stopped ? "stopped" : snap.role) : "follower";
        dot.style.background = ROLE_CSS[role];
      }
      const time = el("span", "t", formatTime(line.time));
      const text = el("span");
      text.innerHTML = line.html;
      div.append(time, dot, text);
      this.body.prepend(div);
    }
    while (this.body.children.length > MAX_LINES) {
      this.body.lastChild?.remove();
    }
  }
}

function narrate(frame: Frame): Line[] {
  const lines: Line[] = [];
  const t = frame.time;
  const causeLine = narrateCause(frame.cause);
  if (causeLine) lines.push({ time: t, ...causeLine });

  for (const { nodeId, event } of frame.raftEvents) {
    const html = narrateEvent(nodeId, event);
    if (html) lines.push({ time: t, nodeId, html });
  }
  // Newest-first within a frame, to match feed ordering.
  return lines.reverse();
}

function narrateCause(cause: SimCause): { nodeId: string | null; html: string } | null {
  switch (cause.kind) {
    case "init":
      return { nodeId: null, html: "cluster initialized" };
    case "reset":
      return { nodeId: null, html: "simulation reset — same cluster, fresh history" };
    case "clientPropose":
      return {
        nodeId: cause.nodeId,
        html: `client → <strong>${cause.nodeId}</strong> · ${escapeHtml(formatCommand(cause.command))} <span style="opacity:.6">(index ${cause.index})</span>`,
      };
    case "drop":
      return {
        nodeId: cause.flight.message.to,
        html: `message to <strong>${cause.flight.message.to}</strong> lost (${cause.reason})`,
      };
    case "nodeAdded":
      return { nodeId: cause.nodeId, html: `<strong>${cause.nodeId}</strong> joined the cluster` };
    case "nodeRemoved":
      return { nodeId: null, html: `<strong>${cause.nodeId}</strong> removed from the cluster` };
    case "nodeStopped":
      return { nodeId: cause.nodeId, html: `<strong>${cause.nodeId}</strong> crashed` };
    case "nodeRestarted":
      return { nodeId: cause.nodeId, html: `<strong>${cause.nodeId}</strong> recovered` };
    default:
      return null; // deliveries & wakes narrate via their raft events
  }
}

function narrateEvent(nodeId: string, event: NarratedEvent["event"]): string | null {
  switch (event.type) {
    case "electionTimeout":
      return `<strong>${nodeId}</strong> election timeout — campaigning for term ${event.term}`;
    case "becameLeader":
      return `<strong>${nodeId}</strong> won the election · leader of term ${event.term}`;
    case "becameFollower":
      return `<strong>${nodeId}</strong> stepped down (${escapeHtml(event.reason)})`;
    case "grantedVote":
      return `<strong>${nodeId}</strong> voted for ${event.to}`;
    case "deniedVote":
      return `<strong>${nodeId}</strong> refused ${event.to}: ${escapeHtml(event.reason)}`;
    case "truncatedLog":
      return `<strong>${nodeId}</strong> truncated conflicting log from index ${event.fromIndex}`;
    case "advancedCommit":
      return `<strong>${nodeId}</strong> committed through index ${event.commitIndex}`;
    case "rejectedAppend":
      return `<strong>${nodeId}</strong> rejected entries: ${escapeHtml(event.reason)}`;
    default:
      return null; // receivedVote / appendedEntries / becameCandidate are visual noise
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
