import type { App } from "../app.ts";
import { el } from "./format.ts";

export class KVPanel {
  private readonly table: HTMLElement;
  private readonly note: HTMLElement;
  private readonly viewLabel: HTMLElement;
  private readonly keyInput: HTMLInputElement;
  private readonly valueInput: HTMLInputElement;
  private lastRendered = "";

  constructor(container: HTMLElement, app: App) {
    const panel = el("div", "panel");
    const title = el("div", "panel-title");
    this.viewLabel = el("span", "", "leader's view");
    title.append(el("span", "", "key-value store"), this.viewLabel);

    const body = el("div", "kv-body");
    this.table = el("div", "kv-table");
    this.note = el("div", "kv-note");

    const form = el("form", "kv-form") as HTMLFormElement;
    this.keyInput = el("input") as HTMLInputElement;
    this.keyInput.placeholder = "key";
    this.keyInput.maxLength = 12;
    this.keyInput.setAttribute("aria-label", "key");
    this.valueInput = el("input") as HTMLInputElement;
    this.valueInput.placeholder = "value";
    this.valueInput.maxLength = 12;
    this.valueInput.setAttribute("aria-label", "value");
    const submit = el("button", "btn", "Set");
    submit.type = "submit";
    form.append(this.keyInput, this.valueInput, submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const key = this.keyInput.value.trim();
      const value = this.valueInput.value.trim();
      if (!key || !value) return;
      if (app.proposeSet(key, value)) {
        this.keyInput.value = "";
        this.valueInput.value = "";
        this.keyInput.focus();
      }
    });

    body.append(this.table, this.note, form);
    panel.append(title, body);
    container.appendChild(panel);
    this.app = app;
  }

  private readonly app: App;

  update(app: App): void {
    const frame = app.frame();
    const leaderId = frame.nodes.find((n) => n.role === "leader" && !n.stopped)?.id ?? null;
    const selected = app.selected ? frame.nodes.find((n) => n.id === app.selected) : undefined;

    let viewId: string | null;
    if (selected && selected.id !== leaderId) {
      // A non-leader node is selected: show that replica's applied state.
      viewId = selected.id;
      this.viewLabel.textContent = `${selected.id}'s view`;
      if (selected.stopped) {
        this.note.innerHTML = `<strong>${selected.id}</strong> is down — showing its last applied state`;
      } else {
        this.note.innerHTML = leaderId
          ? `viewing <strong>${selected.id}</strong> · writes still go to <strong>${leaderId}</strong>`
          : `viewing <strong>${selected.id}</strong> · <span class="no-leader">no leader — election in progress</span>`;
      }
    } else {
      // Leader selected, or nothing selected: the client's perspective.
      this.viewLabel.textContent = "leader's view";
      viewId = leaderId;
      if (!viewId) {
        // With no leader, show the most caught-up node's committed state so
        // the store doesn't appear to vanish mid-election.
        let best = -1;
        for (const node of frame.nodes) {
          if (node.commitIndex > best) {
            best = node.commitIndex;
            viewId = node.id;
          }
        }
      }
      if (leaderId) {
        this.note.innerHTML = `writes go to <strong>${leaderId}</strong>${app.autopilot.enabled ? " · autopilot is writing too" : ""}`;
      } else {
        this.note.innerHTML = `<span class="no-leader">no leader — election in progress</span>`;
      }
    }
    const store = viewId ? frame.kv.get(viewId) : undefined;

    // Entries in the viewed node's log beyond its commit index: data it
    // holds but can't yet show a client. Rendered greyed-out until the
    // commit catches up.
    const viewSnap = viewId ? frame.nodes.find((n) => n.id === viewId) : undefined;
    const pendingSets = new Map<string, string>();
    const pendingDels = new Set<string>();
    if (viewSnap) {
      for (const entry of viewSnap.log.slice(viewSnap.commitIndex)) {
        const command = entry.command;
        if (command.op === "set") {
          pendingSets.set(command.key, command.value);
          pendingDels.delete(command.key);
        } else if (command.op === "del") {
          pendingDels.add(command.key);
          pendingSets.delete(command.key);
        }
      }
    }

    const signature = [
      viewId ?? "-",
      store ? [...store.entries()].map(([k, v]) => `${k}=${v}`).join(";") : "none",
      [...pendingSets.entries()].map(([k, v]) => `${k}=${v}`).join(";"),
      [...pendingDels].join(";"),
    ].join("|");
    if (signature === this.lastRendered) return;
    this.lastRendered = signature;

    this.table.replaceChildren();
    if ((!store || store.size === 0) && pendingSets.size === 0) {
      this.table.appendChild(el("div", "kv-empty", "Nothing stored yet — set a key below."));
      return;
    }

    const addRow = (key: string, value: string, classes: string): void => {
      const row = el("div", `kv-row ${classes}`.trim());
      const del = el("button", "del", "✕");
      del.title = `delete ${key}`;
      del.addEventListener("click", () => this.app.proposeDel(key));
      row.append(el("span", "key", key), el("span", "eq", "="), el("span", "val", value), del);
      if (classes.includes("pending")) row.title = "in the log, awaiting commit";
      this.table.appendChild(row);
    };

    // Uncommitted writes first (they're the newest), then committed state
    // in write-recency order.
    for (const [key, value] of [...pendingSets.entries()].reverse()) {
      addRow(key, value, "pending");
    }
    for (const [key, value] of [...(store ?? new Map<string, string>()).entries()].reverse()) {
      if (pendingSets.has(key)) continue;
      addRow(key, value, pendingDels.has(key) ? "pending deleting" : "");
    }
  }
}
