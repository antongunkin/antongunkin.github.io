const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");

const trees = [];

const SPAWN_NEAR = 24;
const SPAWN_FAR = 42;
const FOREST_HALF_WIDTH = 9;

let w = 0;
let h = 0;
let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
let targetTreeCount = 220;

const paints = {
  sky: null,
  skyGlow: null,
  fogA: null,
  centerGlow: null,
  bloom: null,
};

const scene = {
  horizon: 0,
  fov: 0,
  speed: 0.64,
  pathHalfWidth: 1.7,
  cameraY: 0,
  pitch: 0.45,
};

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // lower camera, looking up
  scene.horizon = h * 0.72;
  scene.cameraY = h * 0.86;
  scene.fov = Math.max(w, h) * 1.18;

  targetTreeCount = Math.round(Math.max(150, Math.min(240, (w * h) / 7000)));

  paints.sky = ctx.createLinearGradient(0, 0, 0, h);
  paints.sky.addColorStop(0, "#1a2233");
  paints.sky.addColorStop(0.46, "#2d394f");
  paints.sky.addColorStop(1, "#0f1721");

  paints.skyGlow = ctx.createRadialGradient(
    w * 0.5,
    h * 0.18,
    8,
    w * 0.5,
    h * 0.18,
    w * 0.5,
  );
  paints.skyGlow.addColorStop(0, "rgba(205, 228, 255, 0.26)");
  paints.skyGlow.addColorStop(0.4, "rgba(165, 201, 245, 0.11)");
  paints.skyGlow.addColorStop(1, "rgba(165, 201, 245, 0)");

  paints.fogA = ctx.createLinearGradient(0, scene.horizon - h * 0.2, 0, h);
  paints.fogA.addColorStop(0, "rgba(170, 195, 220, 0)");
  paints.fogA.addColorStop(1, "rgba(170, 195, 220, 0.23)");

  paints.centerGlow = ctx.createRadialGradient(
    w * 0.5,
    h * 0.9,
    4,
    w * 0.5,
    h * 0.9,
    w * 0.65,
  );
  paints.centerGlow.addColorStop(0, "rgba(224, 240, 255, 0.14)");
  paints.centerGlow.addColorStop(1, "rgba(224, 240, 255, 0)");

  paints.bloom = ctx.createLinearGradient(0, 0, 0, h);
  paints.bloom.addColorStop(0, "rgba(170, 190, 222, 0.09)");
  paints.bloom.addColorStop(0.55, "rgba(170, 190, 222, 0.03)");
  paints.bloom.addColorStop(1, "rgba(170, 190, 222, 0.14)");

  while (trees.length < targetTreeCount) {
    spawnTree(rand(0.15, SPAWN_FAR));
  }
  while (trees.length > targetTreeCount) {
    trees.pop();
  }
  trees.sort((a, b) => b.z - a.z);
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function spawnTree(
  z = rand(SPAWN_NEAR, SPAWN_FAR),
  isRespawn = false,
  insertAtFront = false,
) {
  const x = rand(-FOREST_HALF_WIDTH, FOREST_HALF_WIDTH);

  const tree = {
    x,
    z,
    trunk: rand(0.08, 0.14),
    height: rand(1.4, 2.9),
    hue: rand(112, 130),
    age: isRespawn ? 0 : rand(700, 1800),
  };

  if (insertAtFront) {
    trees.unshift(tree);
  } else {
    trees.push(tree);
  }

  return tree;
}

function project(x, z) {
  const scale = scene.fov / z;
  return {
    sx: w * 0.5 + x * scale,
    scale,
  };
}

function drawBackground(t) {
  ctx.fillStyle = paints.sky;
  ctx.fillRect(0, 0, w, h);

  // moon/sky glow
  ctx.fillStyle = paints.skyGlow;
  ctx.fillRect(0, 0, w, h);

  // layered fog
  ctx.fillStyle = paints.fogA;
  ctx.fillRect(0, scene.horizon - h * 0.2, w, h);

  ctx.fillStyle = `rgba(185, 205, 226, ${0.09 + Math.sin(t * 0.0008) * 0.03})`;
  ctx.fillRect(0, scene.horizon - h * 0.08, w, h);

  // center path glow to imply flying corridor
  ctx.fillStyle = paints.centerGlow;
  ctx.fillRect(0, scene.horizon, w, h - scene.horizon);
}

function drawTree(tree, dt) {
  const p = project(tree.x, tree.z);
  const pitchLift = (1 / Math.max(tree.z, 0.2)) * scene.pitch * 22;
  const baseY = scene.cameraY + p.scale * 0.34 - pitchLift;
  const trunkW = tree.trunk * p.scale;
  const trunkH = tree.height * p.scale * 1.45;
  const topY = baseY - trunkH;

  // skip trees off-screen (with margin for blur)
  if (p.sx < -160 || p.sx > w + 160 || topY > h + 80) return;
  if (trunkW < 0.22) return;

  const blurPx = Math.min(8, 1.2 + (12 / Math.max(tree.z, 0.2)) * 0.15);
  const smearX = (tree.x < 0 ? -1 : 1) * (scene.speed * 18 + dt * 0.03);
  const fog = Math.min(0.9, 0.22 + tree.z / 26);
  const fadeIn = Math.min(1, tree.age / 1000);
  const visibility = fadeIn * (1 - fog * 0.22);
  const near = tree.z < 10;

  // motion smear
  if (near && trunkW > 0.9) {
    ctx.filter = `blur(${blurPx}px)`;
  } else {
    ctx.filter = "none";
  }
  ctx.globalAlpha = 0.18 * visibility;
  ctx.fillStyle = "rgba(210, 228, 240, 0.24)";
  ctx.fillRect(p.sx - trunkW * 0.6 + smearX, topY, trunkW * 1.2, trunkH);

  // trunk only (no top/canopy)
  ctx.filter = "none";
  ctx.globalAlpha = (0.95 - fog * 0.5) * visibility;
  ctx.fillStyle = `hsl(${tree.hue}, 14%, ${10 + fog * 34}%)`;
  ctx.fillRect(p.sx - trunkW * 0.5, topY, trunkW, trunkH);

  // side glow on trunks
  if (trunkW > 0.7) {
    ctx.globalAlpha = 0.15 * visibility;
    ctx.fillStyle = "rgba(192, 220, 246, 0.65)";
    ctx.fillRect(p.sx - trunkW * 0.45, topY, trunkW * 0.18, trunkH);
  }

  // local fog veil around each trunk (near only for performance)
  if (tree.z < 12) {
    ctx.filter = `blur(${Math.min(10, 3 + 12 / Math.max(tree.z, 1))}px)`;
    ctx.globalAlpha = fog * 0.16 * visibility;
    ctx.fillStyle = "rgba(214, 230, 245, 0.95)";
    ctx.fillRect(
      p.sx - trunkW * 1.8,
      topY - trunkH * 0.05,
      trunkW * 3.6,
      trunkH * 1.08,
    );
    ctx.filter = "none";
  }
  ctx.globalAlpha = 1;
}

function update(dt, t) {
  // subtle left-right sway to feel like flying
  const sway = Math.sin(t * 0.00035) * 0.12;

  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    tree.age += dt;
    tree.z -= scene.speed * dt * 0.0034;
    tree.x += sway * dt * 0.0012 * (tree.x < 0 ? -1 : 1);

    if (tree.z < 0.12 || Math.abs(tree.x) > FOREST_HALF_WIDTH + 2) {
      trees.splice(i, 1);
      spawnTree(rand(SPAWN_NEAR, SPAWN_FAR), true, true);
      i--;
    }
  }
}

function frame(t) {
  const dt = Math.min(50, t - (frame.lastT || t));
  frame.lastT = t;

  drawBackground(t);
  update(dt, t);

  // far to near (order is maintained without per-frame sort)
  for (let i = 0; i < trees.length; i++) {
    drawTree(trees[i], dt);
  }

  // final cinematic haze/glow pass
  ctx.fillStyle = paints.bloom;
  ctx.fillRect(0, 0, w, h);

  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);

window.addEventListener("resize", resize);
