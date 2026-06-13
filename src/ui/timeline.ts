import { MAX_SPEED, MIN_SPEED, type App } from "../app.ts";
import { DANGER, termColor } from "../theme.ts";
import { el, formatTime } from "./format.ts";

const formatSpeed = (s: number): string => `${parseFloat(s.toFixed(3))}×`;

/**
 * The term tape: a scrubber whose track is painted with the cluster's
 * history — term epochs as colored bands, elections as gold ticks,
 * crashes in red, client writes as small notches along the bottom.
 */
export class Timeline {
  private readonly playBtn: HTMLButtonElement;
  private readonly speedSlider: HTMLInputElement;
  private readonly speedReadout: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly tape: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly wrap: HTMLElement;
  private readonly liveBtn: HTMLButtonElement;

  private readonly app: App;
  private dragging = false;
  private wasPausedBeforeDrag = false;
  private lastPaintAt = 0;
  private lastPaintedDuration = -1;
  private lastPaintedFrames = -1;

  constructor(container: HTMLElement, app: App) {
    this.app = app;
    container.classList.add("panel");

    const transport = el("div", "transport");
    this.playBtn = el("button", "play-btn", "❚❚");
    this.playBtn.title = "Play/pause (space)";
    this.playBtn.addEventListener("click", () => app.togglePause());

    // Logarithmic speed slider: equal drag distance = equal speed ratio.
    const speedCtl = el("div", "speed-ctl");
    this.speedSlider = el("input") as HTMLInputElement;
    this.speedSlider.type = "range";
    this.speedSlider.min = String(Math.log10(MIN_SPEED));
    this.speedSlider.max = String(Math.log10(MAX_SPEED));
    this.speedSlider.step = "any";
    this.speedSlider.value = String(Math.log10(app.speed));
    this.speedSlider.setAttribute("aria-label", "playback speed");
    this.speedSlider.addEventListener("input", () => {
      app.setSpeed(10 ** Number(this.speedSlider.value));
    });
    this.speedReadout = el("span", "speed-readout", formatSpeed(app.speed));
    speedCtl.append(this.speedSlider, this.speedReadout);
    transport.append(this.playBtn, speedCtl);

    this.readout = el("div", "time-readout", "00:00.000");

    this.wrap = el("div", "tape-wrap");
    this.tape = el("canvas") as HTMLCanvasElement;
    this.overlay = el("canvas") as HTMLCanvasElement;
    this.wrap.append(this.tape, this.overlay);
    this.bindScrub();

    this.liveBtn = el("button", "live-btn");
    this.liveBtn.append(el("span", "pulse"), el("span", "", "LIVE"));
    this.liveBtn.title = "Jump to now (L)";
    this.liveBtn.addEventListener("click", () => app.goLive());

    container.append(transport, this.readout, this.wrap, this.liveBtn);
    new ResizeObserver(() => {
      this.lastPaintedDuration = -1;
      this.resizeCanvas(this.tape);
      this.resizeCanvas(this.overlay);
    }).observe(this.wrap);
    this.resizeCanvas(this.tape);
    this.resizeCanvas(this.overlay);
  }

  update(): void {
    const app = this.app;
    this.playBtn.textContent = app.paused ? "▶" : "❚❚";
    this.readout.textContent = formatTime(app.playhead);
    this.liveBtn.classList.toggle("is-live", app.live && !app.paused);

    // Keep the slider honest when speed changes elsewhere (keyboard).
    const sliderLog = Number(this.speedSlider.value);
    const actualLog = Math.log10(app.speed);
    if (Math.abs(sliderLog - actualLog) > 1e-6) {
      this.speedSlider.value = String(actualLog);
    }
    this.speedReadout.textContent = formatSpeed(app.speed);

    const now = performance.now();
    const framesCount = app.sim.frames.length;
    if (
      this.lastPaintedDuration < 0 ||
      (now - this.lastPaintAt > 250 &&
        (app.sim.duration !== this.lastPaintedDuration || framesCount !== this.lastPaintedFrames))
    ) {
      this.paintTape();
      this.lastPaintAt = now;
      this.lastPaintedDuration = app.sim.duration;
      this.lastPaintedFrames = framesCount;
    }
    this.paintOverlay();
  }

  // -------------------------------------------------------------------------

  private timeToX(t: number, width: number): number {
    const { horizon, duration } = this.app.sim;
    const span = Math.max(duration - horizon, 1);
    return ((t - horizon) / span) * width;
  }

  private xToTime(x: number, width: number): number {
    const { horizon, duration } = this.app.sim;
    const span = Math.max(duration - horizon, 1);
    return horizon + (Math.min(Math.max(x, 0), width) / width) * span;
  }

  private paintTape(): void {
    const ctx = this.tape.getContext("2d");
    if (!ctx) return;
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, 0, w, h);

    const frames = this.app.sim.frames;
    if (frames.length === 0) return;

    // Term epoch bands.
    let epochTerm = 0;
    let epochStart = this.app.sim.horizon;
    const flushEpoch = (until: number): void => {
      if (epochTerm <= 0) return;
      const x0 = this.timeToX(epochStart, w);
      const x1 = this.timeToX(until, w);
      ctx.fillStyle = termColor(epochTerm);
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0, 0, Math.max(x1 - x0, 0.5), h);
      ctx.globalAlpha = 1;
    };

    interface Tick {
      x: number;
      kind: "election" | "crash" | "write";
    }
    const ticks: Tick[] = [];

    for (const frame of frames) {
      let term = 0;
      for (const node of frame.nodes) term = Math.max(term, node.currentTerm);
      if (term !== epochTerm) {
        flushEpoch(frame.time);
        epochTerm = term;
        epochStart = frame.time;
      }
      if (frame.cause.kind === "clientPropose") {
        ticks.push({ x: this.timeToX(frame.time, w), kind: "write" });
      } else if (frame.cause.kind === "nodeStopped" || frame.cause.kind === "nodeRemoved") {
        ticks.push({ x: this.timeToX(frame.time, w), kind: "crash" });
      }
      for (const { event } of frame.raftEvents) {
        if (event.type === "becameLeader") {
          ticks.push({ x: this.timeToX(frame.time, w), kind: "election" });
        }
      }
    }
    flushEpoch(this.app.sim.duration);

    for (const tick of ticks) {
      switch (tick.kind) {
        case "write":
          ctx.fillStyle = "rgba(89,214,242,0.5)";
          ctx.fillRect(tick.x, h - 7, 1, 7);
          break;
        case "crash":
          ctx.fillStyle = DANGER;
          ctx.fillRect(tick.x - 0.5, 0, 1.5, h);
          break;
        case "election":
          ctx.fillStyle = "#ffc24b";
          ctx.fillRect(tick.x - 1, 0, 2, h);
          break;
      }
    }
  }

  private paintOverlay(): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const x = this.timeToX(this.app.playhead, w);
    ctx.fillStyle = "rgba(217,226,242,0.95)";
    ctx.fillRect(x - 0.75, 0, 1.5, h);
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  }

  private bindScrub(): void {
    const onMove = (e: PointerEvent): void => {
      const rect = this.wrap.getBoundingClientRect();
      this.app.scrub(this.xToTime(e.clientX - rect.left, rect.width));
    };
    this.wrap.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.wasPausedBeforeDrag = this.app.paused;
      this.app.paused = true;
      this.wrap.setPointerCapture(e.pointerId);
      onMove(e);
    });
    this.wrap.addEventListener("pointermove", (e) => {
      if (this.dragging) onMove(e);
    });
    this.wrap.addEventListener("pointerup", () => {
      this.dragging = false;
      this.app.paused = this.wasPausedBeforeDrag;
    });
  }

  private resizeCanvas(canvas: HTMLCanvasElement): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, this.wrap.clientWidth * dpr);
    canvas.height = Math.max(1, this.wrap.clientHeight * dpr);
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
