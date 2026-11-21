import './industryStationControls.css';
import { SIM_DT } from '../config';
import {
  INDUSTRY_STATION_ACCESS, INDUSTRY_STATION_LOAD, INDUSTRY_STATION_POSTS,
  type IndustryStationOptions, type IndustryStationScene,
} from './industryStations';
import { siteRoot } from './route';

const truckPlural = { one: 'машина', few: 'машины', many: 'машин' } as const;
const plural = new Intl.PluralRules('ru');
const countName = (n: number) => `${n} ${truckPlural[plural.select(n) as keyof typeof truckPlural] ?? truckPlural.many}`;

export function installIndustryStationControls(host: {
  current(): IndustryStationScene | null;
  reset(options: IndustryStationOptions): void;
  focus(overview: boolean): void;
}): { update(): void } {
  const root = document.createElement('section');
  root.className = 'panel industry-station-controls';
  root.setAttribute('aria-label', 'Автостанции предприятий');
  root.innerHTML = `
    <header><h2>Автостанции предприятий</h2><a>Все тесты</a></header>
    <label>Подъезды<select data-access>${Object.entries(INDUSTRY_STATION_ACCESS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
    <div class="industry-station-fields">
      <label>Посты<select data-bays>${INDUSTRY_STATION_POSTS.map((bays) => `<option value="${bays}">${bays}</option>`).join('')}</select></label>
      <label>Нагрузка<select data-load>${Object.entries(INDUSTRY_STATION_LOAD).map(([value, { label, vehicles }]) => `<option value="${value}">${label} · ${countName(vehicles)}</option>`).join('')}</select></label>
    </div>
    <div class="industry-station-actions">
      <button type="button" data-reset>Заново</button>
      <button type="button" data-pause>Пауза</button>
      <button type="button" data-step title="Один такт симуляции">+1 кадр</button>
      <button type="button" data-focus>Вся схема</button>
    </div>
    <p data-error role="alert" hidden></p>
    <dl aria-label="Мясокомбинат">
      <div><dt>На постах</dt><dd data-occupied></dd></div>
      <div><dt>Ждут въезда</dt><dd data-waiting></dd></div>
      <div><dt>Заехали</dt><dd data-arrivals></dd></div>
      <div><dt>Выехали</dt><dd data-departures></dd></div>
    </dl>`;

  const access = root.querySelector<HTMLSelectElement>('[data-access]')!;
  const bays = root.querySelector<HTMLSelectElement>('[data-bays]')!;
  const load = root.querySelector<HTMLSelectElement>('[data-load]')!;
  const pause = root.querySelector<HTMLButtonElement>('[data-pause]')!;
  const step = root.querySelector<HTMLButtonElement>('[data-step]')!;
  const map = root.querySelector<HTMLButtonElement>('[data-focus]')!;
  const error = root.querySelector<HTMLElement>('[data-error]')!;
  const occupied = root.querySelector<HTMLElement>('[data-occupied]')!;
  const waiting = root.querySelector<HTMLElement>('[data-waiting]')!;
  const arrivals = root.querySelector<HTMLElement>('[data-arrivals]')!;
  const departures = root.querySelector<HTMLElement>('[data-departures]')!;
  const metrics = root.querySelector('dl')!;
  root.querySelector('a')!.href = `${siteRoot(location.pathname)}test/`;
  let overview = false;

  const initial = host.current()?.industryStationOptions;
  if (initial) {
    access.value = initial.access;
    bays.value = String(initial.bays);
    load.value = initial.load;
  }
  const reset = () => {
    host.reset({ access: access.value as IndustryStationOptions['access'], bays: Number(bays.value) as IndustryStationOptions['bays'], load: load.value as IndustryStationOptions['load'] });
    overview = false;
    map.textContent = 'Вся схема';
    update();
  };
  root.addEventListener('change', reset);
  root.querySelector('[data-reset]')!.addEventListener('click', reset);
  pause.addEventListener('click', () => {
    const scene = host.current();
    if (!scene) return;
    scene.game.speed = scene.game.speed ? 0 : 1;
    update();
  });
  step.addEventListener('click', () => {
    const scene = host.current();
    if (!scene) return;
    scene.game.speed = 1;
    scene.game.settleMonth();
    scene.game.update(SIM_DT);
    scene.tick();
    scene.game.speed = 0;
    update();
  });
  map.addEventListener('click', () => {
    overview = !overview;
    host.focus(overview);
    map.textContent = overview ? 'К станции' : 'Вся схема';
  });
  root.addEventListener('keydown', (event) => event.stopPropagation());
  document.body.append(root);

  const write = (element: HTMLElement, value: string) => {
    if (element.textContent !== value) element.textContent = value;
  };

  function update(): void {
    const scene = host.current();
    root.hidden = !scene;
    if (!scene) return;
    error.hidden = !scene.errors.length;
    metrics.hidden = !error.hidden;
    pause.disabled = step.disabled = !error.hidden;
    write(pause, scene.game.speed ? 'Пауза' : 'Продолжить');
    write(error, scene.errors.join('\n'));
    const stats = scene.stats;
    write(occupied, `${stats.occupied} / ${scene.yard?.bays ?? 0}`);
    write(waiting, String(stats.waiting));
    waiting.title = `Максимум за прогон — ${stats.peakWaiting}`;
    write(arrivals, String(stats.arrivals));
    write(departures, String(stats.departures));
  }

  update();
  return { update };
}
