import * as THREE from "three";

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft white radial glow — tinted per-use via material color. */
export function createGlowTexture(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

/** Faint blue pool of light the cluster stands on. */
export function createStageTexture(): THREE.Texture {
  return canvasTexture(512, (ctx) => {
    const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
    g.addColorStop(0, "rgba(86,128,205,0.2)");
    g.addColorStop(0.5, "rgba(70,105,180,0.07)");
    g.addColorStop(1, "rgba(60,90,160,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
  });
}

/**
 * The partition barrier: an energy curtain, brightest at its base and
 * fading up, melting away at the left/right edges, with faint vertical
 * striations. White here, tinted red by the material it's drawn with.
 */
export function createWallTexture(): THREE.Texture {
  return canvasTexture(256, (ctx) => {
    const S = 256;

    // Rises from the ground (canvas bottom), fading toward the top.
    const v = ctx.createLinearGradient(0, S, 0, 0);
    v.addColorStop(0, "rgba(255,255,255,0.9)");
    v.addColorStop(0.4, "rgba(255,255,255,0.4)");
    v.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, S, S);

    // Vertical energy striations.
    ctx.globalCompositeOperation = "destination-out";
    for (let x = 0; x < S; x += 7) {
      ctx.fillStyle = `rgba(0,0,0,${0.18 + 0.12 * Math.sin(x * 0.7)})`;
      ctx.fillRect(x, 0, 2.5, S);
    }

    // Soft fade at the two ends so the curtain dissolves into space.
    const edge = ctx.createLinearGradient(0, 0, S, 0);
    edge.addColorStop(0, "rgba(0,0,0,1)");
    edge.addColorStop(0.16, "rgba(0,0,0,0)");
    edge.addColorStop(0.84, "rgba(0,0,0,0)");
    edge.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "source-over";
  });
}
