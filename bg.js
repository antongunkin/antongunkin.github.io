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
const X_SPACING = 3.6; // world-units between matrix columns (more gap)
const Z_SPACING = 3.2; // world-units between matrix rows (more gap)
const X_JITTER = 0; // keep exact columns so camera can stay perfectly in gap centers
const RECYCLE_DELAY_MS = 1000; // wait before recycling near-camera trees

// Snake camera lanes (matrix indexing): 5.5 -> 4.5 -> 5.5 -> 6.5 -> repeat
const SNAKE_LANES = [5.5, 4.5, 5.5, 6.5, 5.5];
const SNAKE_STEP_MS = 3200;

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
  x: 0, // projected X (camera-space)
  worldX: 0,
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
let matrixHalfSpanX = 0;
let forestReady = false;

function laneToWorldX(laneIndex) {
  return (laneIndex - (GRID_COLS + 1) * 0.5) * X_SPACING;
}

function smooth01(u) {
  return u * u * (3 - 2 * u);
}

function buildForest() {
  trees.length = 0;

  // Dense matrix of trees — no center corridor or missing middle lane
  matrixHalfSpanX = (GRID_COLS - 1) * X_SPACING * 0.5;
  rowsPerCol = GRID_ROWS;
  worldZSpan = rowsPerCol * Z_SPACING;

  for (let c = 0; c < GRID_COLS; c++) {
    const cx = -matrixHalfSpanX + c * X_SPACING;
    const zPhase = randS(0, Z_SPACING);
    for (let row = 0; row < rowsPerCol; row++) {
      trees.push({
        x: cx + randS(-X_JITTER, X_JITTER),
        z: (row + 1) * Z_SPACING + zPhase,
        trunkW: randS(0.34, 0.72), // narrower trunks to keep ~1:3 tree-to-gap feel
        hue: randS(174, 216),
        lit: randS(0.55, 1.0),
        recycleWait: 0,
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
  const { x, z, trunkW, hue, lit } = tree;

  // Oblique matrix view: rotate world in XZ by animated camera angle
  const rx = x * yawCos - z * yawSin;
  const rz = x * yawSin + z * yawCos;
  if (rz <= 0.5) return;

  // Depth 0=far 1=close
  const depth = Math.max(
    0,
    Math.min(1, 1 - (rz - DEPTH_NEAR) / (DEPTH_FAR - DEPTH_NEAR)),
  );

  // Far fade so distant trees dissolve into background instead of hard-appearing
  const farAlpha = Math.max(
    0,
    Math.min(1, (DEPTH_FAR - rz) / (DEPTH_FAR * 0.22)),
  );
  const alpha = farAlpha;
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

  // Snake flight between lanes: 5.5 -> 4.5 -> 5.5 -> 6.5 -> repeat
  const segCount = SNAKE_LANES.length - 1;
  const cycleMs = segCount * SNAKE_STEP_MS;
  const localT = t % cycleMs;
  const seg = Math.floor(localT / SNAKE_STEP_MS);
  const laneU = (localT - seg * SNAKE_STEP_MS) / SNAKE_STEP_MS;
  const s = smooth01(laneU);
  const x0 = laneToWorldX(SNAKE_LANES[seg]);
  const x1 = laneToWorldX(SNAKE_LANES[seg + 1]);
  cam.worldX = x0 + (x1 - x0) * s;
  // Camera offset must be in rotated projection space to stay centered in gaps.
  cam.x = cam.worldX * yawCos;

  const move = SPEED_BASE * dt;

  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    tr.z -= move;

    // Recycle to back of matrix cycle (persistent dense forest)
    // Keep the tree for 1 second after crossing near threshold.
    if (tr.z < 1.1) {
      tr.recycleWait += dt;
      if (tr.recycleWait >= RECYCLE_DELAY_MS) {
        tr.z += worldZSpan;
        tr.recycleWait = 0;
      }
    } else {
      tr.recycleWait = 0;
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
