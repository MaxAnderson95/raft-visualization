import type { App } from "../app.ts";
import type { Frame } from "../sim/index.ts";
import type { RaftNodeSnapshot } from "../raft/index.ts";
import type { KVCommand } from "../sim/index.ts";
import { el } from "./format.ts";

interface Refs {
  term: HTMLElement;
  voted: HTMLElement;
  leader: HTMLElement;
  logLen: HTMLElement;
  commit: HTMLElement;
  applied: HTMLElement;
  votes: HTMLElement | null;
  timerFill: HTMLElement | null;
  store: HTMLElement;
}

/**
 * The skeleton is rebuilt only when the selected node or its role/stopped
 * state changes; per-frame updates touch text content alone. Rebuilding
 * every frame would replace the action buttons between pointer-down and
 * pointer-up, so clicks would never land on them.
 */
export class Inspector {
  private readonly body: HTMLElement;
  private key = "";
  private refs: Refs | null = null;

  constructor(container: HTMLElement) {
    const panel = el("div", "panel");
    const title = el("div", "panel-title");
    title.append(el("span", "", "node inspector"));
    this.body = el("div");
    panel.append(title, this.body);
    container.appendChild(panel);
    this.showEmpty();
  }

  update(app: App): void {
    const frame = app.frame();
    const snap = app.selected ? frame.nodes.find((n) => n.id === app.selected) : undefined;

    if (!snap) {
      if (this.key !== "") {
        this.key = "";
        this.refs = null;
        this.showEmpty();
      }
      return;
    }

    const key = `${snap.id}:${snap.stopped}:${snap.role}`;
    if (key !== this.key) {
      this.key = key;
      this.build(app, snap);
    }
    this.refresh(app, snap, frame);
  }

  // -------------------------------------------------------------------------

  private showEmpty(): void {
    this.body.replaceChildren(el("div", "inspector-empty", "Click a node to inspect it."));
  }

  private build(app: App, snap: RaftNodeSnapshot<KVCommand>): void {
    const id = snap.id;
    const body = el("div", "inspector-body");

    const head = el("div", "inspector-head");
    head.append(el("span", "big-id", id));
    const role = snap.stopped ? "stopped" : snap.role;
    head.append(el("span", `role-badge ${role}`, snap.stopped ? "down" : snap.role));
    body.appendChild(head);

    const grid = el("div", "inspector-grid");
    const add = (label: string): HTMLElement => {
      const value = el("span", "v");
      grid.append(el("span", "k", label), value);
      return value;
    };
    const refs: Refs = {
      term: add("term"),
      voted: add("voted for"),
      leader: add("sees leader"),
      logLen: add("log length"),
      commit: add("commit index"),
      applied: add("applied"),
      votes: snap.role === "candidate" ? add("votes") : null,
      timerFill: null,
      store: el("div", "kv-note"),
    };
    body.appendChild(grid);

    if (!snap.stopped && snap.role !== "leader") {
      body.appendChild(el("div", "kv-note", "election timer"));
      const track = el("div", "timer-track");
      refs.timerFill = el("div", "timer-fill");
      track.appendChild(refs.timerFill);
      body.appendChild(track);
    }

    body.appendChild(refs.store);

    const actions = el("div", "inspector-actions");
    const stop = el("button", "btn is-danger", "Stop");
    stop.disabled = snap.stopped;
    stop.addEventListener("click", () => app.stopNode(id));

    const restart = el("button", "btn", "Restart");
    restart.title = snap.stopped
      ? "Bring this node back up"
      : "Bounce this node — it loses volatile state and rebuilds from its log";
    restart.addEventListener("click", () => app.restartNode(id));

    const remove = el("button", "btn is-danger", "Remove");
    remove.addEventListener("click", () => app.removeNode(id));

    actions.append(stop, restart, remove);
    body.appendChild(actions);

    this.refs = refs;
    this.body.replaceChildren(body);
  }

  private refresh(app: App, snap: RaftNodeSnapshot<KVCommand>, frame: Frame): void {
    const refs = this.refs;
    if (!refs) return;

    refs.term.textContent = String(snap.currentTerm);
    refs.voted.textContent = snap.votedFor ?? "—";
    refs.leader.textContent = snap.knownLeader ?? "—";
    refs.logLen.textContent = String(snap.log.length);
    refs.commit.textContent = String(snap.commitIndex);
    refs.applied.textContent = String(snap.lastApplied);
    if (refs.votes) {
      refs.votes.textContent = `${snap.votesGranted.length} of ${snap.peers.length + 1}`;
    }
    if (refs.timerFill && Number.isFinite(snap.electionDeadline)) {
      const fraction = Math.min(
        1,
        Math.max(0, (snap.electionDeadline - app.playhead) / snap.electionTimeoutSpan),
      );
      refs.timerFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    }
    const kv = frame.kv.get(snap.id);
    refs.store.textContent = `applied store · ${kv?.size ?? 0} keys`;
  }
}
