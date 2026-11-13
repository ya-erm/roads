import { describe, expect, it } from 'vitest';
import { MIN_SEGMENT_LEN, STATION } from '../config';
import { dist } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { NEW_GAME_SETTINGS, TERRAIN_VERSION } from '../world/settings';
import { pointInFootprint } from '../world/spatial';
import type { Station } from '../world/entities';
import { CURB_GAP } from '../lanes/traffic';
import { clampDriveway, curbLayout, curbNeed, Game, type RoadStationOptions } from './game';
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

describe('Автовокзал у края улицы (с кармашком или без)', () => {
  const CURB = { curb: true } as const;
  /** Полоса кармашка на полотне: та, что дальше всех от оси с этой стороны и не на всю длину. */
  const pocketLanes = (game: Game, y: number) =>
    [...game.roads.net.corridors.values()]
      .filter((c) => Math.abs(c.curve.p0.y - y) < 1 && Math.abs(c.curve.p3.y - y) < 1)
      .flatMap((c) => c.lanes.filter((l) => Math.abs(l.offset) > LANE_W).map((l) => ({ c, l })));

  it('на длинной улице — с кармашком: перрон вплотную к его бордюру, узел — стык на улице с подъездом только по своей половине', () => {
    const { game, x, y } = scene();
    const st = terminal(game, x + 300, y + 20, CURB);
    expect(st.curb).toEqual({ pocket: true });
    expect(st.bays).toBe(STATION.curb.bays);
    const net = game.roads.net;
    const node = net.node(st.nodeId);
    expect(node.kind).toBe('seam');
    expect(node.corridors).toHaveLength(2);
    // Южный край — по ходу a→b (на восток): подъезжают только с запада.
    expect(node.arrive! * node.dir.x).toBeGreaterThan(0);
    // Площадка — вплотную к бордюру кармашка: полоса улицы и полоса кармашка.
    expect(front(st, y)).toBeCloseTo(2 * LANE_W + ROAD_MARGIN, 1);
    // Кармашек — полоса у южного края в ту же сторону, по обе стороны от узла (стык режет её на полной ширине).
    const lanes = pocketLanes(game, y);
    expect(lanes).toHaveLength(2);
    for (const { l } of lanes) expect(l.flow).toBe(1);
    const T = 25;
    const lay = curbLayout(STATION.curb.bays, T, true);
    const full = lanes.reduce((s, { c, l }) => s + Math.min(l.to, c.length) - l.from, 0);
    expect(full).toBeCloseTo(lay.zone, 0);
    // Места — вдоль всей площадки (без концов): два городских автобуса.
    expect(lay.stand).toBeGreaterThanOrEqual(2 * 14 + 2);
    expect(net.problems()).toEqual([]);
    // Сохранение открывается: станция и подъезд с одной стороны — те же.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(loaded.stations.get(st.id)!.curb).toEqual({ pocket: true });
    expect(loaded.roads.net.node(st.nodeId).arrive).toBe(node.arrive);
    // Снос — улица с кармашком остаётся (обычная дорога).
    const length = [...net.corridors.values()].reduce((s, c) => s + c.length, 0);
    expect(game.removeStation(st)).toBe(true);
    expect([...game.roads.net.corridors.values()].reduce((s, c) => s + c.length, 0)).toBeCloseTo(length, 0);
    expect(pocketLanes(game, y)).toHaveLength(2);
  });

  it('квартал 75–90 м: без кармашка — места в крайней полосе; кармашку на 2 места — от ~92 м, на одно хватает и 85; короче — сколько нужно', () => {
    expect(curbNeed(2, false)).toBeLessThanOrEqual(75);
    expect(curbNeed(2, true)).toBeLessThanOrEqual(95);
    expect(curbNeed(1, true)).toBeLessThanOrEqual(85);
    const { game, x, y } = scene(700);
    // Кварталы: x+100…x+185 (85 м) и x+185…x+245 (60 м); дальше — длинная улица.
    for (const cx of [x + 100, x + 185, x + 245]) expect(road(game, { free: { x: cx, y: y - 120 } }, { free: { x: cx, y: y + 120 } })).toBe(true);
    const plain = game.stationPlan({ x: x + 142, y: y + 20 }, 30, 'road', 0, 2, undefined, false, CURB);
    expect(plain.ok).toBe(true);
    expect(plain.curb).toMatchObject({ bays: 2, pocket: false });
    expect(plain.curb!.have).toBeGreaterThanOrEqual(84);
    expect(plain.curb!.need).toBeGreaterThan(plain.curb!.have);
    const one = game.stationPlan({ x: x + 142, y: y + 20 }, 30, 'road', 0, 2, undefined, false, { curb: true, curbBays: 1 });
    expect(one.ok).toBe(true);
    expect(one.curb).toMatchObject({ bays: 1, pocket: true });
    const short = game.stationPlan({ x: x + 215, y: y + 20 }, 30, 'road', 0, 2, undefined, false, CURB);
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(/^Мало места вдоль улицы: нужно \d+ м между перекрёстками, здесь (59|60) м$/);
    // Без кармашка перрон — у бордюра самой улицы; курсор у перекрёстка — площадка отходит от него вдоль улицы.
    const st = terminal(game, x + 125, y + 14, CURB);
    expect(st.curb).toEqual({ pocket: false });
    expect(front(st, y)).toBeCloseTo(LANE_W + ROAD_MARGIN, 1);
    expect(st.fp.center.x - st.fp.w / 2).toBeGreaterThan(x + 100 + LANE_W + ROAD_MARGIN);
    expect(st.fp.center.x + st.fp.w / 2).toBeLessThan(x + 185 - LANE_W - ROAD_MARGIN);
    expect(pocketLanes(game, y)).toHaveLength(0);
    expect(game.roads.net.problems()).toEqual([]);
    // Вплотную к другой станции — нельзя.
    expect(game.stationPlan({ x: x + 150, y: y + 20 }, 30, 'road', 0, 2, undefined, false, CURB).reason).toBe('Рядом уже есть станция');
  });

  it('в городе (seed 309542331): встаёт и в кварталах 75–90 м, где дублёру мало места; на длинных — с кармашком', () => {
    const game = withoutCitizens(new Game({ ...NEW_GAME_SETTINGS, seed: 309542331, scenario: { difficulty: 'normal', challenge: false } }));
    game.money = 1e9;
    const net = game.roads.net;
    const tally = { short: 0, shortOk: 0, long: 0, pocket: 0, reasons: new Map<string, number>() };
    for (const c of net.corridors.values()) {
      if (c.cls !== 'street' || net.node(c.a).kind !== 'junction' || net.node(c.b).kind !== 'junction' || c.length < 75) continue;
      const pt = c.lut.pointAt(c.length / 2);
      const t = c.lut.tangentAt(c.length / 2);
      for (const side of [1, -1]) {
        const plan = game.stationPlan({ x: pt.x - t.y * 18 * side, y: pt.y + t.x * 18 * side }, 30, 'road', 0, 2, undefined, false, CURB);
        if (c.length <= 90) {
          tally.short++;
          if (plan.ok) tally.shortOk++;
          // Дублёру здесь мало места — а у края улицы встаёт без кармашка.
          expect(game.stationPlan({ x: pt.x - t.y * 18 * side, y: pt.y + t.x * 18 * side }, 30, 'road', 0, 2, undefined, false, { side: true }).ok).toBe(false);
        } else if (c.length >= 110) {
          tally.long++;
          if (plan.ok && plan.curb?.pocket) tally.pocket++;
        }
        if (!plan.ok) tally.reasons.set(plan.reason ?? '', (tally.reasons.get(plan.reason ?? '') ?? 0) + 1);
      }
    }
    expect(tally.short, [...tally.reasons].join('; ')).toBeGreaterThan(4);
    // Мешать могут дома-ориентиры, соседняя улица, другая станция — но не длина квартала.
    expect(tally.shortOk / tally.short, [...tally.reasons].join('; ')).toBeGreaterThan(0.7);
    expect(tally.pocket / tally.long, [...tally.reasons].join('; ')).toBeGreaterThan(0.7);
  });

  it('задний автобус погрузился раньше переднего — объезжает его и уезжает, не дожидаясь', () => {
    const { game, x, y } = scene(700);
    const a = terminal(game, x + 300, y + 20, CURB);
    const b = terminal(game, x + 550, y - 20, CURB);
    const line = game.createLine([a.id, b.id])!;
    for (let i = 0; i < 5; i++) expect(game.buyVehicle(line.id, 'bus2')).toBeTruthy();
    game.speed = 1;
    // Передний у перрона a «грузится» 40 с: остальные — за ним, и уезжают раньше.
    const g = game as unknown as { loadingDone(v: { id: number }, l: unknown, dt: number): boolean };
    const done = g.loadingDone.bind(game);
    let held: number | null = null;
    let now = 0;
    let until = Infinity;
    g.loadingDone = (v, l, dt) => (v.id === held && now < until ? false : done(v, l, dt));
    const passed = new Set<number>();
    for (; now < 300; now += 0.1) {
      game.update(0.1);
      const at = [...game.fleet.values()].filter((v) => line.stops[v.stop] === a.id && (v.state === 'loading' || v.boarding) && game.fleetSim(v));
      if (held === null && at.length === 2) {
        held = at.reduce((p, q) => (game.fleetSim(p)!.pos.x > game.fleetSim(q)!.pos.x ? p : q)).id;
        until = now + 40;
      }
      if (held === null || now > until) continue;
      // Уехавшие от a, пока передний стоит, — проехали мимо него.
      const front = game.fleetSim(game.fleet.get(held)!)!.pos.x;
      for (const v of game.fleet.values()) {
        const sim = game.fleetSim(v);
        if (v.id !== held && sim && line.stops[v.stop] === b.id && sim.pos.x > front + 5 && sim.pos.y > y) passed.add(v.id);
      }
    }
    expect(held).not.toBeNull();
    expect(passed.size).toBeGreaterThanOrEqual(2);
  });

  it('автобусы встают у перрона друг за другом у бордюра, носом по ходу; мест не больше, чем у вокзала', () => {
    const { game, x, y } = scene(700);
    // Восточная половина — с кармашком (на восток, у южного края), западная — квартал 85 м без него (на запад).
    for (const cx of [x + 100, x + 185]) expect(road(game, { free: { x: cx, y: y - 120 } }, { free: { x: cx, y: y + 120 } })).toBe(true);
    const a = terminal(game, x + 400, y + 20, CURB);
    const b = terminal(game, x + 142, y - 20, CURB);
    expect(a.curb!.pocket).toBe(true);
    expect(b.curb!.pocket).toBe(false);
    const line = game.createLine([a.id, b.id])!;
    for (const m of ['bus2', 'bus2', 'bus2', 'bus'] as const) expect(game.buyVehicle(line.id, m)).toBeTruthy();
    game.speed = 1;
    let most = 0;
    let stood = 0;
    let tight = 0;
    for (let t = 0; t < 400; t += 0.1) {
      game.update(0.1);
      for (const st of [a, b]) {
        const at = [...game.fleet.values()].filter((v) => line.stops[v.stop] === st.id && v.state === 'loading' && game.fleetSim(v));
        expect(at.length).toBeLessThanOrEqual(st.bays);
        most = Math.max(most, at.length);
        const flow = st === a ? 1 : -1;
        for (const v of at) {
          const sim = game.fleetSim(v)!;
          stood++;
          // У перрона: носом по ходу своей половины улицы, вдоль площадки, у бордюра с зазором CURB_GAP.
          expect(sim.dir.x * flow).toBeGreaterThan(0.99);
          expect(Math.abs(sim.pos.x - st.fp.center.x)).toBeLessThan(st.fp.w / 2 + 2);
          // Задний с кармашком может стоять кормой на половине отгона — там бордюр ближе к оси, а он чуть дальше от перрона.
          const curb = Math.abs(st.fp.center.y - y) - st.fp.h / 2;
          const gap = curb - Math.abs(sim.pos.y - y) - sim.width / 2;
          expect(gap).toBeGreaterThan(CURB_GAP - 0.1);
          expect(gap).toBeLessThan(2.5);
          if (Math.abs(gap - CURB_GAP) < 0.05) tight++;
        }
      }
    }
    expect(stood).toBeGreaterThan(0);
    expect(tight / stood).toBeGreaterThan(0.5);
    expect(most).toBe(2);
    expect(line.problem).toBeNull();
    expect(line.lap).toBeGreaterThan(0);
  });
});
