import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { twoWay } from '../lanes/model';
import { Game } from './game';
import { adviceTip, markAt, stationWarnings, warningMarks } from './stationWarnings';
import { connectStations, fieldSpot, nearestPair, road, stationAtIndustry, withoutCitizens } from './testkit';
import { DEFAULT_RULE } from './transport';

/** Станция у добывающего предприятия, склад которой забит его продукцией. */
function fullStation() {
  const game = withoutCitizens(new Game(7));
  game.money = 5_000_000;
  // Ферма и ближайший к ней пищекомбинат; станция фермы — со стороны комбината (к нему потом ведёт шоссе).
  const { a: ind, b: to } = nearestPair(game, 'farm', 'foodplant');
  const st = stationAtIndustry(game, ind, to.fp.center)!;
  ind.producedLast = 40;
  st.cargo[ind.info.produces] = game.stationStorage(st);
  return { game, ind, st, to };
}

describe('Предупреждения станции', () => {
  it('склад полон, а маршрута отсюда нет: причина одной строкой, совет и действие «маршрут отсюда»', () => {
    const { game, st } = fullStation();
    const list = stationWarnings(game, st);
    expect(list).toHaveLength(1);
    const w = list[0];
    expect(w).toMatchObject({ key: `storage:${st.id}`, level: 'warn', title: 'Склад станции полон', fix: { kind: 'route', station: st.id } });
    expect(w.tip).toBe('Склад станции полон: отсюда не ходит ни один маршрут');
    expect(w.detail).toContain('Проведите маршрут к получателю');
  });

  it('значок на карте — тот же совет: наведение даёт причину, клик попадает в значок, а не мимо', () => {
    const { game, st } = fullStation();
    const z = 0.8;
    const marks = warningMarks(game, z);
    const m = marks.find((x) => x.station === st.id)!;
    expect(m).toMatchObject({ shape: 'dot', level: 'warn', tip: stationWarnings(game, st)[0].tip });
    // Правый верхний угол станции.
    expect(m.x).toBeGreaterThan(st.fp.center.x);
    expect(m.y).toBeLessThan(st.fp.center.y);
    expect(markAt(marks, { x: m.x + 5 / z, y: m.y - 5 / z }, z)).toBe(m);
    expect(markAt(marks, st.fp.center, z)).toBeNull();
  });

  it('маршрут с машинами отсюда есть — совет уже про склад и вывоз', () => {
    const { game, ind, st, to } = fullStation();
    const sB = stationAtIndustry(game, to, ind.fp.center)!;
    expect(connectStations(game, st, sB, { cls: 'highway', lanes: twoWay(1, 1) })).toBe(true);
    const line = game.createLine([st.id, sB.id])!;
    game.buyVehicle(line.id, 'truck');
    // Новая машина сразу взяла часть груза — склад снова забит.
    st.cargo[ind.info.produces] = game.stationStorage(st);
    const w = stationWarnings(game, st).find((x) => x.key === `storage:${st.id}`)!;
    expect(w.tip).toBe('Склад станции полон: продукцию некуда класть');
    expect(w.fix?.kind).not.toBe('route');
  });

  it('маршрут отсюда есть, но эту продукцию не берёт — так и сказано, действие — новый маршрут', () => {
    const { game, ind, st } = fullStation();
    // Ближайший завод, который эту продукцию не берёт и до которого можно провести шоссе.
    const others = game.industries
      .filter((i) => i !== ind && !i.info.accepts.includes(ind.info.produces) && i.info.accepts.length)
      .sort((x, y) => dist(x.fp.center, ind.fp.center) - dist(y.fp.center, ind.fp.center));
    let sB = null;
    for (const other of others.slice(0, 4)) {
      const s = stationAtIndustry(game, other, ind.fp.center);
      if (s && connectStations(game, st, s, { cls: 'highway', lanes: twoWay(1, 1) })) {
        sB = s;
        break;
      }
    }
    expect(sB).not.toBeNull();
    const line = game.createLine([st.id, sB!.id])!;
    game.buyVehicle(line.id, 'truck');
    st.cargo[ind.info.produces] = game.stationStorage(st);
    const w = stationWarnings(game, st).find((x) => x.key === `storage:${st.id}`)!;
    expect(w.tip).toMatch(/^Склад станции полон: «.+» отсюда никто не везёт$/);
    expect(w.detail).toContain('никто не принимает');
    expect(w.fix).toEqual({ kind: 'route', station: st.id });
  });

  it('всё в порядке — ни предупреждений, ни значков', () => {
    const { game, st } = fullStation();
    st.cargo = {};
    expect(stationWarnings(game, st)).toEqual([]);
    expect(warningMarks(game, 1).filter((m) => m.station === st.id)).toEqual([]);
  });

  it('у каждого вида совета — своя причина одной строкой', () => {
    const base = { key: 'k', level: 'warn' as const, detail: '«Ст»: что-то. Сделайте вот что.' };
    expect(adviceTip({ ...base, kind: 'waiting', title: 'Груз копится', cargo: 'oil', count: 200 })).toBe('Груз копится: ждут отправки 200 ед. «Нефть» — машин на маршруте мало');
    expect(adviceTip({ ...base, kind: 'queue', title: 'Очередь на въезд', count: 3 })).toBe('Очередь на въезд: 3 ждут свободный пост');
    expect(adviceTip({ ...base, kind: 'noRoute', title: 'Маршрут не работает', detail: '«Нефть — НПЗ»: Нет дороги: А → Б' })).toBe('Маршрут не работает: Нет дороги: А → Б');
    for (const t of [adviceTip({ ...base, kind: 'stuck', title: 'Машины не могут выехать', count: 2 }), adviceTip({ ...base, kind: 'wrongStop', title: 'Станция не работает с грузом' })]) {
      expect(t).not.toContain('\n');
      expect(t.length).toBeLessThan(80);
    }
  });
});

describe('«Нет мест» — тоже предупреждение станции', { timeout: 60_000 }, () => {
  it('плашка с числом ждущих слева от станции, в карточке — что сделать и «+1 пост»', () => {
    const game = withoutCitizens(new Game(42));
    game.money = 5_000_000;
    const a = fieldSpot(game, 500);
    expect(road(game, { free: a }, { free: { x: a.x + 500, y: a.y } })).toBe(true);
    const sA = game.placeStation({ x: a.x + 120, y: a.y - 30 }, 14)!;
    const sB = game.placeStation({ x: a.x + 380, y: a.y - 30 }, 14)!;
    const line = game.createLine([sA.id, sB.id])!;
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'full', maxWait: null });
    for (let i = 0; i < sB.bays + 2; i++) game.buyVehicle(line.id, 'bus');
    game.speed = 1;
    for (let t = 0; t < 240 && !game.stationJam(sB); t += 0.1) game.update(0.1);
    const jam = stationWarnings(game, sB).find((w) => !w.advice)!;
    expect(jam).toMatchObject({ key: `jam:${sB.id}`, title: 'Все посты заняты', count: 2, fix: { kind: 'bay', station: sB.id } });
    expect(jam.tip).toBe('Нет мест: все посты заняты, ждут въезда 2');
    const m = warningMarks(game, 1).find((x) => x.station === sB.id && x.shape === 'jam')!;
    expect(m.count).toBe(2);
    expect(m.x).toBeLessThan(sB.fp.center.x);
  });
});
