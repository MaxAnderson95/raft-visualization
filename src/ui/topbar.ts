import type { App } from "../app.ts";
import { el } from "./format.ts";

export class Topbar {
  private readonly termValue: HTMLElement;
  private readonly leaderValue: HTMLElement;
  private readonly nodesValue: HTMLElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly autoBtn: HTMLButtonElement;

  constructor(container: HTMLElement, app: App) {
    const wordmark = el("div", "wordmark");
    const title = el("h1", "", "Raft");
    const tagline = el("span", "tagline", "consensus, visualized");
    wordmark.append(title, tagline);

    const stats = el("div", "cluster-stats panel");
    const termStat = el("div", "stat");
    termStat.append(el("span", "k", "term"), (this.termValue = el("span", "v", "0")));
    const leaderStat = el("div", "stat");
    leaderStat.append(
      el("span", "k", "leader"),
      (this.leaderValue = el("span", "v leader-name", "—")),
    );
    const nodesStat = el("div", "stat");
    nodesStat.append(el("span", "k", "nodes"), (this.nodesValue = el("span", "v", "0")));
    stats.append(termStat, leaderStat, nodesStat);

    const actions = el("div", "topbar-actions");
    const addBtn = el("button", "btn", "+ Add node");
    addBtn.addEventListener("click", () => app.addNode());

    this.removeBtn = el("button", "btn", "− Remove node");
    this.removeBtn.title = "Removes the newest node — select one to remove a specific node";
    this.removeBtn.addEventListener("click", () => app.removeNewestNode());

    this.autoBtn = el("button", "btn", "Autopilot");
    this.autoBtn.addEventListener("click", () => app.toggleAuto());

    const resetBtn = el("button", "btn", "Reset");
    resetBtn.title = "Start over — same cluster, empty logs, fresh election";
    resetBtn.addEventListener("click", () => app.reset());
    actions.append(addBtn, this.removeBtn, this.autoBtn, resetBtn);

    container.append(wordmark, stats, actions);
  }

  update(app: App): void {
    const frame = app.frame();
    let term = 0;
    let leader: string | null = null;
    for (const node of frame.nodes) {
      term = Math.max(term, node.currentTerm);
      if (node.role === "leader" && !node.stopped) {
        if (leader === null || node.currentTerm >= term) leader = node.id;
      }
    }
    this.termValue.textContent = String(term);
    this.leaderValue.textContent = leader ?? "—";
    this.nodesValue.textContent = String(frame.nodes.length);
    this.removeBtn.disabled = frame.nodes.length <= 1;
    this.autoBtn.classList.toggle("is-on", app.autopilot.enabled);
  }
}
