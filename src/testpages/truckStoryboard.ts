import { Camera } from '../render/camera';
import { Renderer, type ToolOverlay } from '../render/renderer';
import { drawVehicleArt } from '../render/vehicleArt';
import type { VehicleLook } from '../sim/vehicle';
import { MODELS } from '../game/transport';
import { buildTruckAccessScene, type TruckModel } from './truckAccess';

/** Изолированная симуляция: раскадровка не переставляет машины и не меняет время открытой партии. */
export function showTruckStoryboard(index: number, model: TruckModel, action: 'entry' | 'exit', approach?: 'front' | 'parallel'): void {
  const scene = buildTruckAccessScene();
  const c = scene.truckCases[index];
  if (approach) {
    const problem = scene.game.setDockApproach(c.building.id, approach);
    if (problem) throw new Error(problem);
  }
  scene.start(index, model, action);
  const frames: { time: number; look: VehicleLook }[] = [];
  for (let f = 0; f <= 30 * 100; f++) {
    const look = scene.game.fleetLook(c.vehicle!);
    const done = action === 'entry' ? c.phase === 'unloading' : c.phase === 'done';
    if (look && (f % 3 === 0 || done)) frames.push({ time: f / 30, look: structuredClone(look) });
    if (done) break;
    scene.game.update(1 / 30); scene.tick();
  }
  if (!(action === 'entry' ? c.phase === 'unloading' : c.phase === 'done')) throw new Error('Манёвр не завершился за 100 секунд');
  scene.game.sellVehicle(c.vehicle!.id);
  scene.game.floaters.length = 0;
  const background = document.createElement('canvas');
  background.width = 600; background.height = 420;
  const camera = new Camera();
  camera.width = background.width; camera.height = background.height;
  const points = frames.flatMap((f) => [f.look.pos, { x: f.look.pos.x - f.look.dir.x * f.look.length, y: f.look.pos.y - f.look.dir.y * f.look.length }]);
  const fp = c.building.fp;
  const x0 = Math.min(fp.center.x - fp.w / 2 - 6, ...points.map((p) => p.x - 5));
  const x1 = Math.max(fp.center.x + fp.w / 2 + 6, ...points.map((p) => p.x + 5));
  const y0 = Math.min(fp.center.y - fp.h / 2 - 6, ...points.map((p) => p.y - 5));
  const y1 = Math.max(fp.center.y + fp.h / 2 + 6, ...points.map((p) => p.y + 5));
  camera.x = (x0 + x1) / 2; camera.y = (y0 + y1) / 2;
  camera.zoom = Math.min(600 / (x1 - x0), 420 / (y1 - y0));
  const overlay: ToolOverlay = { hover: null, snap: null, chainStart: null, control: null, plan: null, highlightSeg: null, highlightNode: null, station: null, catchmentAt: null, catchmentR: 0, railPreview: null, signal: null, template: null, lineStops: [], selectedLine: null, selection: null, highlight: [], ping: null, area: null, marks: [], label: null, heatmap: false, roadTool: false, laneEdit: null };
  new Renderer(background, camera).draw(scene.game, overlay);
  const title = `${c.title} · ${MODELS[model].name} · ${action === 'entry' ? 'Заезд' : 'Выезд'}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'truck-storyboard';
  dialog.setAttribute('aria-label', 'Раскадровка манёвра');
  const heading = document.createElement('h3'); heading.textContent = title;
  const close = document.createElement('button'); close.textContent = 'Закрыть';
  close.addEventListener('click', () => dialog.close());
  const download = document.createElement('a'); download.textContent = 'Скачать PNG'; download.download = `truck-${index + 1}-${model}-${action}.png`;
  const header = document.createElement('header'); header.append(heading, download, close);
  const grid = document.createElement('div'); grid.className = 'truck-frames';
  const sheet = document.createElement('canvas'); sheet.width = 1800; sheet.height = 60 + 4 * 450;
  const sheetCtx = sheet.getContext('2d')!;
  sheetCtx.fillStyle = '#f8faf7'; sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
  sheetCtx.fillStyle = '#202b35'; sheetCtx.font = '24px sans-serif'; sheetCtx.fillText(title, 20, 38);
  for (let i = 0; i < 12; i++) {
    const frame = frames[Math.round(i * (frames.length - 1) / 11)];
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 420;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(background, 0, 0);
    camera.apply(ctx); drawVehicleArt(ctx, frame.look, { detailed: true, halo: 0 });
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption'); caption.textContent = `${String(i + 1).padStart(2, '0')} · ${frame.time.toFixed(2)} с`;
    figure.append(canvas, caption); grid.append(figure);
    const x = (i % 3) * 600, y = 60 + Math.floor(i / 3) * 450;
    sheetCtx.drawImage(canvas, x, y); sheetCtx.fillText(caption.textContent, x + 12, y + 443);
  }
  download.href = sheet.toDataURL('image/png');
  dialog.append(header, grid);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dialog); dialog.showModal();
}
