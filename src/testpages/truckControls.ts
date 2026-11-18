import './truckControls.css';
import { SIM_DT } from '../config';
import { MODELS } from '../game/transport';
import { TRUCK_MODELS, type TruckModel, type TruckScene } from './truckAccess';
import { showTruckStoryboard } from './truckStoryboard';

const PHASE = { ready: 'Готов к запуску', outbound: 'Едет к получателю', entering: 'Заезжает к рампе', unloading: 'Разгрузка', leaving: 'Выезжает из двора', returning: 'Возвращается на станцию', done: 'Круг завершён' };

export function installTruckControls(host: { current(): TruckScene | null; focus(index: number): void }): { update(): void } {
  const root = document.createElement('section');
  root.className = 'panel truck-controls';
  root.setAttribute('aria-label', 'Тест грузовых дворов');
  root.innerHTML = '<b>Грузовые дворы</b><label>Участок<select data-case></select></label><label>Грузовик<select data-model></select></label><div><button type="button" data-entry>Заезд</button><button type="button" data-exit>Выезд</button><button type="button" data-start>Весь рейс</button><button type="button" data-pause>Пауза</button><button type="button" data-step>Кадр +1</button></div><output></output><small>«Заезд» — сразу перед въездом, «Выезд» — сразу у рампы. Манёвры выполняет обычная симуляция игры.</small>';
  const select = root.querySelector<HTMLSelectElement>('[data-case]')!;
  const models = root.querySelector<HTMLSelectElement>('[data-model]')!;
  const approach = document.createElement('label');
  approach.innerHTML = 'Подъезд склада<select><option value="front">Носом к рампе</option><option value="parallel">Вдоль фасада</option></select>';
  models.parentElement!.after(approach);
  const frames = document.createElement('div');
  frames.innerHTML = '<button type="button" data-frames="entry">Кадры заезда</button><button type="button" data-frames="exit">Кадры выезда</button>';
  root.querySelector('output')!.before(frames);
  for (const [i, c] of (host.current()?.truckCases ?? []).entries()) {
    const option = document.createElement('option'); option.value = String(i); option.textContent = c.title; select.append(option);
  }
  const choose = () => {
    const scene = host.current();
    if (!scene) return;
    models.replaceChildren();
    for (const model of TRUCK_MODELS) {
      const option = document.createElement('option');
      const problem = scene.modelProblem(Number(select.value), model);
      option.value = model; option.textContent = `${MODELS[model].name}${problem ? ` — ${problem}` : ''}`; option.disabled = !!problem; models.append(option);
    }
    models.value = scene.truckCases[Number(select.value)].model;
    approach.hidden = scene.truckCases[Number(select.value)].building.form !== 'warehouse';
    approach.querySelector('select')!.value = scene.truckCases[Number(select.value)].building.dockApproach ?? 'front';
    update();
  };
  let error = '';
  approach.addEventListener('change', () => {
    const scene = host.current();
    if (!scene) return;
    error = scene.game.setDockApproach(scene.truckCases[Number(select.value)].building.id, approach.querySelector('select')!.value === 'parallel' ? 'parallel' : 'front') ?? '';
    choose();
  });
  select.addEventListener('change', () => { error = ''; choose(); host.focus(Number(select.value)); });
  root.addEventListener('keydown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    const scene = host.current();
    if (!button || !scene) return;
    error = '';
    if (button.dataset.frames) {
      scene.game.speed = 0;
      try { showTruckStoryboard(Number(select.value), models.value as TruckModel, button.dataset.frames === 'entry' ? 'entry' : 'exit', scene.truckCases[Number(select.value)].building.dockApproach); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    else if (button.hasAttribute('data-pause')) scene.game.speed = scene.game.speed ? 0 : 1;
    else if (button.hasAttribute('data-step')) {
      scene.game.speed = 1;
      scene.game.update(SIM_DT);
      scene.tick();
      scene.game.speed = 0;
    }
    else {
      try { scene.start(Number(select.value), models.value as TruckModel, button.hasAttribute('data-entry') ? 'entry' : button.hasAttribute('data-exit') ? 'exit' : undefined); host.focus(Number(select.value)); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    update();
  });
  document.body.append(root);
  function update(): void {
    const scene = host.current(); root.hidden = !scene;
    if (!scene) return;
    const c = scene.truckCases[Number(select.value)];
    approach.querySelector('select')!.value = c?.building.dockApproach ?? 'front';
    root.querySelector('output')!.textContent = error || `${c ? PHASE[c.phase] : 'Нет участка'} · ${scene.game.time.toFixed(2)} с`;
    root.querySelector('[data-pause]')!.textContent = scene.game.speed ? 'Пауза' : 'Продолжить';
  }
  choose();
  return { update };
}
