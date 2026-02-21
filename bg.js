/**
 * Forest fly-through — camera drifts between tall trees.
 * Trees are rendered as tapered vertical beams lit from above.
 * No sky or ground is visible — only the gradient light on trunks.
 * Trees fade in/out through depth-fog so they never pop.
 */

const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");

// ─── tunables ────────────────────────────────────────────────────────────────
const DEPTH_FAR   = 55;         // max spawn depth
const DEPTH_NEAR  = 8;          // min spawn depth
const HALF_W      = 20;         // half-width of the forest lane (world units)
const SAFE_LANE   = 1.6;        // camera corridor half-width (trees never here)
const SPEED_BASE  = 0.016;      // world units per ms
const DRIFT_AMP   = 4.5;        // left/right camera drift amplitude
const DRIFT_FREQ  = 0.00016;    // drift oscillation frequency
const FOG_IN_Z    = 3.5;        // trees fade in from this distance to camera
const TREE_COUNT  = 165;        // target trees alive at once

// ─── state ───────────────────────────────────────────────────────────────────
let W = 0, H = 0, dpr = 1;

const cam = {
  x:       0,
  fov:     0,
  horizonY: 0,
};

const trees = [];
const g = {};   // gradient cache

// ─── helpers ─────────────────────────────────────────────────────────────────
function rand(a, b) { return Math.random() * (b - a) + a; }

function spawnTree(z, preborn) {
  if (z == null) z = rand(DEPTH_NEAR, DEPTH_FAR);
  let x;
  do { x = rand(-HALF_W, HALF_W); } while (Math.abs(x) < SAFE_LANE);
  trees.push({
    x, z,
    trunkW: rand(0.25, 0.70),
    hue:    rand(174, 216),
    lit:    rand(0.5, 1.0),
    fade:   preborn ? 1 : 0,   // start invisible, fade in
  });
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W   = window.innerWidth;
  H   = window.innerHeight;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width  = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cam.fov      = Math.max(W, H) * 1.55;
  cam.horizonY = H * 0.5;

  buildGradients();

  // seed forest
  const had = trees.length;
  while (trees.length < TREE_COUNT) spawnTree(rand(0.8, DEPTH_FAR), true);
  if (!had) trees.sort((a, b) => b.z - a.z);
}

function buildGradients() {
  // Background — fills entire screen, no sky/ground boundary, only vertical
  // light-to-dark representing the light pouring down from above the canopy.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0.00, "#b8f2a8");   // bright canopy-top
  bg.addColorStop(0.08, "#72e4b8");
  bg.addColorStop(0.25, "#38b8d8");
  bg.addColorStop(0.50, "#2255c4");
  bg.addColorStop(0.74, "#1e34a0");
  bg.addColorStop(1.00, "#100b58");   // deep floor shadow
  g.bg = bg;

  // Bright bloom at the vanishing point (where canopy opens)
  const bx = W * 0.5, by = cam.horizonY;
  const br = Math.max(W, H) * 0.72;
  const bloom = ctx.createRadialGradient(bx, by, 0, bx, by, br);
  bloom.addColorStop(0.00, "rgba(215, 255, 185, 0.60)");
  bloom.addColorStop(0.10, "rgba(155, 248, 205, 0.25)");
  bloom.addColorStop(0.38, "rgba(80,  195, 238, 0.09)");
  bloom.addColorStop(1.00, "rgba(35,   90, 210, 0)");
  g.bloom = bloom;

  // Atmospheric depth haze — softens far trees into the gradient
  const fog = ctx.createLinearGradient(0, 0, 0, H);
  fog.addColorStop(0.00, "rgba(100, 210, 235, 0.10)");
  fog.addColorStop(0.44, "rgba( 55, 135, 220, 0.20)");
  fog.addColorStop(0.56, "rgba( 55, 130, 215, 0.20)");
  fog.addColorStop(1.00, "rgba( 28,  65, 170, 0.10)");
  g.fog = fog;
}

// ─── draw ─────────────────────────────────────────────────────────────────────
function drawBackground() {
  ctx.globalAlpha = 1;
  ctx.fillStyle = g.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = g.bloom;
  ctx.fillRect(0, 0, W, H);
}

function drawTree(tree) {
  const { x, z, trunkW, hue, lit, fade } = tree;

  // Depth 0=far 1=close
  const depth = Math.max(0, Math.min(1, 1 - (z - DEPTH_NEAR) / (DEPTH_FAR - DEPTH_NEAR)));

  // Near-clip fade (prevent popping when recycled)
  const nearAlpha = z < FOG_IN_Z ? Math.max(0, (z - 1.2) / (FOG_IN_Z - 1.2)) : 1;
  // Far fade so distant trees dissolve into background instead of hard-appearing
  const farAlpha  = Math.max(0, Math.min(1, (DEPTH_FAR - z) / (DEPTH_FAR * 0.18)));
  const alpha     = fade * nearAlpha * farAlpha;
  if (alpha <= 0.002) return;

  const scale   = cam.fov / z;
  const screenX = W * 0.5 + (x - cam.x) * scale;
  const baseW   = trunkW * scale;

  // Vanishing-point convergence for top of beam
  // Trees converge toward a point far ahead (horizon at center)
  const vScale  = cam.fov / (DEPTH_FAR * 4);   // very distant projection
  const vx      = W * 0.5 + (x - cam.x) * vScale;
  const topW    = Math.max(0.6, baseW * 0.022);
  const topY    = -H * 0.12;       // bleed off top edge
  const bottomY = H * 1.12;        // bleed off bottom edge

  // --- solid tinted body ---
  ctx.globalAlpha = (0.07 + depth * 0.28) * alpha;
  ctx.fillStyle   = `hsl(${hue}, 58%, ${36 + depth * 16}%)`;
  ctx.beginPath();
  ctx.moveTo(vx - topW,         topY);
  ctx.lineTo(vx + topW,         topY);
  ctx.lineTo(screenX + baseW,   bottomY);
  ctx.lineTo(screenX - baseW,   bottomY);
  ctx.closePath();
  ctx.fill();

  // --- top-down glow gradient ---
  const gr = ctx.createLinearGradient(0, topY, 0, bottomY);
  const ga = lit * alpha;
  gr.addColorStop(0.00, `hsla(${hue - 14}, 92%, 90%, ${0.75 * ga})`);
  gr.addColorStop(0.15, `hsla(${hue -  7}, 84%, 72%, ${0.42 * ga})`);
  gr.addColorStop(0.46, `hsla(${hue},      72%, 54%, ${0.13 * ga})`);
  gr.addColorStop(1.00, `hsla(${hue + 10}, 66%, 30%, 0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle   = gr;
  ctx.beginPath();
  ctx.moveTo(vx - topW,         topY);
  ctx.lineTo(vx + topW,         topY);
  ctx.lineTo(screenX + baseW,   bottomY);
  ctx.lineTo(screenX - baseW,   bottomY);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 1;
}

// ─── update ───────────────────────────────────────────────────────────────────
function update(dt, t) {
  // Smooth S-curve camera drift — no straight lines
  cam.x = Math.sin(t * DRIFT_FREQ) * DRIFT_AMP
        + Math.sin(t * DRIFT_FREQ * 2.6 + 1.1) * DRIFT_AMP * 0.38
        + Math.sin(t * DRIFT_FREQ * 0.7 + 2.4) * DRIFT_AMP * 0.20;

  const move = SPEED_BASE * dt;

  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    tr.z -= move;

    // Fade in
    if (tr.fade < 1) tr.fade = Math.min(1, tr.fade + dt * 0.0015);

    // Recycle past camera
    if (tr.z < 1.1) {
      trees.splice(i, 1);
      // New tree spawns far away and starts fading in
      spawnTree(rand(DEPTH_FAR * 0.72, DEPTH_FAR), false);
    }
  }

  // Safety top-up
  while (trees.length < TREE_COUNT) spawnTree(null, false);

  // Painter's order: far first
  trees.sort((a, b) => b.z - a.z);
}

// ─── frame loop ──────────────────────────────────────────────────────────────
let lastT = 0;

function frame(t) {
  const dt = lastT ? Math.min(t - lastT, 48) : 16;
  lastT = t;

  drawBackground();
  update(dt, t);

  for (let i = 0; i < trees.length; i++) drawTree(trees[i]);

  // Depth-fog pass
  ctx.fillStyle = g.fog;
  ctx.fillRect(0, 0, W, H);

  // Bloom reinforcement
  ctx.globalAlpha = 0.40;
  ctx.fillStyle   = g.bloom;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  requestAnimationFrame(frame);
}

// ─── boot ─────────────────────────────────────────────────────────────────────
resize();
window.addEventListener("resize", resize);
requestAnimationFrame(frame);
