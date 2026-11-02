import { Camera } from '../render/camera';
import type { Vehicle } from '../sim/vehicle';
import { LaneDemand } from './demand';
import { LaneRenderer } from './draw';
import { LaneGraph } from './graph';
import { buildLab } from './scenes';
import { LaneTraffic } from './traffic';

/** Лаборатория полос: новая модель дорог на примерах и машины на ней, без игры. */
const canvas = document.getElementById('lab') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const camera = new Camera();
const { net, titles, sparse } = buildLab();
const renderer = new LaneRenderer();
const graph = new LaneGraph(net);
let lost = 0;
const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => lost++ });
const demand = new LaneDemand(traffic, 4, Math.random, sparse);
let debug = new URLSearchParams(location.search).has('debug');
let paused = false;
let dirty = true;

function resize(): void {
  camera.dpr = window.devicePixelRatio || 1;
  camera.width = window.innerWidth;
  camera.height = window.innerHeight;
  canvas.width = Math.round(camera.width * camera.dpr);
  canvas.height = Math.round(camera.height * camera.dpr);
  canvas.style.width = `${camera.width}px`;
  canvas.style.height = `${camera.height}px`;
  if (!camera.touched) fit();
  dirty = true;
}

/** Все примеры в кадре. Пока камеру не двигали, кадр подстраивается под размер окна. */
function fit(): void {
  const xs = [...net.nodes.values()].map((n) => n.pos.x);
  const ys = [...net.nodes.values()].map((n) => n.pos.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys) - 120, Math.max(...ys)];
  camera.x = (x0 + x1) / 2;
  camera.y = (y0 + y1) / 2;
  const z = Math.min((camera.width - 80) / (x1 - x0), (camera.height - 80) / (y1 - y0));
  camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, z));
  camera.touched = false;
}

function draw(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#d6e2bd';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  camera.apply(ctx);
  renderer.draw(ctx, net, camera.zoom, debug);
  drawVehicles([...traffic.vehicles.values()]);
  // Подписи примеров — постоянного размера на экране.
  ctx.setTransform(camera.dpr, 0, 0, camera.dpr, 0, 0);
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillStyle = '#3b4652';
  for (const t of titles) {
    const p = camera.toScreen(t.pos);
    ctx.fillText(t.text, p.x, p.y);
  }
  ctx.fillText(`Машин: ${traffic.vehicles.size} · доехали: ${traffic.arrivals} · потерялись: ${lost}${paused ? ' · пауза' : ''}`, 16, camera.height - 16);
}

/** Машина — скруглённый прямоугольник от передней точки назад, грузовик — с кузовом. */
function drawVehicles(list: Vehicle[]): void {
  for (const v of list) {
    ctx.save();
    ctx.translate(v.pos.x, v.pos.y);
    ctx.rotate(Math.atan2(v.dir.y, v.dir.x));
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.roundRect(-v.length + 0.8, -v.width / 2 + 0.9, v.length, v.width, 1.2);
    ctx.fill();
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.roundRect(-v.length, -v.width / 2, v.length, v.width, 1.3);
    ctx.fill();
    if (v.kind === 'truck') {
      ctx.fillStyle = v.load ?? '#f4efe6';
      ctx.fillRect(-v.length + 0.6, -v.width / 2 + 0.6, v.length - 4.2, v.width - 1.2);
    } else {
      ctx.fillStyle = 'rgba(30,40,55,0.55)';
      ctx.fillRect(-2.6, -v.width / 2 + 0.7, 1.4, v.width - 1.4);
    }
    ctx.restore();
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    // Мелкими шагами — как в игре.
    for (let t = dt; t > 1e-6; t -= 1 / 30) {
      const h = Math.min(1 / 30, t);
      demand.update(h);
      traffic.step(h);
    }
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(frame);
}

let drag: { x: number; y: number } | null = null;
canvas.addEventListener('mousedown', (e) => (drag = { x: e.clientX, y: e.clientY }));
window.addEventListener('mouseup', () => (drag = null));
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  camera.x -= (e.clientX - drag.x) / camera.zoom;
  camera.y -= (e.clientY - drag.y) / camera.zoom;
  camera.touched = true;
  drag = { x: e.clientX, y: e.clientY };
  dirty = true;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    camera.touched = true;
    dirty = true;
  },
  { passive: false },
);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyD') {
    debug = !debug;
    dirty = true;
  }
  if (e.code === 'KeyF') {
    fit();
    dirty = true;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
    dirty = true;
  }
  // Плотность потока: «+» — чаще, «−» — реже.
  if (e.key === '+' || e.key === '=') demand.interval = Math.max(0.6, demand.interval / 1.4);
  if (e.key === '-') demand.interval = Math.min(12, demand.interval * 1.4);
});
window.addEventListener('resize', resize);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

resize();
fit();
requestAnimationFrame(frame);
const problems = net.problems();
if (problems.length) console.warn('Сеть полос:', problems);
Object.assign(window, { camera, net, graph, traffic, demand });
