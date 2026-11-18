import './parkingControls.css';
import type { ParkingScene } from './parking';

interface Host {
  current(): ParkingScene | null;
  overview(): void;
  step(): void;
  focus(index: number): void;
}

/** Навигация по участкам и шаг симуляции; транспорт задаётся общим тестовым инструментом. */
export function installParkingControls(host: Host): { update(): void } {
  const root = document.createElement('section');
  root.id = 'parking-debug';
  root.className = 'panel';
  root.setAttribute('aria-label', 'Тест парковок');
  root.innerHTML = `<b>Тест парковок</b><select aria-label="Участок парковки"><option value="">Все участки</option></select>
    <div class="parking-playback"><button type="button" data-debug="pause">Продолжить</button><button type="button" data-debug="step">Кадр +1</button><button type="button" data-debug="reset">Сбросить сцену</button><output></output></div>
    <small>Инструмент «Автомобили» — добавить транспорт. Выберите машину, чтобы отправить её в поездку.</small>`;
  const select = root.querySelector('select')!;
  for (const [i, c] of (host.current()?.cases ?? []).entries()) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = c.title;
    select.append(option);
  }
  select.addEventListener('change', () => { if (select.value !== '') host.focus(Number(select.value)); });
  root.addEventListener('keydown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest('button')?.dataset.debug;
    const scene = host.current();
    if (!scene) return;
    if (action === 'pause') scene.game.speed = scene.game.speed ? 0 : 1;
    if (action === 'step') host.step();
    if (action === 'reset') { host.overview(); select.value = ''; }
    update();
  });
  document.body.append(root);
  function update(): void {
    const scene = host.current();
    root.hidden = !scene;
    if (!scene) return;
    root.querySelector('[data-debug="pause"]')!.textContent = scene.game.speed ? 'Пауза' : 'Продолжить';
    root.querySelector('output')!.textContent = `${scene.game.time.toFixed(2)} с`;
  }
  update();
  return { update };
}
