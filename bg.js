/**
 * Forest fly-through — camera drifts between tall trees.
 * Trees are rendered as tapered vertical beams lit from above.
 * No sky or ground is visible — only the gradient light on trunks.
 * Trees fade in/out through depth-fog so they never pop.
 */

const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");

// ─── tunables ────────────────────────────────────────────────────────────────
const DEPTH_FAR = 170; // max spawn depth (for deep matrix visibility)
const DEPTH_NEAR = 8; // min spawn depth
const GRID_COLS = 10; // forest matrix width  (x)
const GRID_ROWS = 10; // forest matrix depth  (z)
const SPEED_BASE = 0.004; // world units per ms
const DRIFT_AMP = 0.35; // subtle drift only (no visible center corridor)
const DRIFT_FREQ = 0.00008; // drift oscillation frequency
const FOG_IN_Z = 3.5; // trees fade in from this distance to camera
const X_SPACING = 2.55; // world-units between matrix columns
const Z_SPACING = 2.1; // world-units between matrix rows
const VIEW_ANGLE_MIN_DEG = 85;
const VIEW_ANGLE_MAX_DEG = 115;
const VIEW_SWEEP_MS = 20000; // 85->115 in 10s, then back in 10s

let yawCos = 1;
let yawSin = 0;

// ─── state ───────────────────────────────────────────────────────────────────
let W = 0,
  H = 0,
  dpr = 1;

const cam = {
  x: 0,
  fov: 0,
  horizonY: 0,
};

const trees = [];
const g = {}; // gradient cache

// ─── helpers ─────────────────────────────────────────────────────────────────

// Seeded PRNG (mulberry32) — same result every page load
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xabcd1234);
function randS(a, b) {
  return rng() * (b - a) + a;
}

// Number of rows per column and full Z-span — computed once when forest is built
let rowsPerCol = 0;
let worldZSpan = 0;
let forestReady = false;

function buildForest() {
  trees.length = 0;

  // Dense matrix of trees — no center corridor or missing middle lane
  const halfSpanX = (GRID_COLS - 1) * X_SPACING * 0.5;
  rowsPerCol = GRID_ROWS;
  worldZSpan = rowsPerCol * Z_SPACING;

  for (let c = 0; c < GRID_COLS; c++) {
    const cx = -halfSpanX + c * X_SPACING;
    const zPhase = randS(0, Z_SPACING);
    for (let row = 0; row < rowsPerCol; row++) {
      trees.push({
        x: cx,
        z: (row + 1) * Z_SPACING + zPhase,
        trunkW: randS(0.55, 1.1), // fixed per tree, no randomness at runtime
        hue: randS(174, 216),
        lit: randS(0.55, 1.0),
        fade: 1,
      });
    }
  }

  trees.sort((a, b) => b.z - a.z);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cam.fov = Math.max(W, H) * 1.55;
  cam.horizonY = H * 0.5;

  buildGradients();

  if (!forestReady) {
    buildForest();
    forestReady = true;
  }
}

function buildGradients() {
  // Background — fills entire screen, no sky/ground boundary, only vertical
  // light-to-dark representing the light pouring down from above the canopy.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0.0, "#b8f2a8"); // bright canopy-top
  bg.addColorStop(0.08, "#72e4b8");
  bg.addColorStop(0.25, "#38b8d8");
  bg.addColorStop(0.5, "#2255c4");
  bg.addColorStop(0.74, "#1e34a0");
  bg.addColorStop(1.0, "#100b58"); // deep floor shadow
  g.bg = bg;

  // Atmospheric depth haze — softens far trees into the gradient
  const fog = ctx.createLinearGradient(0, 0, 0, H);
  fog.addColorStop(0.0, "rgba(100, 210, 235, 0.10)");
  fog.addColorStop(0.44, "rgba( 55, 135, 220, 0.20)");
  fog.addColorStop(0.56, "rgba( 55, 130, 215, 0.20)");
  fog.addColorStop(1.0, "rgba( 28,  65, 170, 0.10)");
  g.fog = fog;
}

// ─── draw ─────────────────────────────────────────────────────────────────────
function drawBackground() {
  ctx.globalAlpha = 1;
  ctx.fillStyle = g.bg;
  ctx.fillRect(0, 0, W, H);
}

function drawTree(tree) {
  const { x, z, trunkW, hue, lit, fade } = tree;

  // Oblique matrix view: rotate world in XZ by animated camera angle
  const rx = x * yawCos - z * yawSin;
  const rz = x * yawSin + z * yawCos;
  if (rz <= 0.5) return;

  // Depth 0=far 1=close
  const depth = Math.max(
    0,
    Math.min(1, 1 - (rz - DEPTH_NEAR) / (DEPTH_FAR - DEPTH_NEAR)),
  );

  // Near-clip fade (prevent popping when recycled)
  const nearAlpha =
    rz < FOG_IN_Z ? Math.max(0, (rz - 1.2) / (FOG_IN_Z - 1.2)) : 1;
  // Far fade so distant trees dissolve into background instead of hard-appearing
  const farAlpha = Math.max(
    0,
    Math.min(1, (DEPTH_FAR - rz) / (DEPTH_FAR * 0.22)),
  );
  const alpha = fade * nearAlpha * farAlpha;
  if (alpha <= 0.002) return;

  const scale = cam.fov / rz;
  const screenX = W * 0.5 + (rx - cam.x) * scale;
  const baseW = trunkW * scale;

  // Vanishing-point convergence for top of beam
  // Trees converge toward a point far ahead (horizon at center)
  const vScale = cam.fov / (DEPTH_FAR * 4); // very distant projection
  const vx = W * 0.5 + (rx - cam.x) * vScale;
  const topW = Math.max(0.6, baseW * 0.022);
  const topY = -H * 0.12; // bleed off top edge
  const bottomY = H * 1.12; // bleed off bottom edge

  // --- solid tinted body ---
  ctx.globalAlpha = (0.07 + depth * 0.28) * alpha;
  ctx.fillStyle = `hsl(${hue}, 58%, ${36 + depth * 16}%)`;
  ctx.beginPath();
  ctx.moveTo(vx - topW, topY);
  ctx.lineTo(vx + topW, topY);
  ctx.lineTo(screenX + baseW, bottomY);
  ctx.lineTo(screenX - baseW, bottomY);
  ctx.closePath();
  ctx.fill();

  // --- top-down glow gradient ---
  const gr = ctx.createLinearGradient(0, topY, 0, bottomY);
  const ga = lit * alpha;
  gr.addColorStop(0.0, `hsla(${hue - 14}, 92%, 90%, ${0.75 * ga})`);
  gr.addColorStop(0.15, `hsla(${hue - 7}, 84%, 72%, ${0.42 * ga})`);
  gr.addColorStop(0.46, `hsla(${hue},      72%, 54%, ${0.13 * ga})`);
  gr.addColorStop(1.0, `hsla(${hue + 10}, 66%, 30%, 0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.moveTo(vx - topW, topY);
  ctx.lineTo(vx + topW, topY);
  ctx.lineTo(screenX + baseW, bottomY);
  ctx.lineTo(screenX - baseW, bottomY);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 1;
}

// ─── update ───────────────────────────────────────────────────────────────────
function update(dt, t) {
  // Angle ping-pong: 65° -> 130° (10s) -> 65° (10s), repeat forever
  const p = (t % (VIEW_SWEEP_MS * 2)) / VIEW_SWEEP_MS; // [0..2)
  const u = p <= 1 ? p : 2 - p; // [0..1..0]
  const viewAngleDeg =
    VIEW_ANGLE_MIN_DEG + (VIEW_ANGLE_MAX_DEG - VIEW_ANGLE_MIN_DEG) * u;
  const yaw = ((90 - viewAngleDeg) * Math.PI) / 180;
  yawCos = Math.cos(yaw);
  yawSin = Math.sin(yaw);

  // Smooth S-curve camera drift — no straight lines
  cam.x =
    Math.sin(t * DRIFT_FREQ) * DRIFT_AMP +
    Math.sin(t * DRIFT_FREQ * 2.6 + 1.1) * DRIFT_AMP * 0.38 +
    Math.sin(t * DRIFT_FREQ * 0.7 + 2.4) * DRIFT_AMP * 0.2;

  const move = SPEED_BASE * dt;

  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    tr.z -= move;

    // Fade in
    if (tr.fade < 1) tr.fade = Math.min(1, tr.fade + dt * 0.0015);

    // Recycle to back of matrix cycle (persistent dense forest)
    if (tr.z < 1.1) {
      tr.z += worldZSpan;
      tr.fade = 0; // fade back in at distance
    }
  }

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

  requestAnimationFrame(frame);
}

// ─── boot ─────────────────────────────────────────────────────────────────────
resize();
window.addEventListener("resize", resize);
requestAnimationFrame(frame);
