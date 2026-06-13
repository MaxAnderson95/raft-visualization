import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./style.css";

import { App } from "./app.ts";
import { ChaosPanel, TimingPanel } from "./ui/dials.ts";
import { Feed } from "./ui/feed.ts";
import { Inspector } from "./ui/inspector.ts";
import { KVPanel } from "./ui/kvpanel.ts";
import { LogMatrix } from "./ui/logmatrix.ts";
import { MessageModal } from "./ui/message-modal.ts";
import { MobileSheet } from "./ui/sheet.ts";
import { Timeline } from "./ui/timeline.ts";
import { Topbar } from "./ui/topbar.ts";
import { createToaster } from "./ui/toasts.ts";
import { ClusterScene } from "./viz/scene.ts";

function need(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

// Same seed → same history. Share a run with ?seed=1234.
const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed")) || Math.floor(Math.random() * 1_000_000);

const app = new App(seed);
app.onToast = createToaster(need("toasts"));

// Owns the compact-mode bottom drawer; harmless (idle) on desktop.
const sheet = new MobileSheet();

const scene = new ClusterScene(need("scene"), need("labels"), {
  onSelectNode: (id) => {
    app.select(id);
    // On mobile, tapping a node raises the inspector so the tap does something.
    if (app.selected) sheet.open("side");
  },
  onSelectFlight: (id) => app.inspectFlight(id),
});

const topbar = new Topbar(need("topbar"), app);
const dials = need("dials");
const chaosPanel = new ChaosPanel(dials, app);
const timingPanel = new TimingPanel(dials, app);
const side = need("side");
const inspector = new Inspector(side);
const kvPanel = new KVPanel(side, app);
const feed = new Feed(side);
const logMatrix = new LogMatrix(need("logmatrix"));
const timeline = new Timeline(need("timeline"), app);
const messageModal = new MessageModal(need("modal"), app);

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      app.togglePause();
      break;
    case "l":
    case "L":
      app.goLive();
      break;
    case "Escape":
      if (app.selectedFlight !== null) {
        app.closeFlight();
        break;
      }
      app.select(app.selected);
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      e.preventDefault();
      const span = app.sim.duration - app.sim.horizon;
      const step = Math.max(span * 0.02, 50);
      app.scrub(app.playhead + (e.key === "ArrowLeft" ? -step : step));
      break;
    }
    case "[":
      app.setSpeed(app.speed / 1.5);
      break;
    case "]":
      app.setSpeed(app.speed * 1.5);
      break;
  }
});

// Debug/console affordance: drive the sim from devtools.
declare global {
  interface Window {
    __raft: App;
  }
}
window.__raft = app;

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  app.tick(dt);
  scene.update(app.renderView(), dt, app.paused);
  topbar.update(app);
  chaosPanel.update(app);
  timingPanel.update(app);
  inspector.update(app);
  kvPanel.update(app);
  feed.update(app);
  logMatrix.update(app);
  timeline.update();
  messageModal.update(app);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
