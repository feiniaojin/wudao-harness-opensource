#!/usr/bin/env node
/**
 * 黑洞模拟器物理内核验证
 *
 * 从 examples/blackhole/index.html 中提取 /*__PHYSICS_BEGIN__*​/ ... /*__PHYSICS_END__*​/ 之间的
 * 纯 JS 物理内核（不依赖 THREE / DOM），在 Node 沙箱中运行并断言：
 *   1. 圆形轨道长时间稳定（半径漂移、角动量、比能量守恒）
 *   2. 越过视界的粒子被吞噬
 *   3. 多粒子场景无 NaN / Infinity
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'examples', 'blackhole', 'index.html'), 'utf8');

const m = html.match(/\/\*__PHYSICS_BEGIN__\*\/([\s\S]*?)\/\*__PHYSICS_END__\*\//);
assert.ok(m, '未在 index.html 中找到物理内核标记块');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox);
const P = sandbox.BHPhysics;
assert.ok(P && typeof P.step === 'function', 'BHPhysics 导出不完整');

const GM = 0.6, Rs = 1.2, dt = 0.016;
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}: ${e.message}`]); }
};

/* ---------- 1. 圆形轨道稳定性 ---------- */
check('圆形轨道：半径漂移 < 10%', () => {
  const r0 = 8 * Rs;
  const st = P.createState(1);
  st.pos[0] = r0;
  st.vel[1] = P.orbitalSpeed(GM, r0); // 切向速度，绕 z 轴
  st.alive[0] = 1;

  const steps = 5000;
  let rmin = r0, rmax = r0;
  for (let k = 0; k < steps; k++) P.step(st, dt, GM, Rs);
  const r = Math.hypot(st.pos[0], st.pos[1], st.pos[2]);
  rmin = Math.min(rmin, r);
  rmax = Math.max(rmax, r);
  assert.ok(st.alive[0] === 1, '粒子不应被吞噬');
  assert.ok(rmax / rmin < 1.10, `半径漂移过大: rmin=${rmin} rmax=${rmax}`);
});

check('圆形轨道：角动量守恒 < 1e-6', () => {
  const r0 = 8 * Rs;
  const st = P.createState(1);
  st.pos[0] = r0;
  st.vel[1] = P.orbitalSpeed(GM, r0);
  st.alive[0] = 1;
  const L0 = r0 * st.vel[1];

  for (let k = 0; k < 5000; k++) P.step(st, dt, GM, Rs);
  const Lf = st.pos[0] * st.vel[1] - st.pos[1] * st.vel[0];
  assert.ok(Math.abs(Lf - L0) / L0 < 1e-6, `角动量漂移: ${Math.abs(Lf - L0) / L0}`);
});

check('圆形轨道：比能量漂移 < 1e-3', () => {
  const r0 = 8 * Rs;
  const st = P.createState(1);
  st.pos[0] = r0;
  st.vel[1] = P.orbitalSpeed(GM, r0);
  st.alive[0] = 1;
  const E0 = 0.5 * st.vel[1] ** 2 - GM / r0;

  let maxDrift = 0;
  for (let k = 0; k < 5000; k++) {
    P.step(st, dt, GM, Rs);
    const r = Math.hypot(st.pos[0], st.pos[1], st.pos[2]);
    const v2 = st.vel[0] ** 2 + st.vel[1] ** 2 + st.vel[2] ** 2;
    const E = 0.5 * v2 - GM / r;
    maxDrift = Math.max(maxDrift, Math.abs(E - E0) / Math.abs(E0));
  }
  assert.ok(maxDrift < 1e-3, `比能量漂移: ${maxDrift}`);
});

/* ---------- 2. 视界吞噬 ---------- */
check('吞噬：r < Rs 的粒子被移除', () => {
  const st = P.createState(1);
  st.pos[0] = 0.5 * Rs; // 视界内部
  st.vel[0] = 0; st.vel[1] = 0; st.vel[2] = 0;
  st.alive[0] = 1;
  const sw = P.step(st, dt, GM, Rs);
  assert.equal(sw, 1);
  assert.equal(st.alive[0], 0);
  assert.equal(st.swallowed, 1);
});

check('吞噬：视界外粒子不受影响', () => {
  const st = P.createState(1);
  st.pos[0] = 10 * Rs;
  st.vel[1] = P.orbitalSpeed(GM, 10 * Rs);
  st.alive[0] = 1;
  const sw = P.step(st, dt, GM, Rs);
  assert.equal(sw, 0);
  assert.equal(st.alive[0], 1);
});

/* ---------- 3. 多粒子场景 ---------- */
check('多粒子：5000 步后无 NaN，吞噬计数合理', () => {
  const n = 600;
  const st = P.createState(n);
  P.initDisk(st, 42, GM, Rs);
  for (let k = 0; k < 5000; k++) P.step(st, dt, GM, Rs);

  let alive = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    if (!st.alive[i]) continue;
    alive++;
    const i3 = i * 3;
    for (let j = 0; j < 3; j++) {
      if (!Number.isFinite(st.pos[i3 + j]) || !Number.isFinite(st.vel[i3 + j])) bad++;
    }
  }
  assert.equal(bad, 0, '存在 NaN/Infinity');
  assert.ok(alive > 0, '粒子全部被吞噬');
  assert.ok(st.swallowed > 0 && st.swallowed < n, `吞噬数异常: ${st.swallowed}`);
  console.log(`    （600 粒子 5000 步后存活 ${alive}，吞噬 ${st.swallowed}）`);
});

/* ---------- 汇总 ---------- */
let failed = 0;
for (const [ok, name] of results) {
  console.log(`${ok === 'PASS' ? '✅' : '❌'} ${name}`);
  if (ok !== 'PASS') failed++;
}
console.log(failed === 0 ? `\n全部通过 (${results.length} 项)` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
