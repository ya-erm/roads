import { describe, expect, it } from 'vitest';
import { STATION } from '../config';
import { dist } from '../core/vec';
import { isBusTerminal, type Station } from '../world/entities';
import { TERRAIN_VERSION } from '../world/settings';
import { pointInFootprint } from '../world/spatial';
import { Game } from './game';
import { fieldSpot, roadPlan, STREET, withoutCitizens } from './testkit';
import { entryPose } from './transport';

/** Ровная карта без городов (их генератор тут не нужен) и улица с запада на восток в чистом поле. */
function scene() {
  const game = withoutCitizens(
    new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 50_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }),
  );
  game.modelTier = 3;
  const a = fieldSpot(game, 500);
  const plan = roadPlan(game, { free: a }, { free: { x: a.x + 500, y: a.y } }, STREET);
  if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(plan.reason ?? 'улица не построилась');
  return { game, x: a.x, y: a.y };
}

/** Автовокзал (только пассажиры) у улицы со стороны точки p. */
function terminal(game: Game, x: number, y: number): Station {
  const st = game.placeStation({ x, y }, 30, 'road', { pax: true, cargo: false });
  if (!st) throw new Error(game.stationPlan({ x, y }, 30, 'road').reason ?? 'не встал');
  return st;
}

describe('Автовокзал: перроны, ближе к дороге, въезд и выезд', () => {
  it('новый — шире прежнего (3 места с перронами), фасадом ближе к улице, чем со старым выездом в 34 м', () => {
    const { game, x, y } = scene();
    const st = terminal(game, x + 150, y + 40);
    expect(isBusTerminal(st)).toBe(true);
    expect(st.bays).toBe(STATION.bays);
    expect(st.fp.w).toBe(STATION.size.w);
    expect(st.fp.h).toBe(STATION.size.h);
    // Шаг мест — под автобус и перрон рядом.
    expect((st.fp.w - 10) / st.bays).toBeGreaterThan(10);
    // Сторона к выезду (ближняя к улице) — у узла станции, а он на STATION.driveway от кромки улицы.
    const front = st.fp.center.y - st.fp.h / 2;
    const node = game.roads.net.node(st.nodeId).pos;
    expect(front).toBeGreaterThan(node.y);
    // Между узлом и площадкой — место свернуть к своему посту.
    expect(front - node.y).toBeCloseTo(STATION.gate, 0);
    // Улица 1+1 — полуширина 8,5: со старым выездом фасад был бы в 8,5 + 34 + 4 = 46,5 от оси.
    expect(front - y).toBeCloseTo(8.5 + STATION.driveway + STATION.gate, 0);
    expect(front - y).toBeLessThan(40);
    // Грузовая автостанция — по-прежнему не автовокзал.
    const cargo = game.placeStation({ x: x + 380, y: y - 40 }, 30, 'road', { pax: false, cargo: true });
    expect(cargo && isBusTerminal(cargo)).toBe(false);
  });

  it('автобусы встают на разные перроны: каждый — на своё место, носом к зданию, целиком на площадке', () => {
    const { game, x, y } = scene();
    const south = terminal(game, x + 120, y + 40);
    const north = terminal(game, x + 380, y - 40);
    const line = game.createLine([south.id, north.id])!;
    expect(line).toBeTruthy();
    for (const model of ['bus', 'bus2', 'bus3', 'bus'] as const) expect(game.buyVehicle(line.id, model)).toBeTruthy();
    // Новые ждут на первой станции: трое — на трёх местах (четвёртому места нет), на рисунке — не друг на друге.
    const first = game.bayLooks(south);
    expect(first).toHaveLength(STATION.bays);
    for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) expect(dist(first[i].pos, first[j].pos)).toBeGreaterThan(8);
    const node = game.roads.net.node(south.nodeId).pos;
    for (const look of first) {
      // Нос — на площадке, автобус смотрит от выезда к зданию.
      expect(pointInFootprint(look.pos, south.fp, 0.5)).toBe(true);
      const toNode = { x: node.x - look.pos.x, y: node.y - look.pos.y };
      expect(look.dir.x * toNode.x + look.dir.y * toNode.y).toBeLessThan(0);
    }
    // В пути: подъехавший заезжает на свободное место — не на то, где уже стоит другой, — и встаёт там.
    game.speed = 1;
    const entering = new Set<number>();
    const used = new Set<string>();
    let arrivals = 0;
    for (let t = 0; t < 240; t += 0.1) {
      game.update(0.1);
      for (const v of game.fleet.values()) {
        if (!v.enter) {
          entering.delete(v.id);
          continue;
        }
        if (entering.has(v.id)) continue;
        entering.add(v.id);
        arrivals++;
        const st = game.stations.get(game.lines.get(v.lineId)!.stops[v.stop])!;
        const others = st.occupied.filter((id) => id !== v.id).map((id) => game.fleet.get(id)?.bay);
        expect(others).not.toContain(v.bay);
        expect(v.bay).toBeLessThan(st.bays);
        used.add(`${st.id}:${v.bay}`);
        // На рисунке станции заезжающий есть — он едет к своему месту.
        expect(game.bayLooks(st).length).toBeGreaterThan(0);
      }
    }
    expect(arrivals).toBeGreaterThanOrEqual(4);
    expect(used.size).toBeGreaterThanOrEqual(2);
  });

  it('заезд на место: последние метры — прямо, вдоль перронов; кривая до них — не короче 6 м', () => {
    const e = { pos: { x: 0, y: 0 }, dir: { x: 0, y: 1 }, v0: 4, t: 0 };
    const to = { pos: { x: 9, y: 30 }, dir: { x: 0, y: 1 } };
    const L = 14;
    let straightSeen = 0;
    for (let t = 0; t <= 6; t += 0.05) {
      const p = entryPose({ ...e, t }, to, L, 16);
      // Нос и кузов (до 0,7 длины позади) — на прямой к месту: машина там уже ровно.
      if (p.pos.y >= 30 - 16 + L * 0.7) {
        straightSeen++;
        expect(p.pos.x).toBeCloseTo(9, 5);
        expect(p.dir.x).toBeCloseTo(0, 5);
      }
      if (p.done) expect(dist(p.pos, to.pos)).toBeLessThan(1e-6);
    }
    expect(straightSeen).toBeGreaterThan(0);
    // До места близко — прямой участок короче, кривая — не меньше 6 м вперёд.
    const short = entryPose({ ...e, t: 0.3 }, { pos: { x: 9, y: 10 }, dir: { x: 0, y: 1 } }, L, 16);
    expect(short.pos.y).toBeLessThan(10);
    // Без прямого участка — как раньше: плавная кривая прямо к месту.
    expect(entryPose({ ...e, t: 100 }, to, L).pos).toEqual(to.pos);
  });

  it('старое сохранение: станция прежнего размера (36×22, выезд 34 м) открывается такой же, автобусы встают на её места', () => {
    const { game, x, y } = scene();
    const st = terminal(game, x + 120, y + 40);
    const other = terminal(game, x + 380, y - 40);
    const line = game.createLine([st.id, other.id])!;
    game.buyVehicle(line.id, 'bus');
    const save = JSON.parse(JSON.stringify(game.toSave()));
    // Как было до перронов: площадка 36×22.
    const saved = save.stations.find((s: { id: number }) => s.id === st.id);
    saved.fp.w = 36;
    saved.fp.h = 22;
    const loaded = withoutCitizens(new Game(save.settings, save));
    const old = loaded.stations.get(st.id)!;
    expect(old.fp.w).toBe(36);
    expect(old.fp.h).toBe(22);
    expect(isBusTerminal(old)).toBe(true);
    loaded.speed = 1;
    let looks: ReturnType<Game['bayLooks']> = [];
    for (let t = 0; t < 120 && !looks.length; t += 0.1) {
      loaded.update(0.1);
      looks = loaded.bayLooks(old);
    }
    expect(looks.length).toBeGreaterThan(0);
    for (const look of looks) expect(pointInFootprint(look.pos, old.fp, 12)).toBe(true);
  });
});
