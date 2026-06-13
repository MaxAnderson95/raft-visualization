import { el } from "./format.ts";

type SheetKey = "side" | "logmatrix" | "dials";

interface TabDef {
  readonly key: SheetKey;
  readonly label: string;
}

/**
 * Compact-mode chrome. On small screens the side/dial/log panels can't sit
 * around the edges, so this turns them into a bottom drawer: a persistent
 * tab bar whose tabs raise the existing panel containers as a scrollable
 * sheet. Nothing is moved in the DOM — the panels keep updating by reference
 * each frame; we only toggle a `body.is-compact` class and `.is-open` on the
 * active container, so the desktop layout is left completely untouched.
 */
export class MobileSheet {
  private readonly bar: HTMLElement;
  private readonly buttons = new Map<SheetKey, HTMLButtonElement>();
  private readonly containers = new Map<SheetKey, HTMLElement>();
  private readonly mql: MediaQueryList;
  private active: SheetKey | null = null;
  private compact = false;

  constructor() {
    const tabs: TabDef[] = [
      { key: "side", label: "Inspect" },
      { key: "logmatrix", label: "Log" },
      { key: "dials", label: "Tune" },
    ];

    this.bar = el("nav", "sheet-tabs");
    this.bar.setAttribute("aria-label", "panels");

    for (const tab of tabs) {
      const container = document.getElementById(tab.key);
      if (!container) continue;
      this.containers.set(tab.key, container);

      const btn = el("button", "sheet-tab", tab.label);
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => this.toggle(tab.key));
      this.buttons.set(tab.key, btn);
      this.bar.appendChild(btn);
    }
    document.body.appendChild(this.bar);

    this.mql = window.matchMedia("(max-width: 700px)");
    this.mql.addEventListener("change", () => this.applyCompact(this.mql.matches));
    this.applyCompact(this.mql.matches);
  }

  /** Surface a tab programmatically (e.g. tapping a node opens Inspect). */
  open(key: SheetKey): void {
    if (this.compact) this.setActive(key);
  }

  private toggle(key: SheetKey): void {
    this.setActive(this.active === key ? null : key);
  }

  private applyCompact(compact: boolean): void {
    this.compact = compact;
    document.body.classList.toggle("is-compact", compact);
    // Leaving compact mode returns every panel to its desktop position.
    if (!compact) this.setActive(null);
  }

  private setActive(key: SheetKey | null): void {
    this.active = key;
    for (const [k, container] of this.containers) {
      container.classList.toggle("is-open", k === key);
    }
    for (const [k, btn] of this.buttons) {
      const on = k === key;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    document.body.classList.toggle("sheet-open", key !== null);
  }
}
