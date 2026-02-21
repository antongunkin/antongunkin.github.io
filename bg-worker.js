/**
 * Forest fly-through — optimised renderer.
 * Runs in a Web Worker (OffscreenCanvas) or on the main thread as fallback.
 *
 * Key optimisations over the original:
 *  • 1× DPR on mobile (≤ 768 CSS-px wide) — up to 4× fewer pixels
 *  • Per-tree gradient objects cached (rebuilt only on resize, not every frame)
 *  • Per-tree HSL colour strings pre-baked (zero string allocation in draw loop)
 *  • Insertion sort O(n) replaces Array.sort O(n log n) on nearly-sorted data
 *  • Pre-computed reciprocals eliminate divisions in the hot path
 *  • Off-screen and very-faint trees culled before any draw call
 *  • Gradient glow skipped entirely for barely-visible trees
 */

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Environment detection                                                     */
/* ═══════════════════════════════════════════════════════════════════════════ */
const IS_WORKER = typeof document === "undefined";

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Canvas / context — set during init                                        */
/* ═══════════════════════════════════════════════════════════════════════════ */
let canvas, ctx;
let W = 0,
  H = 0,
  dpr = 1;
let topY = 0,
  bottomY = 0;

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Tunables                                                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */
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

/* Pre-computed reciprocals & constants */
const INV_DEPTH_RANGE = 1 / (DEPTH_FAR - DEPTH_NEAR);
const FAR_FADE_INV = 1 / (DEPTH_FAR * 0.18);
const NEAR_FADE_INV = 1 / (NEAR_FADE_START_Z - NEAR_FADE_END_Z);
const INV_CENTER_FADE = 1 / CENTER_FADE_BAND_X;
const VP_DIVISOR = DEPTH_FAR * 4;
const SEG_COUNT = VIEW_WAYPOINTS.length - 1;
const SEG_MS = VIEW_SWEEP_MS / SEG_COUNT;
const INV_SEG_MS = 1 / SEG_MS;
const DEPTH_QUANT = 11; // quantisation levels for solid-body colour cache

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Runtime state                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */
const cam = { x: 0, fov: 0 };
let yawCos = 1,
  yawSin = 0;
const trees = [];
const g = {}; // background & fog gradient cache
let rowsPerCol = 0;

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Seeded PRNG (mulberry32) — deterministic across loads                     */
/* ═══════════════════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Helpers                                                                   */
/* ═══════════════════════════════════════════════════════════════════════════ */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeInOut01(u) {
  return u * u * (3 - 2 * u);
}

/** Insertion sort descending by .z — O(n) when nearly sorted (each frame). */
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Forest construction                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */
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
      const hue = randS(174, 216);
      const lit = randS(0.55, 1.0);

      /* Pre-bake quantised solid-body colour strings (hue is constant). */
      const solidColors = new Array(DEPTH_QUANT);
      for (let d = 0; d < DEPTH_QUANT; d++) {
        const l = 36 + (d / (DEPTH_QUANT - 1)) * 16;
        solidColors[d] =
          "hsl(" + hue.toFixed(1) + ",58%," + l.toFixed(1) + "%)";
      }

      /* Pre-bake gradient colour-stop strings.
         Alpha is factored out via globalAlpha at draw time,
         so stops use fixed alpha values. */
      const gradStops = [
        "hsla(" + (hue - 14).toFixed(1) + ",92%,90%,0.75)",
        "hsla(" + (hue - 7).toFixed(1) + ",84%,72%,0.42)",
        "hsla(" + hue.toFixed(1) + ",72%,54%,0.13)",
        "hsla(" + (hue + 10).toFixed(1) + ",66%,30%,0)",
      ];

      trees.push({
        x: cx + randS(-X_JITTER, X_JITTER),
        z: (row + 1) * Z_SPACING + randS(0, Z_SPACING * 0.3),
        trunkW: randS(0.55, 1.1),
        hue,
        lit,
        fade: 1,
        recycleWait: 0,
        solidColors,
        gradStops,
        gradCache: null, // CanvasGradient — rebuilt on resize
      });
    }
  }

  trees.sort((a, b) => b.z - a.z);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Gradient management                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */
function buildSceneGradients() {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0.0, "#b8f2a8");
  bg.addColorStop(0.08, "#72e4b8");
  bg.addColorStop(0.25, "#38b8d8");
  bg.addColorStop(0.5, "#2255c4");
  bg.addColorStop(0.74, "#1e34a0");
  bg.addColorStop(1.0, "#100b58");
  g.bg = bg;

  const fog = ctx.createLinearGradient(0, 0, 0, H);
  fog.addColorStop(0.0, "rgba(100,210,235,0.10)");
  fog.addColorStop(0.44, "rgba(55,135,220,0.20)");
  fog.addColorStop(0.56, "rgba(55,130,215,0.20)");
  fog.addColorStop(1.0, "rgba(28,65,170,0.10)");
  g.fog = fog;
}

/** Rebuild per-tree cached gradient objects (topY / bottomY changed). */
function rebuildTreeGradients() {
  for (let i = 0, n = trees.length; i < n; i++) {
    const t = trees[i];
    const gr = ctx.createLinearGradient(0, topY, 0, bottomY);
    gr.addColorStop(0.0, t.gradStops[0]);
    gr.addColorStop(0.15, t.gradStops[1]);
    gr.addColorStop(0.46, t.gradStops[2]);
    gr.addColorStop(1.0, t.gradStops[3]);
    t.gradCache = gr;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Resize                                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */
function handleResize(w, h, deviceDpr) {
  W = w;
  H = h;
  // Mobile (≤ 768 CSS-px wide): always 1×. Desktop: cap at 1.5×.
  dpr = w <= 768 ? 1 : Math.min(deviceDpr, 1.5);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cam.fov = Math.max(W, H) * 1.55;
  topY = -(H * 0.12);
  bottomY = H * 1.12;

  buildSceneGradients();
  rebuildTreeGradients();
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Tree drawing                                                              */
/* ═══════════════════════════════════════════════════════════════════════════ */
function drawTree(t) {
  /* World → rotated view */
  const rx = t.x * yawCos - t.z * yawSin;
  const rz = t.x * yawSin + t.z * yawCos;
  if (rz <= 0.5) return;

  /* Depth & fade factors */
  const depth = clamp01(1 - (rz - DEPTH_NEAR) * INV_DEPTH_RANGE);
  const farAlpha = clamp01((DEPTH_FAR - rz) * FAR_FADE_INV);

  const nearT = clamp01((rz - NEAR_FADE_END_Z) * NEAR_FADE_INV);
  const nearAlpha = easeInOut01(nearT);
  const dx = rx - cam.x;
  const absDx = dx < 0 ? -dx : dx;
  const sideKeep = easeInOut01(clamp01(absDx * INV_CENTER_FADE));

  const alpha = t.fade * (nearAlpha + (1 - nearAlpha) * sideKeep) * farAlpha;
  if (alpha <= 0.005) return;

  /* Projection */
  const scale = cam.fov / rz;
  const screenX = W * 0.5 + dx * scale;
  const baseW = t.trunkW * scale;

  /* Off-screen cull */
  if (screenX + baseW < 0 || screenX - baseW > W) return;

  const vScale = cam.fov / VP_DIVISOR;
  const vx = W * 0.5 + dx * vScale;
  const raw = baseW * 0.022;
  const topW = raw < 0.6 ? 0.6 : raw;

  /* ── Solid body ── */
  const dIdx = (depth * (DEPTH_QUANT - 1) + 0.5) | 0;
  ctx.globalAlpha = (0.07 + depth * 0.28) * alpha;
  ctx.fillStyle = t.solidColors[dIdx];
  ctx.beginPath();
  ctx.moveTo(vx - topW, topY);
  ctx.lineTo(vx + topW, topY);
  ctx.lineTo(screenX + baseW, bottomY);
  ctx.lineTo(screenX - baseW, bottomY);
  ctx.closePath();
  ctx.fill();

  /* ── Gradient glow (skip for barely-visible trees) ── */
  if (alpha > 0.04) {
    ctx.globalAlpha = t.lit * alpha;
    ctx.fillStyle = t.gradCache;
    ctx.beginPath();
    ctx.moveTo(vx - topW, topY);
    ctx.lineTo(vx + topW, topY);
    ctx.lineTo(screenX + baseW, bottomY);
    ctx.lineTo(screenX - baseW, bottomY);
    ctx.closePath();
    ctx.fill();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Update (physics / camera)                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */
function update(dt, t) {
  /* Yaw sweep: smooth interpolation through waypoints */
  const localT = t % VIEW_SWEEP_MS;
  const seg = Math.min((localT * INV_SEG_MS) | 0, SEG_COUNT - 1);
  const segU = (localT - seg * SEG_MS) * INV_SEG_MS;
  const easedU = 0.5 - 0.5 * Math.cos(segU * Math.PI);
  const yaw =
    (90 -
      (VIEW_WAYPOINTS[seg] +
        (VIEW_WAYPOINTS[seg + 1] - VIEW_WAYPOINTS[seg]) * easedU)) *
    (Math.PI / 180);
  yawCos = Math.cos(yaw);
  yawSin = Math.sin(yaw);

  /* Multi-frequency drift */
  cam.x =
    Math.sin(t * DRIFT_FREQ) * DRIFT_AMP +
    Math.sin(t * DRIFT_FREQ * 2.6 + 1.1) * DRIFT_AMP * 0.38 +
    Math.sin(t * DRIFT_FREQ * 0.7 + 2.4) * DRIFT_AMP * 0.2;

  /* Move trees toward camera */
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Frame loop                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */
let lastT = 0;

function frame(ts) {
  if (ts === undefined) ts = performance.now();
  const dt = lastT ? Math.min(ts - lastT, 48) : 16;
  lastT = ts;

  /* Background */
  ctx.globalAlpha = 1;
  ctx.fillStyle = g.bg;
  ctx.fillRect(0, 0, W, H);

  update(dt, ts);

  /* Trees (painter's order: far → near) */
  for (let i = 0, n = trees.length; i < n; i++) drawTree(trees[i]);

  /* Depth-fog overlay */
  ctx.globalAlpha = 1;
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Bootstrap — Web Worker vs main thread                                     */
/* ═══════════════════════════════════════════════════════════════════════════ */
if (IS_WORKER) {
  /* ── Worker: receive canvas + resize messages from the loader ──────── */
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
  /* ── Main-thread fallback (OffscreenCanvas not available) ──────────── */
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
