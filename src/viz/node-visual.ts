import * as THREE from "three";
import { ROLE_COLORS, termColor } from "../theme.ts";
import type { NodeView } from "./types.ts";

const TIMER_RING_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Arc that depletes clockwise from 12 o'clock as the election timer runs. */
const TIMER_RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFraction;
  uniform float uOpacity;
  varying vec2 vPos;
  const float TAU = 6.28318530718;
  void main() {
    float angle = atan(-vPos.x, vPos.y); // 0 at top, increasing clockwise
    float a = mod(angle / TAU + 1.0, 1.0);
    if (a > uFraction) discard;
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

export interface NodeVisualContext {
  readonly coreGeometry: THREE.SphereGeometry;
  readonly ringGeometry: THREE.RingGeometry;
  readonly selectGeometry: THREE.RingGeometry;
  readonly glowTexture: THREE.Texture;
}

/** Builds shared geometry/texture resources used by every node visual. */
export function createNodeVisualContext(glowTexture: THREE.Texture): NodeVisualContext {
  return {
    coreGeometry: new THREE.SphereGeometry(0.4, 32, 24),
    ringGeometry: new THREE.RingGeometry(0.84, 0.94, 64),
    selectGeometry: new THREE.RingGeometry(1.08, 1.12, 64),
    glowTexture,
  };
}

export class NodeVisual {
  readonly group: THREE.Group;
  readonly core: THREE.Mesh;

  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly halo: THREE.Sprite;
  private readonly corona: THREE.Sprite;
  private readonly timerRing: THREE.Mesh;
  private readonly timerMaterial: THREE.ShaderMaterial;
  private readonly selectRing: THREE.Mesh;

  private targetColor = new THREE.Color(ROLE_COLORS.follower);
  private targetHalo = 0.5;
  private targetCorona = 0;
  private targetY = 0;
  private breathe = Math.random() * Math.PI * 2;

  constructor(ctx: NodeVisualContext) {
    this.group = new THREE.Group();

    this.coreMaterial = new THREE.MeshBasicMaterial({ color: ROLE_COLORS.follower });
    this.core = new THREE.Mesh(ctx.coreGeometry, this.coreMaterial);
    this.group.add(this.core);

    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ctx.glowTexture,
        color: ROLE_COLORS.follower,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.halo.scale.setScalar(1.9);
    this.group.add(this.halo);

    this.corona = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ctx.glowTexture,
        color: ROLE_COLORS.leader,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.corona.scale.setScalar(2.9);
    this.group.add(this.corona);

    this.timerMaterial = new THREE.ShaderMaterial({
      vertexShader: TIMER_RING_VERT,
      fragmentShader: TIMER_RING_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(ROLE_COLORS.follower) },
        uFraction: { value: 1 },
        uOpacity: { value: 0.85 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.timerRing = new THREE.Mesh(ctx.ringGeometry, this.timerMaterial);
    this.timerRing.rotation.x = -Math.PI / 2;
    this.timerRing.position.y = -0.02;
    this.group.add(this.timerRing);

    this.selectRing = new THREE.Mesh(
      ctx.selectGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.position.y = -0.04;
    this.selectRing.visible = false;
    this.group.add(this.selectRing);
  }

  apply(view: NodeView): void {
    // Cores and rings wear their term's color (same cycle as log cells and
    // the term tape). A node that slept through elections keeps its stale
    // color until the new leader's first AppendEntries teaches it the term.
    const core = new THREE.Color(termColor(view.term));
    if (view.stopped) core.multiplyScalar(0.45);
    this.targetColor = core;

    this.targetHalo = view.stopped ? 0.1 : view.role === "leader" ? 0.34 : 0.3;
    this.targetCorona = view.role === "leader" && !view.stopped ? 0.18 : 0;
    this.targetY = view.stopped ? -0.3 : 0;

    const uniforms = this.timerMaterial.uniforms;
    if (view.timerFraction === null) {
      if (uniforms.uOpacity) uniforms.uOpacity.value = 0;
    } else {
      if (uniforms.uOpacity) uniforms.uOpacity.value = 0.85;
      if (uniforms.uFraction) uniforms.uFraction.value = view.timerFraction;
      const ringColor = uniforms.uColor?.value as THREE.Color | undefined;
      ringColor?.set(termColor(view.term));
    }

    this.selectRing.visible = view.selected;
  }

  animate(dt: number): void {
    const k = 1 - Math.exp(-dt * 9);
    // Boosted past 1.0 so the bloom pass picks the cores up.
    const boosted = this.targetColor.clone().multiplyScalar(1.18);
    this.coreMaterial.color.lerp(boosted, k);

    const haloMat = this.halo.material;
    haloMat.color.lerp(this.targetColor, k);
    haloMat.opacity += (this.targetHalo - haloMat.opacity) * k;

    this.breathe += dt * 1.7;
    const coronaMat = this.corona.material;
    const breatheAmp = this.targetCorona > 0 ? 0.07 * Math.sin(this.breathe) : 0;
    coronaMat.opacity += (this.targetCorona + breatheAmp - coronaMat.opacity) * k;

    this.core.position.y += (this.targetY - this.core.position.y) * k;
    this.halo.position.y = this.core.position.y;
    this.corona.position.y = this.core.position.y;
  }

  dispose(): void {
    this.coreMaterial.dispose();
    this.halo.material.dispose();
    this.corona.material.dispose();
    this.timerMaterial.dispose();
    (this.selectRing.material as THREE.Material).dispose();
  }
}
