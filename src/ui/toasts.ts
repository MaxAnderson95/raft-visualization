import { el } from "./format.ts";

const MAX_TOASTS = 3;

export function createToaster(container: HTMLElement): (message: string) => void {
  return (message: string) => {
    while (container.children.length >= MAX_TOASTS) {
      container.firstChild?.remove();
    }
    const toast = el("div", "toast", message);
    container.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("bye");
      window.setTimeout(() => toast.remove(), 350);
    }, 2600);
  };
}
