/**
 * Forest fly-through — optimised renderer.
 * Runs in a Web Worker (OffscreenCanvas) or on the main thread as fallback.
 *
 * Features:
 *  • Theme-driven colours from CSS custom properties
 *  • Smooth 5-second colour transitions on theme change
 *  • 1× DPR on mobile (≤ 768 CSS-px wide) — up to 4× fewer pixels
 *  • Per-tree gradient objects cached (rebuilt only on resize / theme change)
 *  • Per-tree HSL colour strings pre-baked
 *  • Insertion sort O(n) replaces Array.sort O(n log n) on nearly-sorted data
 *  • Pre-computed reciprocals eliminate divisions in the hot path
 *  • Off-screen and very-faint trees culled before any draw call
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
const DEPTH_QUANT = 11;

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Default theme (matches original hardcoded colours)                        */
/* ═══════════════════════════════════════════════════════════════════════════ */
const DEFAULT_THEME = {
  sky: [
    [184, 242, 168],
    [114, 228, 184],
    [56, 184, 216],
    [34, 85, 196],
    [30, 52, 160],
    [16, 11, 88],
  ],
  fog: [
    [100, 210, 235, 0.1],
    [55, 135, 220, 0.2],
    [55, 130, 215, 0.2],
    [28, 65, 170, 0.1],
  ],
  treeHueMin: 174,
  treeHueMax: 216,
  treeSat: 58,
  treeLightMin: 36,
  treeLightMax: 52,
};

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Theme state                                                               */
/* ═══════════════════════════════════════════════════════════════════════════ */
const THEME_DURATION = 1000;
let themeFrom = null;
let themeTo = null;
let cur = null; // current (possibly interpolated) theme snapshot
let themeStartT = -1;
let themeTransitioning = false;

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
/*  Theme helpers                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */
function rgbStr(c) {
  return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
}
function rgbaStr(c) {
  return (
    "rgba(" +
    (c[0] | 0) +
    "," +
    (c[1] | 0) +
    "," +
    (c[2] | 0) +
    "," +
    c[3].toFixed(3) +
    ")"
  );
}

function cloneTheme(t) {
  return {
    sky: t.sky.map(function (c) {
      return c.slice();
    }),
    fog: t.fog.map(function (c) {
      return c.slice();
    }),
    treeHueMin: t.treeHueMin,
    treeHueMax: t.treeHueMax,
    treeSat: t.treeSat,
    treeLightMin: t.treeLightMin,
    treeLightMax: t.treeLightMax,
  };
}

function lerpTheme(a, b, t) {
  var sky = [];
  for (var i = 0; i < a.sky.length; i++) {
    sky.push([
      a.sky[i][0] + (b.sky[i][0] - a.sky[i][0]) * t,
      a.sky[i][1] + (b.sky[i][1] - a.sky[i][1]) * t,
      a.sky[i][2] + (b.sky[i][2] - a.sky[i][2]) * t,
    ]);
  }
  var fog = [];
  for (var i = 0; i < a.fog.length; i++) {
    fog.push([
      a.fog[i][0] + (b.fog[i][0] - a.fog[i][0]) * t,
      a.fog[i][1] + (b.fog[i][1] - a.fog[i][1]) * t,
      a.fog[i][2] + (b.fog[i][2] - a.fog[i][2]) * t,
      a.fog[i][3] + (b.fog[i][3] - a.fog[i][3]) * t,
    ]);
  }
  return {
    sky: sky,
    fog: fog,
    treeHueMin: a.treeHueMin + (b.treeHueMin - a.treeHueMin) * t,
    treeHueMax: a.treeHueMax + (b.treeHueMax - a.treeHueMax) * t,
    treeSat: a.treeSat + (b.treeSat - a.treeSat) * t,
    treeLightMin: a.treeLightMin + (b.treeLightMin - a.treeLightMin) * t,
    treeLightMax: a.treeLightMax + (b.treeLightMax - a.treeLightMax) * t,
  };
}

function setThemeTarget(theme) {
  themeFrom = cur ? cloneTheme(cur) : cloneTheme(theme);
  themeTo = theme;
  themeStartT = performance.now();
  themeTransitioning = true;
}

function updateThemeTransition(ts) {
  if (!themeTransitioning) return;
  var elapsed = ts - themeStartT;
  var t = clamp01(elapsed / THEME_DURATION);
  t = easeInOut01(t);
  cur = lerpTheme(themeFrom, themeTo, t);
  rebuildAllColors();
  if (t >= 1) {
    themeTransitioning = false;
  }
}

/** Rebuild all colour-dependent objects from the current theme snapshot. */
function rebuildAllColors() {
  if (!ctx) return;
  buildSceneGradients();
  rebuildTreeColors();
  rebuildTreeGradients();
}

/** Regenerate per-tree solid-body and gradient-stop colour strings. */
function rebuildTreeColors() {
  for (var i = 0, n = trees.length; i < n; i++) {
    var t = trees[i];
    var hue = cur.treeHueMin + t.hueRng * (cur.treeHueMax - cur.treeHueMin);
    var sat = cur.treeSat;
    var lMin = cur.treeLightMin;
    var lMax = cur.treeLightMax;

    for (var d = 0; d < DEPTH_QUANT; d++) {
      var l = lMin + (d / (DEPTH_QUANT - 1)) * (lMax - lMin);
      t.solidColors[d] =
        "hsl(" +
        hue.toFixed(1) +
        "," +
        sat.toFixed(1) +
        "%," +
        l.toFixed(1) +
        "%)";
    }

    var g0 = Math.min(90, lMax + 28);
    var g1 = Math.min(72, lMax + 16);
    var g2 = Math.min(54, lMax + 6);
    var g3 = Math.max(8, lMin - 4);
    t.gradStops[0] =
      "hsla(" + (hue - 14).toFixed(1) + ",86%," + g0.toFixed(1) + "%,0.62)";
    t.gradStops[1] =
      "hsla(" + (hue - 7).toFixed(1) + ",76%," + g1.toFixed(1) + "%,0.35)";
    t.gradStops[2] =
      "hsla(" + hue.toFixed(1) + ",66%," + g2.toFixed(1) + "%,0.11)";
    t.gradStops[3] =
      "hsla(" + (hue + 10).toFixed(1) + ",56%," + g3.toFixed(1) + "%,0)";
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
      /* PRNG call order MUST stay identical to original: x, z, trunkW, hue, lit */
      const treeX = cx + randS(-X_JITTER, X_JITTER);
      const treeZ = (row + 1) * Z_SPACING + randS(0, Z_SPACING * 0.3);
      const trunkW = randS(0.55, 1.1);

      /* hueRng replaces randS(174, 216) — same single rng() call position */
      const hueRng = rng();
      const hue = cur.treeHueMin + hueRng * (cur.treeHueMax - cur.treeHueMin);
      const lit = randS(0.55, 1.0);

      const sat = cur.treeSat;
      const lMin = cur.treeLightMin;
      const lMax = cur.treeLightMax;

      /* Pre-bake quantised solid-body colour strings. */
      const solidColors = new Array(DEPTH_QUANT);
      for (let d = 0; d < DEPTH_QUANT; d++) {
        const l = lMin + (d / (DEPTH_QUANT - 1)) * (lMax - lMin);
        solidColors[d] =
          "hsl(" +
          hue.toFixed(1) +
          "," +
          sat.toFixed(1) +
          "%," +
          l.toFixed(1) +
          "%)";
      }

      /* Pre-bake gradient colour-stop strings. */
      const g0 = Math.min(90, lMax + 28);
      const g1 = Math.min(72, lMax + 16);
      const g2 = Math.min(54, lMax + 6);
      const g3 = Math.max(8, lMin - 4);
      const gradStops = [
        "hsla(" + (hue - 14).toFixed(1) + ",86%," + g0.toFixed(1) + "%,0.62)",
        "hsla(" + (hue - 7).toFixed(1) + ",76%," + g1.toFixed(1) + "%,0.35)",
        "hsla(" + hue.toFixed(1) + ",66%," + g2.toFixed(1) + "%,0.11)",
        "hsla(" + (hue + 10).toFixed(1) + ",56%," + g3.toFixed(1) + "%,0)",
      ];

      trees.push({
        x: treeX,
        z: treeZ,
        trunkW,
        hueRng,
        lit,
        fade: 1,
        recycleWait: 0,
        solidColors,
        gradStops,
        gradCache: null, // CanvasGradient — rebuilt on resize / theme change
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
  bg.addColorStop(0.0, rgbStr(cur.sky[0]));
  bg.addColorStop(0.08, rgbStr(cur.sky[1]));
  bg.addColorStop(0.25, rgbStr(cur.sky[2]));
  bg.addColorStop(0.5, rgbStr(cur.sky[3]));
  bg.addColorStop(0.74, rgbStr(cur.sky[4]));
  bg.addColorStop(1.0, rgbStr(cur.sky[5]));
  g.bg = bg;

  const fog = ctx.createLinearGradient(0, 0, 0, H);
  fog.addColorStop(0.0, rgbaStr(cur.fog[0]));
  fog.addColorStop(0.44, rgbaStr(cur.fog[1]));
  fog.addColorStop(0.56, rgbaStr(cur.fog[2]));
  fog.addColorStop(1.0, rgbaStr(cur.fog[3]));
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
  dpr = 1; // 1 for all devices to save GPU / battery — no visible quality difference
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  if (!IS_WORKER && canvas.style) {
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cam.fov = Math.max(W, H) * 1.55;
  topY = -(H * 0.12);
  bottomY = H * 1.12;

  rebuildAllColors();
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
  if (alpha <= 0.002) return;

  /* Projection */
  const scale = cam.fov / rz;
  const screenX = W * 0.5 + dx * scale;
  const baseW = t.trunkW * scale;

  const vScale = cam.fov / VP_DIVISOR;
  const vx = W * 0.5 + dx * vScale;
  const raw = baseW * 0.022;
  const topW = raw < 0.6 ? 0.6 : raw;

  /* Off-screen cull — check full trapezoid (top vx AND bottom screenX) */
  const minX = vx - topW < screenX - baseW ? vx - topW : screenX - baseW;
  const maxX = vx + topW > screenX + baseW ? vx + topW : screenX + baseW;
  if (maxX < 0 || minX > W) return;

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

  /* ── Gradient glow ── */
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

  /* Animate theme transition (no-op when not transitioning) */
  updateThemeTransition(ts);

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
  /* ── Worker: receive canvas + resize + theme messages ─────────────── */
  self.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === "init") {
      canvas = msg.canvas;
      ctx = canvas.getContext("2d");
      cur = cloneTheme(msg.theme || DEFAULT_THEME);
      themeTransitioning = false;
      buildForest();
      handleResize(msg.w, msg.h, msg.dpr);
      scheduleFrame();
    } else if (msg.type === "resize") {
      handleResize(msg.w, msg.h, msg.dpr);
    } else if (msg.type === "theme") {
      setThemeTarget(msg.theme);
    }
  };
} else {
  /* ── Main-thread fallback (OffscreenCanvas not available) ──────────── */
  canvas = document.querySelector("canvas");
  ctx = canvas.getContext("2d");

  cur = cloneTheme(window.__bgTheme || DEFAULT_THEME);
  themeTransitioning = false;

  buildForest();

  var resizeMain = function () {
    handleResize(innerWidth, innerHeight, 1);
  };
  resizeMain();

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeMain, 120);
  });

  /* Expose setter so bg.js can push theme updates in fallback mode */
  window.__bgSetTheme = function (theme) {
    setThemeTarget(theme);
  };

  scheduleFrame();
}
