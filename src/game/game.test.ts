import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { dist, Vec } from '../core/vec';
import { LEGACY_KINDS } from '../world/biomes';
import { BASE_TOWN_CARGO, EXTRA_TOWN_CARGO, INDUSTRY_LIST } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { corridorHalf } from '../world/worldgen';
import { Game } from './game';
import { road, roadPlan, stationExit, townStreets, withoutCitizens } from './testkit';

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

/** Ставит станцию вплотную к предприятию: сначала со стороны toward, потом с остальных. */
function stationAtIndustry(game: Game, ind: Industry, toward: Vec): Station | null {
  const base = Math.atan2(toward.y - ind.fp.center.y, toward.x - ind.fp.center.x);
  for (const k of [0, 1, -1, 2]) {
    const a = base + (k * Math.PI) / 2;
    const reach = Math.hypot(ind.fp.w, ind.fp.h) / 2 + 20;
    const st = game.placeStation({ x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach }, 14);
    if (st) return st;
  }
  return null;
}

/** Пробует поставить станции вдоль улиц города, пока не получится нужное число. */
function placeStations(game: Game, count: number, minDistance: number) {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  const placed: Station[] = [];
  for (const seg of townStreets(game, town.id)) {
    for (const frac of [0.5, 0.3, 0.7]) {
      for (const side of [-1, 1]) {
        const s = seg.length * frac;
        const p = seg.lut.pointAt(s);
        const t = seg.lut.tangentAt(s);
        const q = { x: p.x - t.y * side * (corridorHalf(seg) + 40), y: p.y + t.x * side * (corridorHalf(seg) + 40) };
        if (placed.some((st) => dist(st.fp.center, q) < minDistance)) continue;
        const st = game.placeStation(q, 14);
        if (st) placed.push(st);
        if (placed.length >= count) return placed;
      }
    }
  }
  return placed;
}

// Симуляции на несколько игровых месяцев: при параллельном прогоне не укладываются в 5 с.
describe('Игра', { timeout: 30_000 }, () => {
  for (const seed of [1, 42, 2024]) {
    it(`мир ${seed}: города, предприятия и жители`, () => {
      const game = new Game(seed);
      expect(game.towns.length).toBeGreaterThanOrEqual(3);
      expect(game.industries.length).toBeGreaterThanOrEqual(6);
      for (const t of game.towns) expect(t.population).toBeGreaterThan(0);
      runSeconds(game, 30);
      expect(game.citizenCars).toBeGreaterThan(0);
      // В потоке — машины жителей и спецтранспорт городов.
      expect(game.citizenCars + game.serviceCars).toBe([...game.traffic.vehicles.values()].length);
    });
  }

  it('города разных стилей, у каждого свой спрос, все виды спроса покрыты', () => {
    const game = new Game(42);
    expect(game.towns.length).toBeGreaterThanOrEqual(8);
    expect(new Set(game.towns.map((t) => t.style)).size).toBeGreaterThanOrEqual(2);
    for (const t of game.towns) {
      expect(t.demands.length).toBeGreaterThanOrEqual(2);
      expect(t.buildings.some((b) => b.kind === 'landmark')).toBe(true);
    }
    // Мир без биома — прежняя средняя полоса: все её грузы и предприятия (биомы — src/world/biomes.test.ts).
    for (const c of [...BASE_TOWN_CARGO, ...EXTRA_TOWN_CARGO]) expect(game.towns.some((t) => t.demands.includes(c))).toBe(true);
    for (const info of INDUSTRY_LIST.filter((t) => LEGACY_KINDS.has(t.kind))) expect(game.industries.some((i) => i.info.kind === info.kind)).toBe(true);
  });

  it('станцию можно пристроить к предприятию с любой стороны', () => {
    const game = new Game(42);
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    let sides = 0;
    for (const dir of [0, 1, 2, 3]) {
      const a = plant.fp.angle + (dir * Math.PI) / 2;
      const reach = (dir % 2 ? plant.fp.h : plant.fp.w) / 2 + 30;
      const p = { x: plant.fp.center.x + Math.cos(a) * reach, y: plant.fp.center.y + Math.sin(a) * reach };
      const plan = game.stationPlan(p, 14);
      if (plan.ok) sides++;
    }
    expect(sides).toBeGreaterThanOrEqual(2);
    const st = stationAtIndustry(game, plant, plant.fp.center)!;
    expect(st.industryId).toBe(plant.id);
    expect(st.industryIds).toContain(plant.id);
    expect(st.accepts.has('grain')).toBe(true);
    // Такую станцию можно снести.
    expect(game.removeStation(st)).toBe(true);
  });

  it('металлургический завод работает только при наличии угля и руды', () => {
    const game = new Game(42);
    const mill = game.industries.find((i) => i.info.kind === 'steelmill')!;
    mill.stock.coal = 30;
    runSeconds(game, 5);
    expect(mill.producedMonth + mill.output).toBe(0);
    mill.stock.ore = 30;
    runSeconds(game, 5);
    expect(mill.producedMonth).toBeGreaterThan(0);
    expect(mill.stock.coal).toBeLessThan(30);
    expect(mill.stock.ore).toBeLessThan(30);
  });

  it('мясокомбинат делает продукты из скота и зерна, а зерно ферма может везти на два вида заводов', () => {
    const game = new Game(42);
    const meat = game.industries.find((i) => i.info.kind === 'meatplant')!;
    meat.stock.livestock = 30;
    runSeconds(game, 5);
    expect(meat.producedMonth + meat.output).toBe(0);
    meat.stock.grain = 30;
    runSeconds(game, 5);
    expect(meat.producedMonth).toBeGreaterThan(0);
    expect(meat.stock.livestock).toBeLessThan(30);
    expect(meat.stock.grain).toBeLessThan(30);
    const st = stationAtIndustry(game, meat, meat.fp.center)!;
    expect([...st.accepts].sort()).toEqual(['grain', 'livestock']);
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const takers = new Set(game.partners(farm, 10).map((p) => game.industries.find((i) => i.id === p.ref.id)?.info.kind));
    expect(takers).toContain('foodplant');
    expect(takers).toContain('meatplant');
  });

  it('подсказки партнёров: куда везти продукцию и откуда сырьё', () => {
    const game = new Game(42);
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const out = game.partners(farm).filter((p) => p.direction === 'out');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => p.cargo === 'grain')).toBe(true);
    const mill = game.industries.find((i) => i.info.kind === 'steelmill')!;
    const inputs = new Set(game.partners(mill).filter((p) => p.direction === 'in').map((p) => p.cargo));
    expect([...inputs].sort()).toEqual(['coal', 'ore']);
    const town = game.towns[0];
    const supply = game.partners(town);
    expect(supply.every((p) => p.direction === 'in' && town.demands.includes(p.cargo))).toBe(true);
  });

  it('грузовая линия ферма → пищевой комбинат возит зерно', () => {
    // Дорога — своя сеть в стороне от городов: машины жителей на неё не попадают, без них счёт в разы быстрее.
    const game = withoutCitizens(new Game(7));
    // Ближайшая пара «ферма — комбинат».
    const pairs = game.industries
      .filter((i) => i.info.kind === 'farm')
      .flatMap((f) => game.industries.filter((i) => i.info.kind === 'foodplant').map((p) => ({ f, p, d: dist(f.fp.center, p.fp.center) })))
      .sort((a, b) => a.d - b.d);
    const { f: farm, p: plant } = pairs[0];
    // Пристраиваем станции к предприятиям со стороны друг друга и ведём дорогу от выезда к выезду.
    const sA = stationAtIndustry(game, farm, plant.fp.center)!;
    const sB = stationAtIndustry(game, plant, farm.fp.center)!;
    expect(sB.accepts.has('grain')).toBe(true);
    const A = stationExit(game, sA.nodeId);
    const B = stationExit(game, sB.nodeId);
    const d = { x: B.pos.x - A.pos.x, y: B.pos.y - A.pos.y };
    const n = { x: -d.y / Math.hypot(d.x, d.y), y: d.x / Math.hypot(d.x, d.y) };
    // Дорога из двух кусков через промежуточную точку, которую можно построить.
    let built = false;
    for (const off of [0, 150, -150, 300, -300, 450, -450, 600, -600]) {
      const M = { x: (A.pos.x + B.pos.x) / 2 + n.x * off, y: (A.pos.y + B.pos.y) / 2 + n.y * off };
      if (!roadPlan(game, A.id, { free: M }).ok) continue;
      road(game, A.id, { free: M });
      built = road(game, M, B.id);
      if (built) break;
    }
    expect(built).toBe(true);
    const line = game.createLine([sA.id, sB.id])!;
    // Грузовая цепочка называется коротко: груз — получатель.
    expect(line.name).toBe('Зерно — Пищекомбинат');
    game.renameLine(line.id, '  Зерновая  ');
    expect(line.name).toBe('Зерновая');
    game.buyVehicle(line.id, 'truck');
    game.buyVehicle(line.id, 'truck');
    // Время на погрузку и дорогу туда с запасом.
    runSeconds(game, MONTH_LENGTH + (dist(sA.fp.center, sB.fp.center) / 18) * 1.8);
    expect(line.problem).toBeNull();
    // Оба грузовика довезли полную загрузку зерна.
    const fullTrip = 16 * 20 * (dist(sA.fp.center, sB.fp.center) / 100);
    expect(line.revenueTotal).toBeGreaterThan(fullTrip * 1.5);
  });

  it('здания можно сносить, переносить, а дорога сквозь дома сносит их', () => {
    const game = new Game(42);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const houses = town.buildings.filter((b) => b.kind === 'res');
    // Снос.
    const victim = houses[0];
    const pop = town.population;
    expect(game.demolishBuilding(victim)).toBe(true);
    expect(town.population).toBeLessThan(pop);
    expect(game.buildingById(victim.id)).toBeUndefined();
    expect(game.structureAt(victim.fp.center)).toBeNull();
    // Перенос: ищем свободное место у улицы, освобождая его сносом.
    const mover = houses[houses.length - 1];
    let moved = false;
    for (const spot of houses.slice(1, 15)) {
      if (spot === mover) continue;
      game.demolishBuilding(spot);
      if (game.movePlan(mover, spot.fp.center).ok) {
        moved = game.moveBuilding(mover, spot.fp.center);
        break;
      }
    }
    expect(moved).toBe(true);
    expect(game.structureAt(mover.fp.center)?.id).toBe(mover.id);
    // Дорога прямо через дом: короткий отрезок поперёк здания.
    const through = (h: (typeof houses)[number]) => {
      const t = { x: Math.cos(h.fp.angle + Math.PI / 2), y: Math.sin(h.fp.angle + Math.PI / 2) };
      const a = { x: h.fp.center.x - t.x * 40, y: h.fp.center.y - t.y * 40 };
      const b = { x: h.fp.center.x + t.x * 40, y: h.fp.center.y + t.y * 40 };
      return roadPlan(game, { free: a }, { free: b });
    };
    const target = houses.find((h) => game.buildingById(h.id) && through(h).ok);
    expect(target).toBeDefined();
    const plan = through(target!);
    expect(plan.demolish).toContain(target!.id);
    game.roadBuilder.apply(plan);
    expect(game.buildingById(target!.id)).toBeUndefined();
  });

  it('сохранение и загрузка восстанавливают партию', () => {
    const game = new Game(7);
    const stations = placeStations(game, 2, 220);
    const line = game.createLine(stations.map((s) => s.id))!;
    game.renameLine(line.id, 'Кольцевая');
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'bus');
    runSeconds(game, MONTH_LENGTH * 1.5);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(loaded.money).toBe(game.money);
    expect(loaded.dateLabel).toBe(game.dateLabel);
    expect(loaded.roads.net.corridors.size).toBe(game.roads.net.corridors.size);
    expect(loaded.roads.net.nodes.size).toBe(game.roads.net.nodes.size);
    expect(loaded.towns.map((t) => t.population)).toEqual(game.towns.map((t) => t.population));
    expect(loaded.stations.size).toBe(game.stations.size);
    expect(loaded.lines.get(line.id)!.name).toBe('Кольцевая');
    expect(loaded.fleet.size).toBe(2);
    // Автобусы в пути едут дальше (машины жителей не сохраняются), стоявшие на станции — там же.
    const driving = [...game.fleet.values()].filter((v) => v.state === 'driving').length;
    expect(loaded.traffic.vehicles.size).toBe(driving);
    for (const v of loaded.fleet.values()) expect(v.state).toBe(game.fleet.get(v.id)!.state);
    // Загруженная партия продолжает работать и зарабатывать: ждём первого дохода, но не дольше полутора месяцев.
    const before = loaded.lines.get(line.id)!.revenueTotal;
    const earned = () => loaded.lines.get(line.id)!.revenueTotal > before;
    loaded.speed = 1;
    for (let t = 0; t < MONTH_LENGTH * 1.5 && !earned(); t += 0.1) loaded.update(0.1);
    expect(loaded.lines.get(line.id)!.revenueTotal).toBeGreaterThan(before);
  });

  it('город, которому тесно, сам прокладывает новые улицы и застраивает их', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const grow = (game as unknown as { growTown(t: typeof town): void }).growTown.bind(game);
    const before = new Set(game.roads.net.corridors.keys());
    const houses = town.buildings.length;
    const money = game.money;
    const radius = town.radius;
    for (let i = 0; i < 8; i++) {
      town.growthAcc = 3000;
      grow(town);
    }
    const added = [...game.roads.net.corridors.values()].filter((c) => !before.has(c.id));
    expect(added.length).toBeGreaterThan(0);
    expect(town.buildings.length).toBeGreaterThan(houses);
    // Город строит за свой счёт.
    expect(game.money).toBe(money);
    // Радиус (край плотной застройки) меряется шагами по 20 м: ядро уплотнилось — край мог сдвинуться на шаг.
    expect(town.radius).toBeGreaterThanOrEqual(radius - 20);
    // Новые улицы — обычные улицы (и куски разрезанных улиц и проспектов).
    for (const s of added) expect(s.cls === 'street' || s.cls === 'avenue').toBe(true);
    // Машины по-прежнему ездят.
    runSeconds(game, 20);
    expect(game.citizenCars + game.serviceCars).toBe([...game.traffic.vehicles.values()].length);
  });

  it('автобусная линия в городе приносит доход', () => {
    const game = new Game(7);
    const stations = placeStations(game, 2, 220);
    expect(stations).toHaveLength(2);
    const line = game.createLine(stations.map((s) => s.id))!;
    expect(line).not.toBeNull();
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'bus');
    runSeconds(game, MONTH_LENGTH * 2);
    expect(line.problem).toBeNull();
    expect(line.revenueTotal).toBeGreaterThan(0);
  });
});
