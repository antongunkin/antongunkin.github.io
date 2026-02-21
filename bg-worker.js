/**
 * Forest fly-through — camera drifts between tall trees.
 * Runs in a Web Worker (OffscreenCanvas) or on the main thread as fallback.
 *
 * Performance wins (non-visual):
 *  • 1× DPR on mobile — up to 4× fewer pixels to fill
 *  • Insertion sort (O(n) on nearly-sorted data) instead of Array.sort
 *  • Pre-computed reciprocals for hot-path math
 *  • Off-screen trees culled before any draw call
 *  • Rendering off the main thread via OffscreenCanvas
 */

const IS_WORKER = typeof document === "undefined";

// ─── canvas / context (set during init) ──────────────────────────────────────
let canvas, ctx;
let W = 0,
  H = 0,
  dpr = 1;

// ─── tunables ────────────────────────────────────────────────────────────────
const DEPTH_FAR = 55;
const DEPTH_NEAR = 8;
const HALF_W = 20;
const SPEED_BASE = 0.004;
const DRIFT_AMP = 4.5;
const DRIFT_FREQ = 0.00008;
const X_SPACING = 3.6;
const Z_SPACING = 4.8;
const X_JITTER = X_SPACING * 0.3;
const RECYCLE_DELAY_MS = 1000;
const NEAR_FADE_START_Z = 7.2;
const NEAR_FADE_END_Z = 1.1;
const CENTER_FADE_BAND_X = 1.35;
const VIEW_WAYPOINTS = [90, 75, 115, 90];
const VIEW_SWEEP_MS = 30000;

// pre-computed constants
const INV_DEPTH_RANGE = 1 / (DEPTH_FAR - DEPTH_NEAR);
const FAR_FADE_INV = 1 / (DEPTH_FAR * 0.18);
const NEAR_FADE_INV = 1 / (NEAR_FADE_START_Z - NEAR_FADE_END_Z);
const INV_CENTER_FADE = 1 / CENTER_FADE_BAND_X;
const VP_DIVISOR = DEPTH_FAR * 4;
const SEG_COUNT = VIEW_WAYPOINTS.length - 1;
const SEG_MS = VIEW_SWEEP_MS / SEG_COUNT;
const INV_SEG_MS = 1 / SEG_MS;

// ─── state ───────────────────────────────────────────────────────────────────
const cam = { x: 0, fov: 0, horizonY: 0 };
let yawCos = 1,
  yawSin = 0;
const trees = [];
const g = {};
let rowsPerCol = 0;

// ─── helpers ─────────────────────────────────────────────────────────────────
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

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeInOut01(u) {
  return u * u * (3 - 2 * u);
}

/** Insertion sort descending by .z — O(n) on nearly-sorted data. */
function sortByZDesc(arr) {
  for (let i = 1, n = arr.length; i < n; i++) {
    const key = arr[i];
    const kz = key.z;
    let j = i - 1;
    while (j >= 0 && arr[j].z < kz) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = key;
  }
}

// ─── forest construction ─────────────────────────────────────────────────────
function buildForest() {
  trees.length = 0;
  const cols = [];
  for (let x = 0; x <= HALF_W + 0.01; x += X_SPACING) {
    cols.push(x);
    if (x > 0) cols.push(-x);
  }
  rowsPerCol = Math.ceil(DEPTH_FAR / Z_SPACING);

  for (const cx of cols) {
    for (let row = 0; row < rowsPerCol; row++) {
      trees.push({
        x: cx + randS(-X_JITTER, X_JITTER),
        z: (row + 1) * Z_SPACING + randS(0, Z_SPACING * 0.3),
        trunkW: randS(0.55, 1.1),
        hue: randS(174, 216),
        lit: randS(0.55, 1.0),
        fade: 1,
        recycleWait: 0,
      });
    }
  }
  trees.sort((a, b) => b.z - a.z);
}

// ─── gradients ───────────────────────────────────────────────────────────────
function buildGradients() {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0.0, "#b8f2a8");
  bg.addColorStop(0.08, "#72e4b8");
  bg.addColorStop(0.25, "#38b8d8");
  bg.addColorStop(0.5, "#2255c4");
  bg.addColorStop(0.74, "#1e34a0");
  bg.addColorStop(1.0, "#100b58");
  g.bg = bg;

  const fog = ctx.createLinearGradient(0, 0, 0, H);
  fog.addColorStop(0.0, "rgba(100, 210, 235, 0.10)");
  fog.addColorStop(0.44, "rgba( 55, 135, 220, 0.20)");
  fog.addColorStop(0.56, "rgba( 55, 130, 215, 0.20)");
  fog.addColorStop(1.0, "rgba( 28,  65, 170, 0.10)");
  g.fog = fog;
}

// ─── resize ──────────────────────────────────────────────────────────────────
function handleResize(w, h, deviceDpr) {
  W = w;
  H = h;
  // 1× on mobile (≤ 768 CSS-px wide), cap at 1.5× on desktop
  dpr = w <= 768 ? 1 : Math.min(deviceDpr, 1.5);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cam.fov = Math.max(W, H) * 1.55;
  cam.horizonY = H * 0.5;

  buildGradients();
}

// ─── draw ────────────────────────────────────────────────────────────────────
function drawTree(tree) {
  const { x, z, trunkW, hue, lit, fade } = tree;

  // Oblique matrix view: rotate world in XZ by animated camera angle
  const rx = x * yawCos - z * yawSin;
  const rz = x * yawSin + z * yawCos;
  if (rz <= 0.5) return;

  // Depth 0=far 1=close
  const depth = clamp01(1 - (rz - DEPTH_NEAR) * INV_DEPTH_RANGE);

  // Far fade so distant trees dissolve into background
  const farAlpha = clamp01((DEPTH_FAR - rz) * FAR_FADE_INV);

  // Near fade — only center-line trees dissolve; side trees stay visible
  const nearT = clamp01((rz - NEAR_FADE_END_Z) * NEAR_FADE_INV);
  const nearAlpha = easeInOut01(nearT);
  const centerDx = Math.abs(rx - cam.x);
  const centerT = clamp01(centerDx * INV_CENTER_FADE);
  const sideKeep = easeInOut01(centerT);
  const selectiveNearAlpha = nearAlpha + (1 - nearAlpha) * sideKeep;

  const alpha = fade * selectiveNearAlpha * farAlpha;
  if (alpha <= 0.002) return;

  const scale = cam.fov / rz;
  const screenX = W * 0.5 + (rx - cam.x) * scale;
  const baseW = trunkW * scale;

  // Off-screen cull
  if (screenX + baseW < 0 || screenX - baseW > W) return;

  // Vanishing-point convergence
  const vScale = cam.fov / VP_DIVISOR;
  const vx = W * 0.5 + (rx - cam.x) * vScale;
  const topW = Math.max(0.6, baseW * 0.022);
  const topY = -H * 0.12;
  const bottomY = H * 1.12;

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

// ─── update ──────────────────────────────────────────────────────────────────
function update(dt, t) {
  const localT = t % VIEW_SWEEP_MS;
  const seg = Math.min((localT * INV_SEG_MS) | 0, SEG_COUNT - 1);
  const segU = (localT - seg * SEG_MS) * INV_SEG_MS;
  const easedU = 0.5 - 0.5 * Math.cos(segU * Math.PI);
  const viewAngleDeg =
    VIEW_WAYPOINTS[seg] +
    (VIEW_WAYPOINTS[seg + 1] - VIEW_WAYPOINTS[seg]) * easedU;
  const yaw = ((90 - viewAngleDeg) * Math.PI) / 180;
  yawCos = Math.cos(yaw);
  yawSin = Math.sin(yaw);

  cam.x =
    Math.sin(t * DRIFT_FREQ) * DRIFT_AMP +
    Math.sin(t * DRIFT_FREQ * 2.6 + 1.1) * DRIFT_AMP * 0.38 +
    Math.sin(t * DRIFT_FREQ * 0.7 + 2.4) * DRIFT_AMP * 0.2;

  const move = SPEED_BASE * dt;
  const recOffset = rowsPerCol * Z_SPACING;
  const fadeDelta = dt * 0.0015;

  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    tr.z -= move;

    if (tr.fade < 1) tr.fade = Math.min(1, tr.fade + fadeDelta);

    if (tr.z < 1.1) {
      tr.recycleWait += dt;
      if (tr.recycleWait >= RECYCLE_DELAY_MS) {
        tr.z += recOffset;
        tr.fade = 0;
        tr.recycleWait = 0;
      }
    } else {
      tr.recycleWait = 0;
    }
  }

  sortByZDesc(trees);
}

// ─── frame loop ──────────────────────────────────────────────────────────────
let lastT = 0;

function frame(ts) {
  if (ts === undefined) ts = performance.now();
  const dt = lastT ? Math.min(ts - lastT, 48) : 16;
  lastT = ts;

  ctx.globalAlpha = 1;
  ctx.fillStyle = g.bg;
  ctx.fillRect(0, 0, W, H);

  update(dt, ts);

  for (let i = 0; i < trees.length; i++) drawTree(trees[i]);

  ctx.fillStyle = g.fog;
  ctx.fillRect(0, 0, W, H);

  scheduleFrame();
}

function scheduleFrame() {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(frame);
  } else {
    setTimeout(function () {
      frame(performance.now());
    }, 16);
  }
}

// ─── bootstrap ───────────────────────────────────────────────────────────────
if (IS_WORKER) {
  self.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === "init") {
      canvas = msg.canvas;
      ctx = canvas.getContext("2d");
      buildForest();
      handleResize(msg.w, msg.h, msg.dpr);
      scheduleFrame();
    } else if (msg.type === "resize") {
      handleResize(msg.w, msg.h, msg.dpr);
    }
  };
} else {
  canvas = document.querySelector("canvas");
  ctx = canvas.getContext("2d");

  buildForest();

  var resizeMain = function () {
    handleResize(innerWidth, innerHeight, devicePixelRatio || 1);
  };
  resizeMain();

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeMain, 120);
  });

  scheduleFrame();
}
