import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { NodeId } from "../raft/index.ts";
import { INK, REDUCED_MOTION, ROLE_CSS, termColor } from "../theme.ts";
import { createFx, type Fx } from "./fx.ts";
import { FlightVisual, flightCurve } from "./flight-visual.ts";
import { createNodeVisualContext, NodeVisual, type NodeVisualContext } from "./node-visual.ts";
import { createGlowTexture, createStageTexture } from "./textures.ts";
import type { NodeView, RenderView } from "./types.ts";

const RING_RADIUS = 6;
const TAU = Math.PI * 2;

/**
 * Framing radii used to pick a field of view that fits the cluster for the
 * current aspect ratio. `FIT_H` is the hard horizontal limit (ring + node
 * halo) that must always stay on-screen so no node spills off the edge;
 * `FIT_V` is the looser vertical-comfort radius, calibrated so wide screens
 * reproduce the original ~42° look (vertical-bound) while portrait/narrow
 * viewports widen the FOV instead of clipping the sides.
 */
const FIT_H = 7;
const FIT_V = 9.4;

export interface SceneCallbacks {
  onSelectNode(id: NodeId | null): void;
}

export class ClusterScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly root: THREE.Group;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;

  private readonly glowTexture: THREE.Texture;
  private readonly nodeCtx: NodeVisualContext;
  private readonly starfield: THREE.Points;

  private readonly container: HTMLElement;
  private readonly labelLayer: HTMLElement;
  private readonly callbacks: SceneCallbacks;

  private readonly nodeVisuals = new Map<NodeId, NodeVisual>();
  private readonly labels = new Map<NodeId, HTMLElement>();
  private readonly angles = new Map<NodeId, { current: number; target: number }>();
  private readonly flightVisuals = new Map<number, FlightVisual>();
  private fx: Fx[] = [];

  private readonly controls: OrbitControls;
  private readonly pointer = new THREE.Vector2(99, 99);
  private readonly raycaster = new THREE.Raycaster();
  private pointerDownAt: { x: number; y: number } | null = null;
  private hovered: NodeId | null = null;
  private elapsed = 0;
  private fxEpoch = 0;

  constructor(container: HTMLElement, labelLayer: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(INK);
    this.scene.fog = new THREE.FogExp2(INK, 0.016);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 14.2, 20);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.55;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 42;
    // Keep the camera above the plane and out of the floor.
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.45;

    this.glowTexture = createGlowTexture();
    this.nodeCtx = createNodeVisualContext(this.glowTexture);

    // The stage: a pool of light and a faint orbit guide where nodes sit.
    const stage = new THREE.Mesh(
      new THREE.CircleGeometry(9.4, 64),
      new THREE.MeshBasicMaterial({
        map: createStageTexture(),
        transparent: true,
        depthWrite: false,
      }),
    );
    stage.rotation.x = -Math.PI / 2;
    stage.position.y = -0.55;
    this.root.add(stage);

    const guidePoints: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i += 1) {
      const a = (i / 128) * TAU;
      guidePoints.push(
        new THREE.Vector3(Math.sin(a) * RING_RADIUS, -0.5, -Math.cos(a) * RING_RADIUS),
      );
    }
    const guide = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(guidePoints),
      new THREE.LineBasicMaterial({ color: 0x24304a, transparent: true, opacity: 0.55 }),
    );
    this.root.add(guide);

    this.starfield = this.createStarfield();
    this.scene.add(this.starfield);

    const size = new THREE.Vector2(container.clientWidth || 1, container.clientHeight || 1);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, 0.55, 0.55, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindPointer();
  }

  /** Draw one frame of the world. `dt` is wall-clock seconds. */
  update(view: RenderView, dt: number, paused: boolean): void {
    void paused;
    this.elapsed += dt;
    this.layoutAngles(view);
    this.reconcileNodes(view, dt);
    this.reconcileFlights(view);

    // Stale transients from a discarded present (scrub-back / fork).
    if (view.fxEpoch !== this.fxEpoch) {
      this.fxEpoch = view.fxEpoch;
      for (const fx of this.fx) {
        this.root.remove(fx.object);
        fx.dispose();
      }
      this.fx = [];
    }
    this.spawnFx(view);

    // Transients always run on wall time so they finish even while paused.
    this.fx = this.fx.filter((fx) => {
      if (fx.update(dt)) return true;
      this.root.remove(fx.object);
      fx.dispose();
      return false;
    });

    if (!REDUCED_MOTION) {
      this.root.rotation.y = Math.sin(this.elapsed * 0.05) * 0.05;
      this.starfield.rotation.y += dt * 0.004;
    }
    this.controls.update();

    this.pick(view);
    this.placeLabels(view);
    this.composer.render();
  }

  positionOf(id: NodeId): THREE.Vector3 {
    const angle = this.angles.get(id);
    const a = angle?.current ?? 0;
    return new THREE.Vector3(Math.sin(a) * RING_RADIUS, 0, -Math.cos(a) * RING_RADIUS);
  }

  // -------------------------------------------------------------------------

  private layoutAngles(view: RenderView): void {
    const ids = view.nodes.map((n) => n.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

    for (const [i, id] of ids.entries()) {
      const target = (i / ids.length) * TAU;
      const entry = this.angles.get(id);
      if (!entry) {
        this.angles.set(id, { current: target, target });
      } else {
        entry.target = target;
      }
    }
    for (const id of this.angles.keys()) {
      if (!ids.includes(id)) this.angles.delete(id);
    }
    // Ease every node toward its slot (shortest way around the ring).
    for (const entry of this.angles.values()) {
      let delta = (entry.target - entry.current) % TAU;
      if (delta > Math.PI) delta -= TAU;
      if (delta < -Math.PI) delta += TAU;
      entry.current += delta * 0.08;
    }
  }

  private reconcileNodes(view: RenderView, dt: number): void {
    const seen = new Set<NodeId>();
    for (const nodeView of view.nodes) {
      seen.add(nodeView.id);
      let visual = this.nodeVisuals.get(nodeView.id);
      if (!visual) {
        visual = new NodeVisual(this.nodeCtx);
        this.nodeVisuals.set(nodeView.id, visual);
        this.root.add(visual.group);
        this.createLabel(nodeView.id);
      }
      visual.group.position.copy(this.positionOf(nodeView.id));
      visual.apply(nodeView);
      visual.animate(dt);
    }
    for (const [id, visual] of this.nodeVisuals) {
      if (!seen.has(id)) {
        this.root.remove(visual.group);
        visual.dispose();
        this.nodeVisuals.delete(id);
        this.labels.get(id)?.remove();
        this.labels.delete(id);
      }
    }
  }

  private reconcileFlights(view: RenderView): void {
    const seen = new Set<number>();
    for (const flight of view.flights) {
      seen.add(flight.id);
      let visual = this.flightVisuals.get(flight.id);
      if (!visual) {
        const from = this.positionOf(flight.from);
        const to = this.positionOf(flight.to);
        const laneSign = flight.from < flight.to ? 1 : -1;
        visual = new FlightVisual(flight.kind, from, to, this.glowTexture, laneSign);
        this.flightVisuals.set(flight.id, visual);
        this.root.add(visual.group);
      }
      visual.apply(flight);
    }
    for (const [id, visual] of this.flightVisuals) {
      if (!seen.has(id)) {
        this.root.remove(visual.group);
        visual.dispose();
        this.flightVisuals.delete(id);
      }
    }
  }

  private spawnFx(view: RenderView): void {
    for (const spawn of view.fx) {
      let fx: Fx;
      if (spawn.kind === "burst") {
        // Explosion along a flight arc — where a packet died.
        if (!this.angles.has(spawn.from) || !this.angles.has(spawn.to)) continue;
        const curve = flightCurve(
          this.positionOf(spawn.from),
          this.positionOf(spawn.to),
          spawn.from < spawn.to ? 1 : -1,
        );
        fx = createFx("fizzle", curve.getPoint(spawn.progress), this.glowTexture);
      } else {
        if (!this.angles.has(spawn.nodeId)) continue;
        fx = createFx(spawn.kind, this.positionOf(spawn.nodeId), this.glowTexture);
      }
      this.fx.push(fx);
      this.root.add(fx.object);
    }
  }

  private createLabel(id: NodeId): void {
    const el = document.createElement("button");
    el.className = "node-label";
    el.type = "button";
    el.style.background = "none";
    el.innerHTML = `<div class="node-id"></div><div class="node-role"></div><div class="node-cells"></div>`;
    el.addEventListener("click", () => this.callbacks.onSelectNode(id));
    this.labelLayer.appendChild(el);
    this.labels.set(id, el);
  }

  private placeLabels(view: RenderView): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const scratch = new THREE.Vector3();

    for (const nodeView of view.nodes) {
      const el = this.labels.get(nodeView.id);
      const visual = this.nodeVisuals.get(nodeView.id);
      if (!el || !visual) continue;

      visual.group.getWorldPosition(scratch);
      scratch.y -= 1.1;
      scratch.project(this.camera);
      const x = (scratch.x * 0.5 + 0.5) * w;
      const y = (-scratch.y * 0.5 + 0.5) * h;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.display = scratch.z > 1 ? "none" : "";

      const idEl = el.querySelector<HTMLElement>(".node-id");
      const roleEl = el.querySelector<HTMLElement>(".node-role");
      const css = nodeView.stopped ? ROLE_CSS.stopped : ROLE_CSS[nodeView.role];
      if (idEl) {
        idEl.textContent = nodeView.id;
        idEl.style.color = css;
      }
      if (roleEl) {
        roleEl.textContent = nodeView.stopped ? "down" : nodeView.role;
      }
      this.updateLogStrip(el, nodeView);
      el.classList.toggle("is-selected", nodeView.selected);
      el.classList.toggle("is-stopped", nodeView.stopped);
    }
  }

  /** Mini replicated-log strip under the label: missing / appended / committed. */
  private updateLogStrip(label: HTMLElement, nodeView: NodeView): void {
    const cellsEl = label.querySelector<HTMLElement>(".node-cells");
    if (!cellsEl) return;

    const signature = nodeView.logCells
      .map((c) => (c ? `${c.term}${c.committed ? "c" : "u"}` : "x"))
      .join(",");
    if (cellsEl.dataset.sig === signature) return;
    cellsEl.dataset.sig = signature;

    cellsEl.replaceChildren();
    for (const cell of nodeView.logCells) {
      const span = document.createElement("span");
      if (cell) {
        span.className = cell.committed ? "node-cell committed" : "node-cell";
        span.style.setProperty("--cell", termColor(cell.term));
      } else {
        span.className = "node-cell missing";
      }
      cellsEl.appendChild(span);
    }
  }

  private pick(view: RenderView): void {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const cores = [...this.nodeVisuals.values()].map((v) => v.core);
    const hits = this.raycaster.intersectObjects(cores, false);
    const hit = hits[0]?.object;

    this.hovered = null;
    if (hit) {
      for (const [id, visual] of this.nodeVisuals) {
        if (visual.core === hit) {
          this.hovered = id;
          break;
        }
      }
    }
    this.renderer.domElement.style.cursor = this.hovered ? "pointer" : "default";

    // Keep selection valid if the node vanished.
    void view;
  }

  private bindPointer(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener("pointermove", (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    });
    dom.addEventListener("pointerdown", (e) => {
      this.pointerDownAt = { x: e.clientX, y: e.clientY };
    });
    dom.addEventListener("pointerup", (e) => {
      const down = this.pointerDownAt;
      this.pointerDownAt = null;
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved > 6) return;
      this.callbacks.onSelectNode(this.hovered);
    });
  }

  private createStarfield(): THREE.Points {
    const COUNT = 360;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i += 1) {
      const r = 28 + Math.random() * 38;
      const theta = Math.random() * TAU;
      const y = (Math.random() - 0.25) * 34;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * r;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x7e9bff,
        size: 0.08,
        transparent: true,
        opacity: 0.5,
        sizeAttenuation: true,
      }),
    );
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const compact = w <= 700;

    // Re-center the cluster in the area not covered by HUD chrome: dial
    // panels on the left, the side panel stack on the right, and the
    // timeline along the bottom. The virtual frame is extended by all
    // reserved space; the full-frame center then lands at the free area's
    // center. In compact mode the side stacks collapse into the bottom
    // drawer, so only the bottom chrome (timeline + tab bar) is reserved.
    const reserveRight = compact ? 0 : 316; // #side width + margin
    const reserveLeft = compact ? 0 : 264; // #dials width + margin
    const reserveBottom = compact ? 168 : 260; // timeline (+ tab bar / log matrix)
    const fullW = w + reserveRight + reserveLeft;
    const fullH = h + reserveBottom;
    const aspect = fullW / fullH;

    // Adapt the field of view to the aspect ratio so the whole ring stays
    // framed. Wide screens are vertical-bound (FIT_V → ~42°, unchanged);
    // narrow/portrait viewports become horizontal-bound and widen the FOV
    // instead of clipping n4/n5 off the left and right edges.
    const dist = this.camera.position.distanceTo(this.controls.target);
    const tanHalf = Math.max(FIT_V / dist, FIT_H / dist / aspect);
    this.camera.fov = THREE.MathUtils.clamp(
      THREE.MathUtils.radToDeg(2 * Math.atan(tanHalf)),
      38,
      72,
    );

    this.camera.aspect = aspect;
    this.camera.setViewOffset(fullW, fullH, reserveRight, reserveBottom, w, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }
}
