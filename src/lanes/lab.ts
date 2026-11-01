import { Camera } from '../render/camera';
import { LaneRenderer } from './draw';
import { buildLab } from './scenes';

/** Лаборатория полос: новая модель дорог на примерах, без игры. */
const canvas = document.getElementById('lab') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const camera = new Camera();
const { net, titles } = buildLab();
const renderer = new LaneRenderer();
let debug = new URLSearchParams(location.search).has('debug');
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
  // Подписи примеров — постоянного размера на экране.
  ctx.setTransform(camera.dpr, 0, 0, camera.dpr, 0, 0);
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillStyle = '#3b4652';
  for (const t of titles) {
    const p = camera.toScreen(t.pos);
    ctx.fillText(t.text, p.x, p.y);
  }
}

function frame(): void {
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
});
window.addEventListener('resize', resize);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

resize();
fit();
requestAnimationFrame(frame);
const problems = net.problems();
if (problems.length) console.warn('Сеть полос:', problems);
Object.assign(window, { camera, net });
