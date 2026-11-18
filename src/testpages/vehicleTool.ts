import './vehicleTool.css';
import type { Game } from '../game/game';
import { MODELS, type ModelId } from '../game/transport';
import type { Controller } from '../input/controller';
import type { Camera } from '../render/camera';
import type { VehicleSpec } from '../sim/vehicle';
import { modelSvg } from '../ui/icons';
import { CAR_SIZE } from '../world/houseAccess';

const CAR: VehicleSpec = { kind: 'car', length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10, color: '#d87a45' };

/** Палитра транспорта на общей панели инструментов; устанавливается только для тестовых сцен. */
export function installVehicleTool(host: { game(): Game; enabled(): boolean; controller: Controller; camera: Camera; canvas: HTMLCanvasElement }): { update(): void } {
  const toolbar = document.querySelector<HTMLElement>('[data-tools]')!;
  const button = document.createElement('button');
  button.className = 'tool';
  button.innerHTML = '<span aria-hidden="true">🚗</span><span class="name">Автомобили</span>';
  button.title = 'Добавить транспорт на тестовую сцену';
  button.setAttribute('aria-pressed', 'false');
  toolbar.prepend(button);
  toolbar.classList.add('test-vehicle-toolbar');
  const palette = document.createElement('section');
  palette.className = 'panel test-vehicles';
  palette.setAttribute('aria-label', 'Автомобили для тестирования');
  const road = (Object.keys(MODELS) as ModelId[]).filter((id) => MODELS[id].mode === 'road');
  const carIcon = '<svg viewBox="0 0 72 26" width="72" height="26" aria-hidden="true"><path d="M9 16L14 13L23 6H45L54 13L63 15V21H9Z" fill="#d87a45" stroke="#9b4f27" stroke-width="1"/><path d="M25 8H32V13H19ZM35 8H44L50 13H35Z" fill="#bad5e5"/><path d="M12 18H60" stroke="#ed9d68"/><circle cx="22" cy="21" r="4" fill="#303b45"/><circle cx="51" cy="21" r="4" fill="#303b45"/><circle cx="22" cy="21" r="1.6" fill="#a3b0bb"/><circle cx="51" cy="21" r="1.6" fill="#a3b0bb"/></svg>';
  button.innerHTML = `${carIcon}<span class="name">Автомобили</span>`;
  palette.innerHTML = `<header><b>Автомобили</b><button type="button" data-close aria-label="Закрыть выбор автомобилей">✕</button></header>
    <div class="test-vehicle-models"><button type="button" data-model="car">${carIcon}<span>Легковой</span></button>${road.map((id) => `<button type="button" data-model="${id}">${modelSvg(id, '#3b7dd8', 72, 26)}<span>${MODELS[id].name}</span></button>`).join('')}</div>
    <p>Выберите модель и кликните по дороге или свободному парковочному месту. Можно расставлять на паузе.</p><output>Esc — закончить размещение</output>`;
  document.body.append(palette);
  let open = false;
  let model: ModelId | 'car' = 'car';
  let message = '';
  let rightDown: { x: number; y: number } | null = null;
  const setOpen = (value: boolean) => {
    if (value) window.dispatchEvent(new CustomEvent('roads-test-tool', { detail: 'vehicles' }));
    open = value;
    host.controller.testVehiclePlacement = open;
    if (open) { host.controller.setTool('select'); host.controller.select(null); }
    document.body.toggleAttribute('data-test-vehicle', open);
    update();
  };
  window.addEventListener('roads-test-tool', (e) => { if ((e as CustomEvent<string>).detail === 'buildings') setOpen(false); });
  button.addEventListener('click', () => setOpen(!open));
  toolbar.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('button')?.isSameNode(button)) setOpen(false); });
  palette.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (el?.hasAttribute('data-close')) setOpen(false);
    else if (el?.dataset.model) { model = el.dataset.model as typeof model; message = ''; update(); }
  });
  window.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); }
  }, { capture: true });
  host.canvas.addEventListener('mousedown', (e) => { if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 2) return;
    if (open && rightDown && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 4) setOpen(false);
    rightDown = null;
  }, { capture: true });
  for (const type of ['pointerdown', 'pointerup'] as const) host.canvas.addEventListener(type, (e) => {
    if (!open || !host.enabled() || e.button !== 0) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (type === 'pointerup') return;
    const m = model === 'car' ? null : MODELS[model];
    const spec = m?.mode === 'road' ? m.spec : CAR;
    const result = host.game().parkedCars.spawn(spec, host.camera.toWorld(e.clientX, e.clientY));
    if (typeof result === 'string') message = result;
    else {
      host.controller.select(result.parked ? { type: 'parkedCar', id: result.parked } : { type: 'vehicle', simId: result.simId! });
      message = 'Автомобиль добавлен. В его панели можно назначить цель.';
    }
    update();
  }, { capture: true });
  function update(): void {
    button.hidden = !host.enabled();
    palette.hidden = !open || button.hidden;
    button.classList.toggle('active', open && !button.hidden);
    button.setAttribute('aria-pressed', String(open && !button.hidden));
    const m = model === 'car' ? null : MODELS[model];
    host.controller.testVehicleSpec = open && !button.hidden ? m?.mode === 'road' ? m.spec : CAR : null;
    toolbar.querySelector('[data-id="select"]')?.classList.toggle('active', !open && !document.body.hasAttribute('data-test-building') && host.controller.tool === 'select');
    for (const el of palette.querySelectorAll<HTMLButtonElement>('[data-model]')) el.setAttribute('aria-pressed', String(el.dataset.model === model));
    palette.querySelector('output')!.textContent = message || 'Esc — закончить размещение';
    if (open && (host.controller.pending?.kind === 'carDestination' || host.controller.tool !== 'select' || !host.enabled())) setOpen(false);
  }
  update();
  return { update };
}
