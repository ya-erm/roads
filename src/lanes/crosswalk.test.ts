import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { RoadClass, WALK_EDGE } from '../world/roadTypes';
import { setWalk, syncWalks, walkArms, walkGeo, walksOn, walkTime, XWALK, XWALK_BACK } from './crosswalk';
import { splitCorridor } from './edit';
import { greenOf, LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';
import { LaneTraffic } from './traffic';

/** Перекрёсток на четыре стороны: подъезды по 200 м, классы — по сторонам (восток, юг, запад, север). */
function cross(cls: RoadClass[] = ['street', 'street', 'street', 'street'], len = 200) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  const dirs: Vec[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];
  const arms = dirs.map((d, i) => {
    const far = net.addSeam({ x: d.x * len, y: d.y * len }, d);
    const lanes = cls[i] === 'avenue' ? twoWay(2, 2) : twoWay(1, 1);
    return net.addCorridor(j.id, far.id, { cls: cls[i], lanes });
  });
  return { net, j, arms };
}

describe('Пешеходные переходы: где можно', () => {
  it('на улицах и проспектах можно, на магистрали и грунтовке — нет; у двух дорог — нет', () => {
    const { net, j } = cross(['street', 'avenue', 'highway', 'dirt']);
    const bans = walkArms(net, j).map((a) => a.ban);
    expect(bans).toEqual([null, null, 'class', 'class']);
    const two = new LaneNet();
    const k = two.addJunction({ x: 0, y: 0 });
    two.addCorridor(k.id, two.addSeam({ x: 200, y: 0 }, { x: 1, y: 0 }).id, { cls: 'street', lanes: twoWay(1, 1) });
    two.addCorridor(k.id, two.addSeam({ x: 0, y: 200 }, { x: 0, y: 1 }).id, { cls: 'street', lanes: twoWay(1, 1) });
    expect(walkArms(two, k).every((a) => a.ban === 'node')).toBe(true);
  });

  it('короткий подъезд (двум зебрам со стоп-линиями не поместиться) — нельзя', () => {
    const { net, j } = cross(undefined, 30);
    expect(walkArms(net, j).every((a) => a.ban === 'short')).toBe(true);
  });
});

describe('Пешеходные переходы: настройка', () => {
  it('«само» ставится только у подъездов без настройки; выбор игрока город не трогает; all — пересчёт «само»', () => {
    const { net, j, arms } = cross();
    expect(syncWalks(net, j, () => true)).toBe(true);
    expect(walksOn(net, j)).toHaveLength(4);
    // Игрок стёр переход на востоке — «само» его не вернёт ни сразу, ни при месячном пересчёте.
    setWalk(j, arms[0].id, false);
    expect(syncWalks(net, j, () => true, true)).toBe(false);
    expect(walksOn(net, j).map((a) => a.corridor.id)).not.toContain(arms[0].id);
    // Город «ушёл» (all): прежние «само» выключаются, выбор игрока — как был.
    expect(syncWalks(net, j, () => false, true)).toBe(true);
    expect(walksOn(net, j)).toHaveLength(0);
    expect(j.walks?.[String(arms[0].id)]).toEqual({ on: false, own: true });
  });

  it('объект настройки заменяется целиком: копия сети (для Ctrl+Z) остаётся прежней', () => {
    const { net, j, arms } = cross();
    syncWalks(net, j, () => true);
    const copy = net.clone();
    setWalk(j, arms[1].id, false);
    expect(copy.node(j.id).walks?.[String(arms[1].id)]?.on).toBe(true);
    expect(net.node(j.id).walks?.[String(arms[1].id)]?.on).toBe(false);
  });

  it('полотно разрезали стыком — настройка переходит на новое имя подъезда; убранный подъезд — прочь', () => {
    const { net, j, arms } = cross();
    syncWalks(net, j, () => true);
    setWalk(j, arms[0].id, false);
    splitCorridor(net, arms[0], 100, 'seam');
    const near = j.corridors.find((id) => !arms.some((a) => a.id === id))!;
    expect(j.walks?.[String(near)]).toEqual({ on: false, own: true });
    expect(j.walks?.[String(arms[0].id)]).toBeUndefined();
    net.removeCorridor(arms[1].id);
    expect(syncWalks(net, j, () => true)).toBe(true);
    expect(j.walks?.[String(arms[1].id)]).toBeUndefined();
  });

  it('сохранение несёт настройку как есть', () => {
    const { net, j, arms } = cross();
    syncWalks(net, j, () => true);
    setWalk(j, arms[2].id, false);
    const back = LaneNet.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(back.node(j.id).walks).toEqual(j.walks);
    expect(walksOn(back, back.node(j.id))).toHaveLength(3);
  });
});

describe('Пешеходные переходы: геометрия и граф', () => {
  it('зебра — за обрезом подъезда, по ширине проезжей части; стоп-линия дальше на XWALK_BACK', () => {
    const { net, j } = cross();
    syncWalks(net, j, () => true);
    const arm = walkArms(net, j)[0];
    const geo = walkGeo(arm);
    // Восточный подъезд: ось вдоль x, зебра — от обреза + 0,5 до + 5,5.
    const xs = geo.stripes.flatMap((q) => q.map((p) => p.x));
    expect(Math.min(...xs)).toBeCloseTo(arm.cut + XWALK.gap, 3);
    expect(Math.max(...xs)).toBeCloseTo(arm.cut + XWALK.gap + XWALK.depth, 3);
    // Улица 1+1: полосы 14 м, асфальт 17 м; зебра — от бордюра до бордюра (крайние полосы в 0,3 м от края), 7 полос.
    expect(geo.width).toBeCloseTo(17, 3);
    expect(geo.stripes.length).toBe(7);
    const ys = geo.stripes.flatMap((q) => q.map((p) => p.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(17 - 2 * XWALK.curbPad, 3);
    // Проспект с разделительной — тоже во всю ширину.
    const wide = cross(['avenue', 'avenue', 'avenue', 'avenue']);
    const av = walkGeo(walkArms(wide.net, wide.j)[0]);
    const ay = av.stripes.flatMap((q) => q.map((p) => p.y));
    expect(Math.max(...ay) - Math.min(...ay)).toBeCloseTo(av.width - 2 * XWALK.curbPad, 3);
    expect(geo.lanes).toBe(2);
    expect(walkTime(geo.width)).toBeCloseTo(17 / XWALK.speed + XWALK.start, 5);
    const g = new LaneGraph(net);
    const inLink = g.inLinks.get(j.id)!.find((l) => l.corridor === arm.corridor.id)!;
    for (const lane of inLink.lanes) expect(g.stopBack.get(lane.id)).toBe(XWALK_BACK);
    expect(g.crosswalks.get(j.id)).toHaveLength(4);
  });

  it('без переходов — стоп-линии на месте и графе переходов нет', () => {
    const { net, j } = cross();
    const g = new LaneGraph(net);
    expect(g.stopBack.size).toBe(0);
    expect(g.crosswalks.has(j.id)).toBe(false);
  });

  it('подземные переходы с обеих сторон дороги не отодвигают машины и не удлиняют фазы', () => {
    const { net, j, arms } = cross(['avenue', 'avenue', 'avenue', 'avenue']);
    j.control = 'lights';
    for (const c of arms) setWalk(j, c.id, true, true, true);
    const g = new LaneGraph(net, undefined, null, true);
    expect(g.stopBack.size).toBe(0);
    expect(g.holdBack.size).toBe(0);
    expect(g.nodes.get(j.id)!.lights!.phases.every((p) => p.walk === undefined)).toBe(true);
    const w = g.crosswalks.get(j.id)![0];
    for (const [side, portal] of w.geo.portals!.entries()) {
      for (const p of portal) expect(Math.abs(p.y) - w.geo.width / 2).toBeGreaterThanOrEqual(WALK_EDGE + 0.99);
      expect(Math.abs(w.geo.approaches![side].y) - w.geo.width / 2).toBeLessThan(WALK_EDGE);
      expect(w.geo.ends[side].y).toBeCloseTo((portal[1].y + portal[2].y) / 2);
    }
  });

  it('светофор: зелёный горит не короче перехода тех, кто идёт в эту фазу (проспект 2+2 — 9,7 с); настройка — как задана', () => {
    const { net, j } = cross(['avenue', 'avenue', 'avenue', 'avenue']);
    j.control = 'lights';
    const before = new LaneGraph(net).nodes.get(j.id)!.lights!.phases.map((p) => p.green);
    expect(Math.max(...before)).toBeLessThan(9);
    syncWalks(net, j, () => true);
    // Без пешеходов зелёный не удлиняется.
    expect(new LaneGraph(net).nodes.get(j.id)!.lights!.phases.map((p) => greenOf(p))).toEqual(before);
    // С пешеходами (своему графу, параметром) — не короче перехода.
    const lit = new LaneGraph(net, undefined, null, true).nodes.get(j.id)!.lights!;
    const need = walkTime(31);
    expect(need).toBeCloseTo(9.66, 1);
    for (const p of lit.phases) expect(greenOf(p)).toBeGreaterThanOrEqual(need - 1e-9);
    // Заданный зелёный (его берёт правка фаз и сохранение) — прежний; первый такт уже горит дольше.
    expect(lit.phases.map((p) => p.green)).toEqual(before);
    expect(lit.timer).toBeGreaterThanOrEqual(need - 1e-9);
    // Переходы стёрли — снова как было.
    for (const arm of walkArms(net, j)) setWalk(j, arm.corridor.id, false);
    expect(new LaneGraph(net, undefined, null, true).nodes.get(j.id)!.lights!.phases.map((p) => greenOf(p))).toEqual(before);
  });

  it('машина ждёт проезда у отодвинутой стоп-линии — перед зеброй, а не на ней', () => {
    const { net, j, arms } = cross();
    // Восток — главная, с юга едем налево и стоим: проезд уступаем потоку, которого нет, — проедем; поэтому — светофор.
    j.control = 'lights';
    syncWalks(net, j, () => true);
    const g = new LaneGraph(net);
    const traffic = new LaneTraffic(g, { onArrive: () => {}, onLost: () => {} });
    const south = net.node(arms[1].b);
    const north = net.node(arms[3].b);
    const L = g.nodes.get(j.id)!.lights!;
    // Держим красный тем, кто с юга: фаза, где у южного въезда зелёного нет.
    const inS = g.inLinks.get(j.id)!.find((l) => l.corridor === arms[1].id)!;
    const red = L.phases.findIndex((p) => ![...p.moves].some((k) => g.moves.get(k)?.inLink === inS.id));
    L.phase = red;
    const route = findLaneRoute(g, g.outLinks.get(south.id)!, north.id)!;
    const v = traffic.spawn({ kind: 'car', length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff', targetNode: north.id, route });
    expect(v).not.toBeNull();
    for (let t = 0; t < 20; t += 1 / 30) {
      L.timer = 100;
      traffic.step(1 / 30);
    }
    const lane = traffic.currentLane(v!)!;
    expect(lane.link).toBe(inS.id);
    expect(v!.v).toBeLessThan(0.1);
    expect(v!.s).toBeLessThanOrEqual(lane.length - XWALK_BACK + 0.1);
    expect(v!.s).toBeGreaterThan(lane.length - XWALK_BACK - 3);
  });
});
