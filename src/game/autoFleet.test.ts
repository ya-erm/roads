import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import type { Station } from '../world/entities';
import { DEFAULT_SETTINGS } from '../world/settings';
import { advise } from './advisor';
import { Game } from './game';
import {
  anchorOf,
  connectStations,
  freightRoute,
  HIGHWAY,
  nearestPair,
  roadPlan,
  runMonths,
  runSeconds,
  stationAtIndustry,
  stationExit,
  townStreets,
  withoutCitizens,
} from './testkit';
import { AUTO_FLEET, type FleetVehicle } from './transport';

/** Станции у фермы и ближайшего пищекомбината (seed 7) и маршрут между ними — без дороги между выездами. */
function roadlessRoute(game: Game) {
  game.money = 5_000_000;
  const { a, b } = nearestPair(game, 'farm', 'foodplant');
  const sA = stationAtIndustry(game, a, b.fp.center)!;
  const sB = stationAtIndustry(game, b, a.fp.center)!;
  return { sA, sB, line: game.createLine([sA.id, sB.id])! };
}

/** Выезды станций — дорогой-проектом (как рисует игрок «Со строительством»), из двух кусков, как connectStations. */
function projectBetween(game: Game, sA: Station, sB: Station): boolean {
  const A = stationExit(game, sA.nodeId);
  const B = stationExit(game, sB.nodeId);
  const d = { x: B.pos.x - A.pos.x, y: B.pos.y - A.pos.y };
  const n = { x: -d.y / Math.hypot(d.x, d.y), y: d.x / Math.hypot(d.x, d.y) };
  const build = (from: Parameters<typeof anchorOf>[1], to: Parameters<typeof anchorOf>[1]) => {
    const plan = game.roadBuilder.road(anchorOf(game, from), anchorOf(game, to), HIGHWAY, { project: true });
    return plan.ok && game.roadBuilder.apply(plan);
  };
  for (const off of [0, 150, -150, 300, -300, 450, -450]) {
    const M = { x: (A.pos.x + B.pos.x) / 2 + n.x * off, y: (A.pos.y + B.pos.y) / 2 + n.y * off };
    if (!roadPlan(game, A.id, { free: M }, HIGHWAY).ok) continue;
    build(A.id, { free: M });
    if (build(M, B.id)) return true;
  }
  return false;
}

/**
 * Ферма и ближайший пищекомбинат (seed 7): станции у обоих, выезды соединены трассой, маршрут без транспорта.
 * Трасса — своя сеть вдали от городов, машины жителей на неё не попадают: без них месяцы симуляции — доли секунды.
 */
function farmRoute() {
  const game = withoutCitizens(new Game(7));
  const { built, line, from } = freightRoute(game);
  expect(built).toBe(true);
  return { game, line, farm: from };
}

// Симуляции на месяцы вперёд: при параллельном прогоне всех тестов — дольше стандартного лимита.
describe('Авто-парк и равномерный выпуск', { timeout: 30_000 }, () => {
  it('маршруту — подходящий транспорт: грузовому грузовики, пассажирскому автобусы, смешанному любой', () => {
    const { game, line } = farmRoute();
    expect(game.lineKind(line)).toBe('freight');
    expect(game.autoModel(line)).toBe('truck');
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'truck');
    expect(game.lineKind(line)).toBeNull();
    // Авто-парк и на смешанном докупает грузовик — по станциям маршрут грузовой.
    expect(game.autoModel(line)).toBe('truck');
    // Две станции в городе только для пассажиров — автобусный маршрут.
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const placed: Station[] = [];
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      const q = { x: p.x - t.y * 40, y: p.y + t.x * 40 };
      if (placed.length >= 2 || placed.some((s) => dist(s.fp.center, q) < 300)) continue;
      const st = game.placeStation(q, 14, 'road', { pax: true, cargo: false });
      if (st) placed.push(st);
    }
    const bus = game.createLine(placed.map((s) => s.id))!;
    expect(game.lineKind(bus)).toBe('passengers');
    expect(game.autoModel(bus)).toBe('bus');
  });

  it('авто-парк докупает грузовик, когда зерно копится, но не больше максимума', () => {
    const { game, line, farm } = farmRoute();
    game.buyVehicle(line.id, 'truck');
    // Ферма выросла — одному грузовику зерно не вывезти.
    farm.level = 4;
    game.setLineAuto(line.id, { on: true, min: 1, max: 3 });
    expect(line.vehicles).toHaveLength(1);
    let most = 0;
    let months = 0;
    while (line.vehicles.length < 3 && months < 6) {
      runMonths(game, 1, () => (most = Math.max(most, line.vehicles.length)));
      months++;
    }
    expect(line.vehicles).toHaveLength(3);
    // Той же моделью и по одной: после покупки ждёт окно (не короче месяца), пока она скажется.
    expect(line.vehicles.every((id) => game.fleet.get(id)!.model === 'truck')).toBe(true);
    expect(months).toBeGreaterThanOrEqual(2);
    // Зерна всё ещё больше, чем вывозят, но выше максимума не идёт.
    runMonths(game, 2, () => (most = Math.max(most, line.vehicles.length)));
    expect(line.demandLast!.load).toBeGreaterThan(0.8);
    expect(most).toBe(3);
    expect(line.vehicles).toHaveLength(3);
  });

  it('авто-парк по умолчанию — от нынешнего числа машин до 10, а машин больше — до их числа', () => {
    const { game, line } = farmRoute();
    for (let i = 0; i < 2; i++) game.buyVehicle(line.id, 'truck');
    game.setLineAuto(line.id, { on: true });
    expect(line.auto).toMatchObject({ on: true, min: 2, max: 10 });

    const many = farmRoute();
    many.game.money = 1e9;
    for (let i = 0; i < 12; i++) many.game.buyVehicle(many.line.id, 'truck');
    many.game.setLineAuto(many.line.id, { on: true });
    expect(many.line.auto).toMatchObject({ min: 12, max: 12 });
    expect(many.line.vehicles).toHaveLength(12);
  });

  it('авто-парк продаёт лишний, когда машины ездят пустыми, но не ниже минимума; пределы держит сразу', () => {
    const { game, line } = farmRoute();
    for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
    // На ферме ничего не грузим — рейсы пустые.
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: [], unload: 'auto' });
    game.setLineAuto(line.id, { on: true, min: 2, max: 5 });
    expect(line.vehicles).toHaveLength(3);
    let least = 3;
    runMonths(game, 4, () => (least = Math.min(least, line.vehicles.length)));
    expect(line.vehicles).toHaveLength(2);
    expect(least).toBe(2);
    // Минимум выше, чем машин, — докупает сразу; максимум ниже — продаёт сразу.
    game.setLineAuto(line.id, { min: 4 });
    expect(line.vehicles).toHaveLength(4);
    expect(line.auto!.max).toBe(5);
    game.setLineAuto(line.id, { max: 1 });
    expect(line.vehicles).toHaveLength(1);
    expect(line.auto!.min).toBe(1);
    // Настройки — в сохранении; в старом сохранении их нет — авто-парк выключен.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(new Game(game.settings, save).lines.get(line.id)!.auto).toMatchObject({ on: true, min: 1, max: 1 });
    delete save.lines[0].auto;
    const old = withoutCitizens(new Game(game.settings, save));
    expect(old.lines.get(line.id)!.auto?.on ?? false).toBe(false);
    old.buyVehicle(line.id, 'truck');
    runMonths(old, 1);
    expect(old.lines.get(line.id)!.vehicles).toHaveLength(2);
  });

  it('минимум 0: авто-парк убирает последнюю машину, пока она не нужна, и возвращает, когда появляется груз', () => {
    const { game, line } = farmRoute();
    // Пустой линии по умолчанию — от одной машины: включённый авто-парк сразу её покупает.
    game.setLineAuto(line.id, { on: true });
    expect(line.auto!.min).toBe(1);
    expect(line.vehicles).toHaveLength(1);
    // Минимум опускается до 0, но не ниже; максимум — не ниже 1.
    game.setLineAuto(line.id, { min: -1 });
    expect(line.auto!.min).toBe(0);
    game.setLineAuto(line.id, { max: 0 });
    expect(line.auto).toMatchObject({ min: 0, max: 1 });
    game.setLineAuto(line.id, { max: 3 });
    expect(line.vehicles).toHaveLength(1);
    // На ферме ничего не грузим — грузовик ездит пустым, и авто-парк продаёт и последний.
    const rule = game.stopRule(line, 0);
    game.setStopRule(line.id, 0, { ...rule, load: [] });
    let months = 0;
    while (line.vehicles.length && months < 6) {
      runMonths(game, 1);
      months++;
    }
    expect(line.vehicles).toHaveLength(0);
    expect(line.auto!.on).toBe(true);
    // Без машин ничего не ломается: интервала и советов нет, график скорости — по модели, которую купит авто-парк.
    expect(game.lineInterval(line)).toBeNull();
    expect(game.lineAdvice(line)).toEqual([]);
    expect(game.lineSpeedChart(line)).not.toBeNull();
    // Грузить нечего — спроса нет, машина не возвращается.
    expect(game.idleDemand(line)).toBe(0);
    runMonths(game, 2);
    expect(line.vehicles).toHaveLength(0);
    // Зерно снова можно грузить — спрос есть, авто-парк покупает грузовик (один: дальше — по загрузке рейсов).
    game.setStopRule(line.id, 0, rule);
    expect(game.idleDemand(line)).toBeGreaterThan(AUTO_FLEET.wake);
    months = 0;
    while (!line.vehicles.length && months < 3) {
      runMonths(game, 1);
      months++;
    }
    expect(line.vehicles).toHaveLength(1);
    expect(game.fleet.get(line.vehicles[0])!.model).toBe('truck');
  });

  it('игрок сам продал все машины: авто-парк остаётся включённым, минимум опускается до 0 — обратно сразу не докупает', () => {
    const { game, line } = farmRoute();
    const sellAll = () => {
      for (const id of [...line.vehicles]) {
        game.sellVehicle(id);
        game.fitAutoRange(line.id);
      }
    };
    game.setLineAuto(line.id, { on: true, min: 2, max: 3 });
    expect(line.vehicles).toHaveLength(2);
    sellAll();
    expect(line.vehicles).toHaveLength(0);
    expect(line.auto).toMatchObject({ on: true, min: 0, max: 3 });
    // Сразу не докупает: окно спроса начинается заново, машина вернётся по его итогам.
    expect(line.statsFrom).toBe(game.time);
    runMonths(game, 0.5);
    expect(line.vehicles).toHaveLength(0);

    // Минимум уже 0 — так же: остаётся включённым и пустым.
    game.setLineAuto(line.id, { min: 1 });
    expect(line.vehicles).toHaveLength(1);
    game.setLineAuto(line.id, { min: 0 });
    sellAll();
    expect(line.vehicles).toHaveLength(0);
    expect(line.auto).toMatchObject({ on: true, min: 0, max: 3 });
  });

  it('денег не хватило — покупка ждёт и случается, как только их хватает, не дожидаясь конца месяца', () => {
    const { game, line } = farmRoute();
    game.buyVehicle(line.id, 'truck');
    game.money = 10_000;
    game.setLineAuto(line.id, { on: true, min: 3, max: 5 });
    expect(line.vehicles).toHaveLength(1);
    expect(line.auto!.noMoney).toBe(true);
    // Денег всё ещё мало — ждёт.
    runSeconds(game, 1);
    expect(line.vehicles).toHaveLength(1);
    // Деньги пришли посреди месяца — сразу добирает до минимума, и ждать больше нечего.
    game.money = 1_000_000;
    runSeconds(game, 1);
    expect(game.monthProgress).toBeLessThan(0.5);
    expect(line.vehicles).toHaveLength(3);
    expect(line.auto!.noMoney).toBeUndefined();
    // Игрок сам купил машину на маршрут — ждавшая денег покупка отменяется.
    game.money = 10_000;
    game.setLineAuto(line.id, { min: 4 });
    expect(line.auto!.noMoney).toBe(true);
    game.buyVehicle(line.id, 'truck');
    game.fitAutoRange(line.id);
    expect(line.auto!.noMoney).toBeUndefined();
  });

  it('между станциями нет дороги — авто-парк не покупает, а проложили — сразу добирает до минимума', () => {
    const game = withoutCitizens(new Game(7));
    const { sA, sB, line } = roadlessRoute(game);
    expect(game.lineGap(line)).toBe(`Нет дороги: ${sA.name} → ${sB.name}`);
    // Минимум 2 — без дороги не докупает ни сразу, ни по итогам месяцев (груз на ферме копится).
    game.setLineAuto(line.id, { on: true, min: 2, max: 4 });
    expect(line.vehicles).toHaveLength(0);
    expect(line.auto!.noRoad).toBe(true);
    expect(line.auto!.noMoney).toBeUndefined();
    runMonths(game, 2);
    expect(line.vehicles).toHaveLength(0);
    // Советник говорит о дороге, а не о машинах: без кнопки «купить».
    const tips = advise(game).filter((a) => a.line === line.id);
    expect(tips.map((a) => a.title)).toEqual(['Маршрут без дороги']);
    expect(tips[0].detail).toContain(`Нет дороги: ${sA.name} → ${sB.name}`);
    expect(tips[0].fix).toBeUndefined();
    // Дорогу проложили — в ближайший же такт покупает до минимума, советов о дороге больше нет.
    expect(connectStations(game, sA, sB, HIGHWAY)).toBe(true);
    expect(game.lineGap(line)).toBeNull();
    runSeconds(game, 0.5);
    expect(line.vehicles).toHaveLength(2);
    expect(line.auto!.noRoad).toBeUndefined();
    expect(advise(game).filter((a) => a.line === line.id && a.title === 'Маршрут без дороги')).toEqual([]);
  });

  it('пустая линия без дороги (минимум 0): спрос есть, но машину не возвращает, пока нет дороги', () => {
    const game = withoutCitizens(new Game(7));
    const { sA, sB, line } = roadlessRoute(game);
    game.setLineAuto(line.id, { on: true, min: 0, max: 3 });
    expect(line.vehicles).toHaveLength(0);
    runMonths(game, 3);
    expect(game.idleDemand(line)).toBeGreaterThan(AUTO_FLEET.wake);
    expect(line.vehicles).toHaveLength(0);
    // Совет — о дороге (с минимумом 0 «Маршрут без машин» не показывается, а дорога всё равно нужна).
    expect(advise(game).find((a) => a.line === line.id)?.title).toBe('Маршрут без дороги');
    expect(connectStations(game, sA, sB, HIGHWAY)).toBe(true);
    let months = 0;
    while (!line.vehicles.length && months < 3) {
      runMonths(game, 1);
      months++;
    }
    expect(line.vehicles).toHaveLength(1);
  });

  it('«Со строительством»: пока дорога — проект, авто-парк ждёт; участки открыли — покупает', () => {
    const game = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 7, construction: 'build' }));
    const { sA, sB, line } = roadlessRoute(game);
    expect(projectBetween(game, sA, sB)).toBe(true);
    expect(game.construction.projects.size).toBeGreaterThan(0);
    // Проект в движение не входит — маршрут не проехать.
    expect(game.lineGap(line)).not.toBeNull();
    game.setLineAuto(line.id, { on: true, min: 1, max: 3 });
    expect(line.vehicles).toHaveLength(0);
    // Бригад нет — стройка стоит, машины не покупаются.
    runMonths(game, 1);
    expect(line.vehicles).toHaveLength(0);
    // Стройка пошла (бригада — сразу на месте и быстрая): пока открыт не весь путь — ждёт, весь — покупает.
    game.construction.crews.rate = () => 40;
    let bought = false;
    let gapWhileBought = false;
    for (let t = 0; t < 400 && !bought; t += 0.5) {
      runSeconds(game, 0.5);
      bought = line.vehicles.length > 0;
      if (bought && game.construction.projects.size && game.lineGap(line)) gapWhileBought = true;
    }
    expect(bought).toBe(true);
    expect(gapWhileBought).toBe(false);
    expect(game.lineGap(line)).toBeNull();
    expect(line.vehicles).toHaveLength(1);
  });

  it('спрос пустой автобусной линии — по жителям у её остановок', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const placed: Station[] = [];
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      const q = { x: p.x - t.y * 40, y: p.y + t.x * 40 };
      if (placed.length >= 2 || placed.some((s) => dist(s.fp.center, q) < 300)) continue;
      const st = game.placeStation(q, 14, 'road', { pax: true, cargo: false });
      if (st) placed.push(st);
    }
    const bus = game.createLine(placed.map((s) => s.id))!;
    expect(bus.vehicles).toHaveLength(0);
    expect(placed.every((s) => s.catchPop > 0)).toBe(true);
    expect(game.idleDemand(bus)).toBeGreaterThan(0);
    // Жителей у остановок нет — и спроса нет.
    for (const s of placed) s.catchPop = 0;
    expect(game.idleDemand(bus)).toBe(0);
  });

  it('купленные разом грузовики уходят с первой станции с интервалом, а не пачкой', () => {
    const { game, line } = farmRoute();
    game.setLineSpacing(line.id, true);
    const trucks = [0, 1, 2].map(() => game.buyVehicle(line.id, 'truck')!);
    const departed = new Map<number, number>();
    let waitedForInterval = false;
    game.speed = 1;
    for (let t = 0; t < MONTH_LENGTH * 6 && departed.size < 3; t += 0.1) {
      game.update(0.1);
      for (const v of trucks) {
        if (game.spacingLeft(v) !== null) waitedForInterval = true;
        if (!departed.has(v.id) && v.state === 'driving') departed.set(v.id, game.time);
      }
    }
    expect(departed.size).toBe(3);
    // Карточка маршрута показывает, что машина ждёт интервала.
    expect(waitedForInterval).toBe(true);
    const times = [...departed.values()].sort((a, b) => a - b);
    const interval = game.lineInterval(line)!;
    expect(interval).toBeGreaterThan(15);
    // Между отправлениями — заметная доля интервала (круг / 3), а не пара секунд.
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThan(interval * 0.6);
    // Одной машине ждать незачем.
    game.sellVehicle(trucks[1].id);
    game.sellVehicle(trucks[2].id);
    expect(game.lineInterval(line)).toBeNull();
  });

  it('машину, которая ждёт интервала, можно отправить вручную сразу', () => {
    const { game, line } = farmRoute();
    game.setLineSpacing(line.id, true);
    const trucks = [0, 1, 2].map(() => game.buyVehicle(line.id, 'truck')!);
    game.speed = 1;
    let waiting: FleetVehicle | undefined;
    for (let t = 0; t < MONTH_LENGTH * 6 && !waiting; t += 0.1) {
      game.update(0.1);
      waiting = trucks.find((v) => game.spacingLeft(v) !== null);
    }
    expect(waiting).toBeDefined();
    // Интервал начинается, когда предыдущая только что уехала и ещё выезжает со станции: даём ей освободить
    // выезд (машина всё это время ждёт интервала), иначе и без ожидания новой машине некуда встать.
    for (let t = 0; t < 4; t += 0.1) game.update(0.1);
    expect(game.spacingLeft(waiting!)).not.toBeNull();
    const before = game.time;
    game.dispatchNow(waiting!.id);
    // Отпускает в ближайший же тик, не дожидаясь исходного срока.
    for (let t = 0; t < 1 && waiting!.state !== 'driving'; t += 0.1) game.update(0.1);
    expect(waiting!.state).toBe('driving');
    expect(game.time - before).toBeLessThan(1);
  });

  it('выключенный интервал отпускает новые машины сразу, без очереди по одной', () => {
    const { game, line } = farmRoute();
    // У нового маршрута интервал выключен сразу.
    expect(line.noSpacing).toBe(true);
    const trucks = [0, 1, 2].map(() => game.buyVehicle(line.id, 'truck')!);
    game.speed = 1;
    let anyWaited = false;
    const departed = new Map<number, number>();
    for (let t = 0; t < MONTH_LENGTH * 2 && departed.size < 3; t += 0.1) {
      game.update(0.1);
      for (const v of trucks) {
        if (game.spacingLeft(v) !== null) anyWaited = true;
        if (!departed.has(v.id) && v.state === 'driving') departed.set(v.id, game.time);
      }
    }
    expect(departed.size).toBe(3);
    expect(anyWaited).toBe(false);
    // Включаем обратно — новая машина снова выжидает очередь.
    game.setLineSpacing(line.id, true);
    const extra = game.buyVehicle(line.id, 'truck')!;
    let waitedAgain = false;
    for (let t = 0; t < MONTH_LENGTH * 2 && extra.state !== 'driving'; t += 0.1) {
      game.update(0.1);
      if (game.spacingLeft(extra) !== null) waitedAgain = true;
    }
    expect(waitedAgain).toBe(true);
  });

  it('новый маршрут — интервал выключен; старое сохранение без поля — как раньше, с интервалом', () => {
    const { game, line } = farmRoute();
    expect(line.noSpacing).toBe(true);
    const reload = (save: ReturnType<Game['toSave']>) => withoutCitizens(new Game(game.settings, JSON.parse(JSON.stringify(save))));
    // Выключенный интервал сохраняется; включённый игроком — тоже.
    expect(reload(game.toSave()).lines.get(line.id)!.noSpacing).toBe(true);
    game.setLineSpacing(line.id, true);
    expect(reload(game.toSave()).lines.get(line.id)!.noSpacing).toBe(false);
    // В сохранении до этого изменения поля нет — интервал включён: машины выжидают очередь на первой станции.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    delete save.lines[0].noSpacing;
    const old = reload(save);
    const oldLine = old.lines.get(line.id)!;
    expect(oldLine.noSpacing).toBeUndefined();
    const trucks = [0, 1, 2].map(() => old.buyVehicle(oldLine.id, 'truck')!);
    old.speed = 1;
    let waited = false;
    for (let t = 0; t < MONTH_LENGTH * 6 && !waited; t += 0.1) {
      old.update(0.1);
      waited = trucks.some((v) => old.spacingLeft(v) !== null);
    }
    expect(waited).toBe(true);
  });
});
