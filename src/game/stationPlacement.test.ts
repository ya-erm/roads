import { describe, expect, it } from 'vitest';
import { MIN_SEGMENT_LEN, STATION } from '../config';
import { dist } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { NEW_GAME_SETTINGS, TERRAIN_VERSION } from '../world/settings';
import { pointInFootprint } from '../world/spatial';
import type { Station } from '../world/entities';
import { clampDriveway, Game, type RoadStationOptions } from './game';
import { fieldSpot, road, roadPlan, STREET, withoutCitizens } from './testkit';

/** Карман станции вдоль дороги от её узла до съезда: половина площадки и съезд. */
const pocket = STATION.size.w / 2 + STATION.pocketRun + STATION.pocketDiverge;
/** От конца улицы (тупика) до узла кармана. */
const pocketHalf = pocket + MIN_SEGMENT_LEN;
/** Отступ съезда от поперечной улицы под прямым углом: кромка съезда не заходит на её кромку. */
const crossClear = 2 * (LANE_W + ROAD_MARGIN) - 1 + 0.5;

/** Ровная карта без городов и улица с запада на восток в чистом поле. */
function scene(length = 600) {
  const game = withoutCitizens(
    new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 50_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }),
  );
  game.modelTier = 3;
  const a = fieldSpot(game, length);
  const plan = roadPlan(game, { free: a }, { free: { x: a.x + length, y: a.y } }, STREET);
  if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(plan.reason ?? 'улица не построилась');
  return { game, x: a.x, y: a.y };
}

/** Автовокзал у улицы со стороны точки (x, y): как ставить — road. */
function terminal(game: Game, x: number, y: number, road: RoadStationOptions = {}): Station {
  const st = game.placeStation({ x, y }, 30, 'road', { pax: true, cargo: false }, 0, 2, undefined, false, road);
  if (!st) throw new Error(game.stationPlan({ x, y }, 30, 'road', 0, 2, undefined, false, road).reason ?? 'не встал');
  return st;
}

/** Фасад площадки (ближняя к улице сторона) — на столько от оси улицы. */
const front = (st: Station, y: number) => Math.abs(st.fp.center.y - y) - st.fp.h / 2;

describe('Длина выезда автостанции', () => {
  it('по шагам в границах; при постановке — какую выбрали, станция дальше от улицы на разницу', () => {
    const R = STATION.drivewayRange;
    expect(clampDriveway(0)).toBe(R.min);
    expect(clampDriveway(1000)).toBe(R.max);
    expect(clampDriveway(R.min + R.step * 2 + 1)).toBe(R.min + R.step * 2);
    const { game, x, y } = scene();
    const near = terminal(game, x + 150, y + 40, { driveway: R.min });
    const far = terminal(game, x + 450, y + 40, { driveway: R.min + 6 * R.step });
    expect(near.driveway).toBe(R.min);
    expect(far.driveway).toBe(R.min + 6 * R.step);
    expect(front(far, y) - front(near, y)).toBeCloseTo(6 * R.step, 0);
  });

  it('в карточке: длиннее и короче — тот же выезд из того же места, станция в его конце; Ctrl+Z возвращает', () => {
    const { game, x, y } = scene();
    const st = terminal(game, x + 300, y + 40);
    const was = { ...st.fp.center };
    const before = front(st, y);
    expect(game.setStationDriveway(st.id, STATION.driveway + 3 * STATION.drivewayRange.step)).toBeNull();
    expect(st.driveway).toBe(STATION.driveway + 3 * STATION.drivewayRange.step);
    expect(front(st, y) - before).toBeCloseTo(3 * STATION.drivewayRange.step, 0);
    // Та же сторона, то же место вдоль улицы.
    expect(st.fp.center.x).toBeCloseTo(was.x, 0);
    expect(st.fp.center.y).toBeGreaterThan(y);
    // Узел станции — тупик выезда, выезд один и примыкает к улице.
    const net = game.roads.net;
    const node = net.node(st.nodeId);
    expect(node.corridors).toHaveLength(1);
    expect(net.problems()).toEqual([]);
    expect(game.setStationDriveway(st.id, STATION.drivewayRange.min)).toBeNull();
    expect(front(st, y)).toBeLessThan(before);
    game.undo();
    expect(game.stations.get(st.id)!.driveway).toBe(STATION.driveway + 3 * STATION.drivewayRange.step);
  });

  it('цена шага — только разница выезда: длиннее — доплата за прибавку, короче — возврат половины; туда-обратно — копейки', () => {
    const { game, x, y } = scene();
    const st = terminal(game, x + 300, y + 40);
    const step = STATION.drivewayRange.step;
    const m0 = game.money;
    const longer = game.stationDrivewayPlan(st.id, STATION.driveway + step);
    expect(longer.ok).toBe(true);
    // За станцию (COST.station) ни платы, ни возврата: шаг стоит как кусок выезда длиной step, не тысячи.
    expect(longer.cost).toBeGreaterThan(0);
    expect(longer.cost).toBeLessThan(1000);
    expect(game.setStationDriveway(st.id, STATION.driveway + step)).toBeNull();
    expect(m0 - game.money).toBeCloseTo(longer.cost, -1);
    const m1 = game.money;
    const shorter = game.stationDrivewayPlan(st.id, STATION.driveway);
    expect(shorter.cost).toBeLessThanOrEqual(0);
    expect(game.setStationDriveway(st.id, STATION.driveway)).toBeNull();
    expect(game.money - m1).toBeCloseTo(-shorter.cost, -1);
    // Восемь шагов туда и обратно — дешевле одной станции.
    const m2 = game.money;
    for (let i = 1; i <= 4; i++) expect(game.setStationDriveway(st.id, STATION.driveway + i * step)).toBeNull();
    for (let i = 3; i >= 0; i--) expect(game.setStationDriveway(st.id, STATION.driveway + i * step)).toBeNull();
    expect(m2 - game.money).toBeLessThan(2000);
  });

  it('станции вдоль дороги и старой без длины — тоже: у первой выезда нет, у второй длина по умолчанию прежняя', () => {
    const { game, x, y } = scene();
    const side = terminal(game, x + 300, y + 40, { side: true });
    expect(game.stationDrivewayPlan(side.id, 30).ok).toBe(false);
    const old = terminal(game, x + 120, y - 40);
    delete old.driveway;
    expect(game.setStationDriveway(old.id, 30)).toBeNull();
    expect(old.driveway).toBe(clampDriveway(30));
  });
});

describe('Автовокзал вдоль дороги, с дублёром', () => {
  it('площадка боком к улице, между ними — дублёр по ходу движения этого края (съезд и въезд), узел — на дублёре', () => {
    const { game, x, y } = scene();
    const st = terminal(game, x + 300, y + 40, { side: true });
    expect(st.side).toBe(true);
    const net = game.roads.net;
    const node = net.node(st.nodeId);
    // Стык на дублёре напротив середины площадки: съезд с одной стороны, въезд — с другой.
    expect(node.corridors).toHaveLength(2);
    expect(node.pos.x).toBeCloseTo(x + 300, 0);
    expect(node.pos.y).toBeGreaterThan(y + LANE_W + STATION.pocketIsland);
    for (const id of node.corridors) {
      const c = net.corridor(id);
      // Одна полоса в одну сторону.
      expect(c.lanes).toHaveLength(1);
      expect(c.cls).toBe('street');
    }
    // Южный край — едут на восток (y вниз): съезд — западнее, дублёр ведёт на восток, к въезду.
    const [off, on] = node.corridors.map((id) => net.corridor(id)).sort((p, q) => p.lut.pointAt(p.length / 2).x - q.lut.pointAt(q.length / 2).x);
    const east = (c: typeof off) => {
      const l = c.lanes[0];
      const ax = c.lut.pointAt(c.length).x - c.lut.pointAt(0).x;
      return Math.sign(ax) * l.flow;
    };
    expect(east(off)).toBe(1);
    expect(east(on)).toBe(1);
    // Площадка вдоль улицы, сразу за дублёром.
    expect(Math.abs(Math.sin(st.fp.angle))).toBeLessThan(0.01);
    expect(st.fp.center.x).toBeCloseTo(x + 300, 0);
    expect(front(st, y) - (node.pos.y - y)).toBeCloseTo(LANE_W / 2 + 1.5 + STATION.pocketGap, 0);
    // На улице — два перекрёстка: съезд и въезд.
    const joints = [...net.nodes.values()].filter((nd) => nd.kind === 'junction' && Math.abs(nd.pos.y - y) < 1);
    expect(joints).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('автобусы съезжают в карман, встают на разные перроны и уезжают дальше по улице', () => {
    const { game, x, y } = scene(700);
    const a = terminal(game, x + 200, y + 40, { side: true });
    const b = terminal(game, x + 500, y - 40, { side: true });
    const line = game.createLine([a.id, b.id])!;
    expect(line).toBeTruthy();
    for (const m of ['bus', 'bus2', 'bus3'] as const) expect(game.buyVehicle(line.id, m)).toBeTruthy();
    game.speed = 1;
    const used = new Set<string>();
    let arrivals = 0;
    const seen = new Set<number>();
    for (let t = 0; t < 300; t += 0.1) {
      game.update(0.1);
      for (const v of game.fleet.values()) {
        if (!v.enter) {
          seen.delete(v.id);
          continue;
        }
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        arrivals++;
        const st = game.stations.get(line.stops[v.stop])!;
        used.add(`${st.id}:${v.bay}`);
        // Подъехал по дублёру — к посту сворачивает с него, а не через встречные полосы улицы.
        expect(dist(v.enter.pos, game.roads.net.node(st.nodeId).pos)).toBeLessThan(LANE_W);
        const others = st.occupied.filter((id) => id !== v.id).map((id) => game.fleet.get(id)?.bay);
        expect(others).not.toContain(v.bay);
      }
      // Стоящие на постах — на площадке, носом к зданию (прочь от улицы).
      for (const st of [a, b]) {
        for (const look of game.bayLooks(st)) {
          if (!pointInFootprint(look.pos, st.fp, LANE_W * 3)) throw new Error(`автобус далеко от станции ${st.name}`);
        }
      }
    }
    expect(line.problem).toBeNull();
    expect(arrivals).toBeGreaterThanOrEqual(4);
    expect(used.size).toBeGreaterThanOrEqual(2);
    expect(line.revenueTotal).toBeGreaterThanOrEqual(0);
    // Обе станции посещены.
    expect([...used].some((k) => k.startsWith(`${a.id}:`))).toBe(true);
    expect([...used].some((k) => k.startsWith(`${b.id}:`))).toBe(true);
  });

  it('перенос: станция вдоль дороги встаёт вдоль дороги на новом месте, у станции с выездом длина выезда та же', () => {
    const { game, x, y } = scene(800);
    const side = terminal(game, x + 200, y + 40, { side: true });
    expect(game.moveStation(side.id, { x: x + 560, y: y - 40 }, 30)).toBeNull();
    const moved = game.stations.get(side.id)!;
    expect(moved.side).toBe(true);
    expect(moved.fp.center.y).toBeLessThan(y);
    expect(game.roads.net.node(moved.nodeId).corridors).toHaveLength(2);
    const end = terminal(game, x + 380, y + 40, { driveway: 30 });
    expect(game.moveStation(end.id, { x: x + 330, y: y + 40 }, 30)).toBeNull();
    expect(game.stations.get(end.id)!.driveway).toBe(30);
    expect(front(game.stations.get(end.id)!, y)).toBeCloseTo(8.5 + 30 + STATION.gate, 0);
  });

  it('у конца улицы — сдвигается от него, вплотную к другой станции — нельзя; снос оставляет улицу с дублёром; сохранение открывается', () => {
    const { game, x, y } = scene();
    // Курсор у самого конца улицы: площадка отъезжает вдоль неё ровно настолько, чтобы съезд уместился.
    const nearEnd = game.stationPlan({ x: x + 40, y: y + 40 }, 30, 'road', 0, 2, undefined, false, { side: true });
    expect(nearEnd.ok).toBe(true);
    expect(nearEnd.nodePos!.x).toBeCloseTo(x + pocketHalf, 0);
    const st = terminal(game, x + 300, y + 40, { side: true });
    expect(game.stationPlan({ x: x + 330, y: y + 40 }, 30, 'road', 0, 2, undefined, false, { side: true }).ok).toBe(false);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(loaded.stations.get(st.id)!.side).toBe(true);
    const length = [...game.roads.net.corridors.values()].reduce((s, c) => s + c.length, 0);
    const at = { ...game.roads.net.node(st.nodeId).pos };
    expect(game.removeStation(st)).toBe(true);
    const after = [...game.roads.net.corridors.values()].reduce((s, c) => s + c.length, 0);
    expect(after).toBeCloseTo(length, 0);
    // Дублёр остался дорогой: его снесёт игрок, если не нужен.
    expect(dist(game.roads.net.nodesNear(at, 3)[0]?.pos ?? { x: 0, y: 0 }, at)).toBeLessThan(1);
  });

  it('между перекрёстками: хватает длины — встаёт и у самого перекрёстка (сдвигается), мало — сколько нужно и сколько есть', () => {
    const { game, x, y } = scene();
    // Поперечные улицы: квартал x+100…x+200 (100 м — мало), дальше — x+200…x+600.
    for (const cx of [x + 100, x + 200]) expect(road(game, { free: { x: cx, y: y - 150 } }, { free: { x: cx, y: y + 150 } })).toBe(true);
    const short = game.stationPlan({ x: x + 150, y: y + 40 }, 30, 'road', 0, 2, undefined, false, { side: true });
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(new RegExp(`^Мало места вдоль улицы: нужно ${Math.ceil(2 * (pocket + crossClear))} м между перекрёстками, здесь (99|100) м$`));
    // Силуэт — под курсором, чтобы было видно, где не хватает места.
    expect(short.fp!.center.x).toBeCloseTo(x + 150, 0);
    // У перекрёстка x+200 длинного квартала: раньше — «Слишком близко к перекрёстку» где угодно.
    const near = game.stationPlan({ x: x + 230, y: y + 15 }, 30, 'road', 0, 2, undefined, false, { side: true });
    expect(near.ok).toBe(true);
    expect(near.nodePos!.x).toBeCloseTo(x + 200 + pocket + crossClear, 0);
    const st = terminal(game, x + 230, y + 15, { side: true });
    expect(game.roads.net.problems()).toEqual([]);
    // Съезд — с отступом от перекрёстка: кромки не сходятся.
    const ramps = [...game.roads.net.nodes.values()].filter((nd) => nd.kind === 'junction' && Math.abs(nd.pos.y - y) < 1 && nd.pos.x > x + 200 + 1);
    expect(ramps).toHaveLength(2);
    expect(Math.min(...ramps.map((nd) => nd.pos.x)) - (x + 200)).toBeCloseTo(crossClear, 0);
    expect(st.side).toBe(true);
  });

  it('стык посреди улицы (улица построена кусками) не мешает: карман ложится на оба куска', () => {
    const { game, x, y } = scene();
    // Отдельная улица из двух кусков по 70 м южнее: каждый короче кармана, вместе — длиннее.
    const y2 = y + 120;
    expect(road(game, { free: { x: x + 100, y: y2 } }, { free: { x: x + 170, y: y2 } })).toBe(true);
    expect(road(game, { x: x + 170, y: y2 }, { free: { x: x + 240, y: y2 } })).toBe(true);
    const net = game.roads.net;
    const seam = net.nodesNear({ x: x + 170, y: y2 }, 1)[0];
    expect(seam.kind).toBe('seam');
    expect(seam.corridors).toHaveLength(2);
    const plan = game.stationPlan({ x: x + 165, y: y2 + 40 }, 30, 'road', 0, 2, undefined, false, { side: true });
    expect(plan.ok).toBe(true);
    expect(plan.nodePos!.x).toBeCloseTo(x + 165, 0);
    const st = terminal(game, x + 165, y2 + 40, { side: true });
    expect(game.roads.net.node(st.nodeId).corridors).toHaveLength(2);
    expect(game.roads.net.problems()).toEqual([]);
  });
});

describe('Автовокзал вдоль дороги в городе (seed 309542331, как в отчёте)', () => {
  it('на улицах между перекрёстками, где хватает длины, встаёт; где мало — пишет, сколько нужно и сколько есть', () => {
    const game = withoutCitizens(new Game({ ...NEW_GAME_SETTINGS, seed: 309542331, scenario: { difficulty: 'normal', challenge: false } }));
    game.money = 1e9;
    const net = game.roads.net;
    const cam = { x: 4321, y: 4687 };
    let fit = 0;
    let placed = 0;
    let short = 0;
    for (const c of net.corridorsNear(cam, 600)) {
      if (c.cls !== 'street' || net.node(c.a).kind !== 'junction' || net.node(c.b).kind !== 'junction') continue;
      const s = c.length / 2;
      const t = c.lut.tangentAt(s);
      const pt = c.lut.pointAt(s);
      for (const side of [1, -1]) {
        const p = { x: pt.x - t.y * 20 * side, y: pt.y + t.x * 20 * side };
        const plan = game.stationPlan(p, 30, 'road', 0, 2, undefined, false, { side: true });
        const m = plan.reason?.match(/^Мало места вдоль улицы: нужно (\d+) м между перекрёстками, здесь (\d+) м$/);
        if (m) {
          short++;
          expect(Number(m[2])).toBe(Math.floor(c.length));
          expect(Number(m[2])).toBeLessThan(Number(m[1]));
          // Мало — только улицам заметно короче кармана; квартал сетки (115 м) — не «мало».
          expect(c.length).toBeLessThan(2 * pocketHalf + 10);
          continue;
        }
        expect(c.length).toBeGreaterThanOrEqual(2 * pocketHalf);
        fit++;
        if (plan.ok) placed++;
      }
    }
    expect(fit).toBeGreaterThan(10);
    expect(short).toBeGreaterThan(0);
    // Мешать могут дома, ратуша, соседняя улица — но не перекрёсток сам по себе.
    expect(placed / fit).toBeGreaterThan(0.8);
  });
});
