const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");

const trees = [];

const SPAWN_NEAR = 8;
const SPAWN_FAR = 90;
const FOREST_HALF_WIDTH = 24;
const LANE_STEP = 6.8;

let w = 0;
let h = 0;
let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
let targetTreeCount = 280;
let lanePositions = [];
let nextLaneIndex = 0;

const paints = {
  sky: null,
  topSourceGlow: null,
  topFog: null,
  depthFog: null,
  bloom: null,
};

const scene = {
  fov: 0,
  speed: 0.95,
  vx: 0,
  vy: 0,
  cameraX: 0,
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

  scene.vx = w * 0.5;
  scene.vy = h * 0.02;
  scene.fov = Math.max(w, h) * 1.42;

  lanePositions = [];
  const laneOffset = LANE_STEP * 0.5;
  for (
    let x = -FOREST_HALF_WIDTH + laneOffset;
    x <= FOREST_HALF_WIDTH - laneOffset;
    x += LANE_STEP
  ) {
    lanePositions.push(Number(x.toFixed(3)));
  }
  nextLaneIndex = Math.floor(rand(0, lanePositions.length));

  targetTreeCount = Math.round(Math.max(220, Math.min(380, (w * h) / 6000)));

  paints.sky = ctx.createLinearGradient(0, 0, 0, h);
  paints.sky.addColorStop(0, "#2e63d7");
  paints.sky.addColorStop(0.34, "#2547c6");
  paints.sky.addColorStop(0.7, "#3c2bb7");
  paints.sky.addColorStop(1, "#1f136d");

  paints.topSourceGlow = ctx.createRadialGradient(
    w * 0.5,
    h * 0.01,
    8,
    w * 0.5,
    h * 0.01,
    Math.max(w, h) * 0.85,
  );
  paints.topSourceGlow.addColorStop(0, "rgba(225, 252, 212, 0.88)");
  paints.topSourceGlow.addColorStop(0.16, "rgba(182, 245, 219, 0.46)");
  paints.topSourceGlow.addColorStop(0.5, "rgba(110, 212, 235, 0.22)");
  paints.topSourceGlow.addColorStop(1, "rgba(110, 212, 235, 0)");

  paints.topFog = ctx.createLinearGradient(0, 0, 0, h);
  paints.topFog.addColorStop(0, "rgba(202, 244, 226, 0.34)");
  paints.topFog.addColorStop(0.42, "rgba(154, 214, 239, 0.09)");
  paints.topFog.addColorStop(1, "rgba(154, 214, 239, 0)");

  paints.depthFog = ctx.createLinearGradient(0, 0, 0, h);
  paints.depthFog.addColorStop(0, "rgba(164, 222, 238, 0.14)");
  paints.depthFog.addColorStop(0.55, "rgba(120, 162, 230, 0.08)");
  paints.depthFog.addColorStop(1, "rgba(82, 98, 208, 0.18)");

  paints.bloom = ctx.createLinearGradient(0, 0, 0, h);
  paints.bloom.addColorStop(0, "rgba(156, 232, 238, 0.14)");
  paints.bloom.addColorStop(0.5, "rgba(102, 166, 232, 0.06)");
  paints.bloom.addColorStop(1, "rgba(62, 70, 185, 0.2)");

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
  const lane = lanePositions[nextLaneIndex % lanePositions.length] || 0;
  nextLaneIndex += 1;
  const x = lane;

  const tree = {
    x,
    z,
    trunk: rand(0.75, 1.875),
    height: rand(1, 1),
    hue: rand(174, 214),
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
    sx: w * 0.5 + (x - scene.cameraX) * scale,
    scale,
  };
}

function drawBackground(t) {
  ctx.fillStyle = paints.sky;
  ctx.fillRect(0, 0, w, h);

  // bright source at top-center
  ctx.fillStyle = paints.topSourceGlow;
  ctx.fillRect(0, 0, w, h);

  // atmospheric fog layers
  ctx.fillStyle = paints.topFog;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = paints.depthFog;
  ctx.fillRect(0, 0, w, h);
}

function drawTree(tree, dt) {
  const p = project(tree.x, tree.z);
  const farT = Math.min(
    1,
    Math.max(0, (tree.z - SPAWN_NEAR) / (SPAWN_FAR - SPAWN_NEAR)),
  );
  const clarity = 1 - farT;

  const bottomX = p.sx;
  const topX = scene.vx + (tree.x - scene.cameraX) * 8;
  const bottomW = tree.trunk * p.scale * 1.9;
  const topW = Math.max(1, bottomW * 0.04);
  const topY = -10;
  const bottomY = h + 30;

  if (bottomX + bottomW < -220 || bottomX - bottomW > w + 220) return;

  // base beam shape
  ctx.globalAlpha = 0.04 + clarity * 0.3;
  ctx.fillStyle = `hsl(${tree.hue}, 66%, ${46 + clarity * 12}%)`;
  ctx.beginPath();
  ctx.moveTo(topX - topW, topY);
  ctx.lineTo(topX + topW, topY);
  ctx.lineTo(bottomX + bottomW, bottomY);
  ctx.lineTo(bottomX - bottomW, bottomY);
  ctx.closePath();
  ctx.fill();

  // vertical top-down glow gradient on each beam
  const beamGlow = ctx.createLinearGradient(0, topY, 0, bottomY);
  beamGlow.addColorStop(
    0,
    `hsla(${tree.hue - 10}, 84%, 84%, ${0.65 * (0.4 + clarity * 0.6)})`,
  );
  beamGlow.addColorStop(
    0.42,
    `hsla(${tree.hue - 4}, 78%, 68%, ${0.24 * (0.4 + clarity * 0.6)})`,
  );
  beamGlow.addColorStop(1, `hsla(${tree.hue + 6}, 75%, 46%, 0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = beamGlow;
  ctx.beginPath();
  ctx.moveTo(topX - topW, topY);
  ctx.lineTo(topX + topW, topY);
  ctx.lineTo(bottomX + bottomW, bottomY);
  ctx.lineTo(bottomX - bottomW, bottomY);
  ctx.closePath();
  ctx.fill();

  // distant beams dissolve into fog
  if (farT > 0.45) {
    ctx.globalAlpha = (farT - 0.45) * 0.5;
    ctx.fillStyle = "rgba(208, 236, 248, 0.95)";
    ctx.beginPath();
    ctx.moveTo(topX - topW * 1.2, topY);
    ctx.lineTo(topX + topW * 1.2, topY);
    ctx.lineTo(bottomX + bottomW * 1.14, bottomY);
    ctx.lineTo(bottomX - bottomW * 1.14, bottomY);
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

function update(dt, t) {
  // tiny global drift without changing equal spacing
  scene.cameraX = Math.sin(t * 0.00023) * 0.25;

  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    tree.age += dt;
    tree.z -= scene.speed * dt * 0.0034;

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

  ctx.fillStyle = paints.topSourceGlow;
  ctx.fillRect(0, 0, w, h);

  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);

window.addEventListener("resize", resize);
