import type { App } from "../app.ts";
import { formatCommand } from "../sim/index.ts";
import { ROLE_CSS, termColor } from "../theme.ts";
import { el } from "./format.ts";

const WINDOW = 14;

export class LogMatrix {
  private readonly body: HTMLElement;
  private readonly rows = new Map<string, { el: HTMLElement; signature: string; commit: number }>();

  constructor(container: HTMLElement) {
    const panel = el("div", "panel");
    const title = el("div", "panel-title");
    title.append(el("span", "", "replicated log"), el("span", "", "term · filled = committed"));
    this.body = el("div", "lm-body");
    panel.append(title, this.body);
    container.appendChild(panel);
  }

  update(app: App): void {
    const frame = app.frame();
    const snaps = [...frame.nodes].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const seen = new Set<string>();

    // One shared window so log indexes line up column-for-column across
    // nodes — that alignment is what makes divergence visible.
    let maxLen = 0;
    for (const snap of snaps) maxLen = Math.max(maxLen, snap.log.length);
    const start = Math.max(0, maxLen - WINDOW);

    for (const snap of snaps) {
      seen.add(snap.id);
      const lastTerm = snap.log[snap.log.length - 1]?.term ?? 0;
      const signature = `${start}:${snap.log.length}:${snap.commitIndex}:${snap.role}:${snap.stopped}:${lastTerm}`;
      let row = this.rows.get(snap.id);

      if (!row) {
        row = { el: el("div", "lm-row"), signature: "", commit: 0 };
        this.rows.set(snap.id, row);
        this.body.appendChild(row.el);
      }
      if (row.signature === signature) continue;

      const prevCommit = row.commit;
      row.signature = signature;
      row.commit = snap.commitIndex;
      row.el.classList.toggle("lm-stopped", snap.stopped);
      row.el.replaceChildren();

      const label = el("div", "lm-id");
      const dot = el("span", "role-dot");
      dot.style.background = snap.stopped ? ROLE_CSS.stopped : ROLE_CSS[snap.role];
      label.append(dot, el("span", "", snap.id));
      row.el.appendChild(label);

      const marker = el("div", "lm-empty", start > 0 ? `+${start}` : "");
      marker.style.width = "26px";
      row.el.appendChild(marker);

      for (let index = start + 1; index <= maxLen; index += 1) {
        const entry = snap.log[index - 1];
        if (!entry) {
          row.el.appendChild(el("div", "lm-cell lm-gap"));
          continue;
        }
        const cell = el("div", "lm-cell", String(entry.term));
        cell.style.setProperty("--cell", termColor(entry.term));
        cell.title = `#${entry.index} · term ${entry.term} · ${formatCommand(entry.command)}`;
        if (entry.command.op === "noop") {
          cell.classList.add("noop");
          cell.textContent = "·";
        }
        if (entry.index <= snap.commitIndex) {
          cell.classList.add("committed");
          if (entry.index > prevCommit) cell.classList.add("flash");
        }
        row.el.appendChild(cell);
      }
    }

    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
  }
}
