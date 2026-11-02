import type { Vec } from '../core/vec';
import { Camera } from '../render/camera';
import type { Vehicle } from '../sim/vehicle';
import { LaneDemand } from './demand';
import { LaneRenderer } from './draw';
import { LabEditor, LabTool, PROFILES } from './editor';
import { LaneGraph } from './graph';
import type { LaneNet } from './model';
import { buildLab } from './scenes';
import { LaneTraffic } from './traffic';

/** Лаборатория полос: новая модель дорог на примерах, машины на ней и редактор, без игры. */
const canvas = document.getElementById('lab') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const toolbar = document.getElementById('tools') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const camera = new Camera();
const lab = buildLab();
const renderer = new LaneRenderer();
let graph = new LaneGraph(lab.net);
let lost = 0;
const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => lost++ });
const demand = new LaneDemand(traffic, 4, Math.random, lab.sparse);
const editor = new LabEditor(lab.net, onNetChanged, () => 14 / Math.max(0.3, camera.zoom) + 4);
let debug = new URLSearchParams(location.search).has('debug');
let paused = false;
let mouse: { x: number; y: number } | null = null;

/** Сеть перестроили: новый граф движения, машины переезжают на него. */
function onNetChanged(net: LaneNet): void {
  graph = new LaneGraph(net);
  traffic.rebind(graph);
  renderUi();
}

function resize(): void {
  camera.dpr = window.devicePixelRatio || 1;
  camera.width = window.innerWidth;
  camera.height = window.innerHeight;
  canvas.width = Math.round(camera.width * camera.dpr);
  canvas.height = Math.round(camera.height * camera.dpr);
  canvas.style.width = `${camera.width}px`;
  canvas.style.height = `${camera.height}px`;
  if (!camera.touched) fit();
}

/** Все примеры в кадре. Пока камеру не двигали, кадр подстраивается под размер окна. */
function fit(): void {
  const xs = [...lab.net.nodes.values()].map((n) => n.pos.x);
  const ys = [...lab.net.nodes.values()].map((n) => n.pos.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys) - 120, Math.max(...ys)];
  camera.x = (x0 + x1) / 2;
  camera.y = (y0 + y1) / 2;
  const z = Math.min((camera.width - 80) / (x1 - x0), (camera.height - 160) / (y1 - y0));
  camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, z));
  camera.touched = false;
}

function draw(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#d6e2bd';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  camera.apply(ctx);
  renderer.draw(ctx, editor.shown, camera.zoom, debug);
  drawVehicles([...traffic.vehicles.values()]);
  editor.draw(ctx, camera.zoom);
  // Подписи примеров — постоянного размера на экране.
  ctx.setTransform(camera.dpr, 0, 0, camera.dpr, 0, 0);
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillStyle = '#3b4652';
  for (const t of lab.titles) {
    const p = camera.toScreen(t.pos);
    ctx.fillText(t.text, p.x, p.y);
  }
  ctx.fillText(`Машин: ${traffic.vehicles.size} · доехали: ${traffic.arrivals} · потерялись: ${lost}${paused ? ' · пауза' : ''}`, 16, camera.height - 16);
  // Что не так с тем, что сейчас строим, — у курсора.
  if (editor.problem && mouse) {
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(editor.problem).width + 14;
    ctx.fillStyle = 'rgba(232,72,63,0.92)';
    ctx.beginPath();
    ctx.roundRect(mouse.x + 14, mouse.y + 14, w, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(editor.problem, mouse.x + 21, mouse.y + 29);
  }
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
  }
  draw();
  requestAnimationFrame(frame);
}

// ---------- Панели ----------

const TOOLS: { id: LabTool; name: string; key: string; hint: string }[] = [
  { id: 'view', name: 'Обзор', key: 'V', hint: 'Тянуть — двигать карту' },
  { id: 'road', name: 'Дорога', key: 'N', hint: 'Клик — начало, клик — конец (с «Дугой» — сначала точка изгиба). Тупик продолжается, на дороге — перекрёсток, Esc — закончить' },
  { id: 'lane', name: 'Полоса', key: 'L', hint: 'Тяните от края дороги вдоль неё — новая полоса; уведите в сторону — съезд. Из поля к краю и вдоль — въезд с полосой разгона' },
  { id: 'select', name: 'Полосы', key: 'S', hint: 'Клик по полосе — развернуть, убрать, сплошная или пунктир' },
  { id: 'rebuild', name: 'Перестроить', key: 'U', hint: 'Клик по дороге — заменить полосы выбранным профилем' },
  { id: 'move', name: 'Двигать', key: 'M', hint: 'Тяните узел — дороги следом' },
  { id: 'bulldoze', name: 'Снос', key: 'B', hint: 'Клик по дороге — снести' },
];

function renderUi(): void {
  const t = editor.tool;
  const profiles = t === 'road' || t === 'rebuild' || t === 'lane';
  toolbar.innerHTML = `
    <div class="row">${TOOLS.map((x) => `<button class="tool ${t === x.id ? 'active' : ''}" data-tool="${x.id}" title="${x.hint}">${x.name}<kbd>${x.key}</kbd></button>`).join('')}
      <button class="tool" data-act="undo" title="Отменить (Ctrl+Z)">↶</button>
      <button class="tool" data-act="clear" title="Убрать все дороги">Очистить</button></div>
    ${
      profiles
        ? `<div class="row">${PROFILES.map((p) => `<button class="chip ${editor.profile.id === p.id ? 'active' : ''}" data-profile="${p.id}">${p.name}</button>`).join('')}
           ${t === 'road' ? `<button class="chip ${editor.curved ? 'active' : ''}" data-act="curve" title="C">Дуга<kbd>C</kbd></button>` : ''}</div>`
        : ''
    }
    <div class="hint">${TOOLS.find((x) => x.id === t)!.hint}</div>`;
  const sel = editor.selected && editor.net.corridors.get(editor.selected.corridor);
  const lane = sel && sel.lanes[editor.selected!.lane];
  panel.classList.toggle('hidden', !lane);
  if (sel && lane) {
    // Соседи по оси полотна; «слева/справа» — по ходу движения по полосе.
    const lower = sel.lanes.find((l) => Math.abs(l.offset - (lane.offset - 7)) < 0.5);
    const upper = sel.lanes.find((l) => Math.abs(l.offset - (lane.offset + 7)) < 0.5);
    const [upperSide, lowerSide] = lane.flow > 0 ? ['справа', 'слева'] : ['слева', 'справа'];
    const line = (solid: boolean | undefined, side: string) => `${solid ? '┆ Пунктир' : '│ Сплошная'} ${side}`;
    panel.innerHTML = `<b>Полоса</b>
      <div class="muted">${PROFILES.find((p) => p.cls === sel.cls)?.name.split(' ')[0] ?? sel.cls} · полос: ${sel.lanes.length}</div>
      <button data-lane="flip">⇄ Развернуть</button>
      ${lower ? `<button data-lane="solidLeft">${line(lower.solid, lowerSide)}</button>` : ''}
      ${upper ? `<button data-lane="solid">${line(lane.solid, upperSide)}</button>` : ''}
      <button data-lane="remove">✕ Убрать полосу</button>
      <button data-lane="bulldoze" class="danger">Снести дорогу</button>`;
  }
}

toolbar.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button');
  if (!el) return;
  if (el.dataset.tool) editor.setTool(el.dataset.tool as LabTool);
  if (el.dataset.profile) editor.profile = PROFILES.find((p) => p.id === el.dataset.profile)!;
  if (el.dataset.act === 'undo') editor.undo();
  if (el.dataset.act === 'clear') editor.clear();
  if (el.dataset.act === 'curve') editor.curved = !editor.curved;
  renderUi();
});
panel.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button');
  if (el?.dataset.lane) editor.laneAction(el.dataset.lane as Parameters<LabEditor['laneAction']>[0]);
  renderUi();
});

// ---------- Мышь и клавиши ----------

const world = (e: MouseEvent): Vec => camera.toWorld(e.clientX, e.clientY);
let pan: { x: number; y: number } | null = null;
/** Кнопку нажали на карте инструментом — отпускание тоже его (клики по панелям — не в счёт). */
let pressed = false;
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0 && editor.down(world(e))) {
    pressed = true;
    renderUi();
    return;
  }
  pan = { x: e.clientX, y: e.clientY };
});
window.addEventListener('mouseup', (e) => {
  if (pan) pan = null;
  else if (pressed && e.button === 0) {
    pressed = false;
    editor.up(world(e));
    renderUi();
  }
});
window.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (pan) {
    camera.x -= (e.clientX - pan.x) / camera.zoom;
    camera.y -= (e.clientY - pan.y) / camera.zoom;
    camera.touched = true;
    pan = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.target === canvas) editor.move(world(e));
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    camera.touched = true;
  },
  { passive: false },
);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    editor.undo();
    renderUi();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tool = TOOLS.find((t) => `Key${t.key}` === e.code);
  if (tool) editor.setTool(tool.id);
  if (e.code === 'Escape') {
    if (editor.busy) editor.cancel();
    else if (editor.selected) editor.selected = null;
    else editor.setTool('view');
  }
  if (e.code === 'KeyC') editor.curved = !editor.curved;
  if (e.code === 'KeyD') debug = !debug;
  if (e.code === 'KeyF') fit();
  if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
  }
  // Плотность потока: «+» — чаще, «−» — реже.
  if (e.key === '+' || e.key === '=') demand.interval = Math.max(0.6, demand.interval / 1.4);
  if (e.key === '-') demand.interval = Math.min(12, demand.interval * 1.4);
  renderUi();
});
window.addEventListener('resize', resize);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

resize();
fit();
renderUi();
requestAnimationFrame(frame);
const problems = lab.net.problems();
if (problems.length) console.warn('Сеть полос:', problems);
Object.assign(window, { camera, editor, traffic, demand, graph: () => graph });
