import { describe, expect, it } from 'vitest';
import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { boxesOverlap, CURB, stallBox, type Box, type CurbStall } from '../lanes/curb';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import { curbSqueeze, SQUEEZE } from '../world/curbSqueeze';
import type { TownBuilding, TownCar } from '../world/entities';
import { NEW_GAME_SETTINGS, type WorldSettings } from '../world/settings';
import type { Footprint } from '../world/spatial';
import { edgeOf, formOf } from '../world/townForms';
import { frontage, withCurb } from '../world/curbStreets';
import type { WorldContext } from '../world/worldgen';
import { CURB_TRIPS } from './curbParking';
import { Game, type SaveData } from './game';
import { runPose, type Run } from './lotMoves';
import { freshGame, runSeconds, runUntil, withoutCitizens } from './testkit';

/** Новая партия — с полосами стоянки (WorldSettings.parking). */
const PARK: WorldSettings = { ...NEW_GAME_SETTINGS, seed: 1, size: 'medium' };
const WORLD: [number, number, number, number] = [-1e6, -1e6, 1e6, 1e6];

/** Машины у целей на полосах стоянки (TownCar.curb) по всем городам. */
const atCurb = (g: Game): TownCar[] => g.towns.flatMap((t) => (t.cars ?? []).filter((c) => c.curb !== undefined));

/**
 * Места полосы стоянки, где стоят две машины и больше: гости у целей (TownCar.curb, не на манёвре) и машины дома на
 * своих местах ночёвки — место → кто.
 */
function doubled(g: Game): [string, string[]][] {
  const users = new Map<string, string[]>();
  const put = (key: string, who: string) => users.set(key, [...(users.get(key) ?? []), who]);
  for (const t of g.towns) {
    for (const e of t.cars ?? []) if (e.curb !== undefined && !g.carHomes.isMoving(e.car)) put(e.curb, `гость ${e.car}`);
    for (const c of g.carHomes.fleet(t).cars) if (c.place?.curb && g.carHomes.isHome(t, c.key)) put(c.place.curb.key, `дома ${c.key}`);
  }
  return [...users].filter(([, who]) => who.length > 1);
}

/** Кузов машины spec серединой в c, курсом d. */
const body = (spec: Pick<VehicleSpec, 'length' | 'width'>, c: Vec, d: Vec): Box => ({ c, d, hl: spec.length / 2, hw: spec.width / 2 });

type MoveView = {
  kind: 'in' | 'out';
  sim?: { id: number };
  run: { legs: { back: boolean }[]; i: number; v: number } | null;
  stall: { key: string; corridor: number; lane: number; s: number };
};

describe('Полосы стоянки в партии', { timeout: 240_000 }, () => {
  it('генерация: в центре — стоянки с обеих сторон напротив деловых домов, у рынка и ратуши; старая партия — без них', () => {
    const g = freshGame(PARK);
    const net = g.roads.net;
    const parked = [...net.corridors.values()].filter((c) => c.lanes.some((l) => l.park));
    expect(parked.length).toBeGreaterThan(20);
    expect(parked.every((c) => c.cls === 'street' || c.cls === 'avenue')).toBe(true);
    expect(net.problems()).toEqual([]);
    // В центре хоть одна улица — со стоянкой с обеих сторон.
    const both = parked.filter((c) => c.lanes.some((l) => l.park && l.offset > 0) && c.lanes.some((l) => l.park && l.offset < 0));
    expect(both.some((c) => g.towns.some((t) => edgeOf(t, c.lut.pointAt(c.length / 2)) < 0.35))).toBe(true);
    // У рынка — стоянка с его стороны.
    const market = g.towns.flatMap((t) => t.buildings).find((b) => formOf(b) === 'market');
    if (market) {
      const near = net.corridorNear(market.fp.center, 80);
      expect(near?.lanes.some((l) => l.park)).toBe(true);
    }
    // Места: тысячи, у каждого — полоса движения рядом; часть — места ночёвки.
    expect(g.curb.stalls().length).toBeGreaterThan(1000);
    const homes = g.towns.flatMap((t) => g.carHomes.fleet(t).cars).filter((c) => c.place?.kind === 'curb');
    expect(homes.length).toBeGreaterThan(100);
    for (const c of homes) expect(dist(c.place!.curb!.pos, c.home.fp.center)).toBeLessThanOrEqual(CURB_TRIPS.homeRange);
    // Без флага (старая партия) город стоянок не ставит.
    const old = new Game({ ...PARK, parking: undefined, seed: 2, size: 'small' });
    expect([...old.roads.net.corridors.values()].some((c) => c.lanes.some((l) => l.park))).toBe(false);
  });

  /**
   * Партия PARK с машинами жителей на две с половиной минуты — одна на оба теста ниже (та же свежая партия, считается
   * один раз, а не дважды): манёвры у бордюра за всё время и снимок через полторы минуты — сохранение и кто у бордюра.
   */
  type AtNinety = { before: (string | number | undefined)[][]; save: SaveData; settings: WorldSettings };
  let run:
    | { g: Game; started: Map<MoveView, number>; fwdStart: number[]; inFlow: { fwd: number; rev: number }; crowded: number; left: number; at90: AtNinety; stacked: Set<string> }
    | undefined;
  const cityRun = () => {
    if (run) return run;
    const g = freshGame(PARK);
    const moves = (g.curb as unknown as { moves: MoveView[] }).moves;
    const started = new Map<MoveView, number>();
    const fwdStart: number[] = [];
    const inFlow = { fwd: 0, rev: 0 };
    let crowded = 0;
    const seen = new Set<number>();
    let left = 0;
    let elapsed = 0;
    let at90: AtNinety | undefined;
    const stacked = new Set<string>();
    runSeconds(g, 150, () => {
      for (const m of moves) {
        if (m.kind !== 'in') continue;
        if (!started.has(m)) {
          started.set(m, g.time);
          // Передом — с ходу (скорость в начале манёвра; встала за впереди стоящей — с места).
          if (m.run && !m.run.legs[0].back) fwdStart.push(m.run.v);
        }
        if (m.sim) {
          const t = g.time - started.get(m)!;
          if (m.run?.legs[m.run.i].back) inFlow.rev = Math.max(inFlow.rev, t);
          else inFlow.fwd = Math.max(inFlow.fwd, t);
        }
      }
      // Манёвр на полосе — пока машина в потоке (ждущие просвета у бордюра — ещё нет).
      const active = moves.filter((m) => m.sim);
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i].stall;
          const b = active[j].stall;
          if (a.corridor === b.corridor && a.lane === b.lane && Math.abs(a.s - b.s) < CURB_TRIPS.apart) crowded++;
        }
      }
      const now = new Set(atCurb(g).map((c) => c.car));
      for (const k of seen) if (!now.has(k)) left++;
      for (const k of now) seen.add(k);
      for (const k of [...seen]) if (!now.has(k)) seen.delete(k);
      elapsed += 0.1;
      // Раз в секунду: на одном месте — не больше одной стоящей машины.
      if (Math.round(elapsed * 10) % 10 === 0) for (const [k, who] of doubled(g)) stacked.add(`${k}: ${who.join(', ')}`);
      if (!at90 && elapsed >= 90) {
        at90 = {
          before: atCurb(g).map((c) => [c.car, c.curb]),
          save: JSON.parse(JSON.stringify(g.toSave())) as SaveData,
          settings: structuredClone(g.settings),
        };
      }
    });
    run = { g, started, fwdStart, inFlow, crowded, left, at90: at90!, stacked };
    return run;
  };

  it('машина встаёт у цели на место и потом уезжает с него; манёвр держит полосу недолго, на полосе — не больше одного на 30 ед.', () => {
    const { g, started, fwdStart, inFlow, crowded, left, stacked } = cityRun();
    expect(started.size).toBeGreaterThan(50);
    // Передом встают с ходу: почти все начинают манёвр на скорости, а не с места.
    expect(fwdStart.length).toBeGreaterThan(10);
    expect(fwdStart.filter((v) => v > 2.5).length).toBeGreaterThan(0.8 * fwdStart.length);
    // Две машины на одном месте не стояли ни разу.
    expect([...stacked]).toEqual([]);
    expect(atCurb(g).length).toBeGreaterThan(30);
    // Отстоявшие у цели уезжают с места.
    expect(left).toBeGreaterThan(5);
    // Передом — ~2 с в потоке, задом — ~6 с.
    expect(inFlow.fwd).toBeGreaterThan(0);
    expect(inFlow.fwd).toBeLessThan(3.5);
    expect(inFlow.rev).toBeLessThan(9);
    expect(crowded).toBe(0);
    // Машины у целей видны на своих местах (вблизи).
    const looks = g.garageLooks(WORLD, true);
    const one = atCurb(g)[0];
    const st = g.curb.stall(one.curb!)!;
    expect(looks.some((l) => dist(l.look.pos, st.pos) < CURB.stallLen)).toBe(true);
  });

  it('сохранение: машины у целей — на тех же местах; после правки сети место ищется по положению (3 ед.)', () => {
    // Партия через полторы минуты (cityRun): сохранение и кто тогда стоял у бордюра.
    const { before, save, settings } = cityRun().at90;
    expect(before.length).toBeGreaterThan(10);
    const h = new Game(structuredClone(settings), structuredClone(save));
    expect(atCurb(h).map((c) => [c.car, c.curb])).toEqual(before);
    expect(h.curb.isTaken(before[0][1] as string)).toBe(true);
    runSeconds(h, 1);
    // Ключ места сменился (сеть поправили), положение то же — место находится; положение далеко — машина без места.
    const [a, b] = atCurb(h);
    a.curb = '999999:R:0';
    b.cp = [b.cp![0] + 50, b.cp![1]];
    b.curb = '999999:R:1';
    h.towns.forEach((t) => (t.cars = t.cars && [...t.cars]));
    runSeconds(h, 0.2);
    expect(a.curb).not.toBe('999999:R:0');
    expect(h.curb.stall(a.curb!)).toBeDefined();
    expect(b.curb).toBeUndefined();
  });

  it('старое сохранение (до полос стоянки) открывается: стоянок и машин у бордюра нет, поездки идут', () => {
    const g = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    runSeconds(g, 20);
    const save = JSON.parse(JSON.stringify(g.toSave())) as SaveData;
    for (const t of save.towns) for (const c of t.cars ?? []) delete c.curb;
    const h = new Game(structuredClone(g.settings), save);
    expect(h.curb.stalls()).toHaveLength(0);
    runSeconds(h, 10);
    expect(h.citizenCars).toBeGreaterThan(20);
  });

  it('стоянка на застроенной улице: участки ужимаются (задняя граница — не дальше 6 м), иначе — снос с ценой', () => {
    const g = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const net = g.roads.net;
    // Улица города с домами вплотную с правой стороны.
    let found: { id: number; side: 1 | -1 } | null = null;
    for (const t of g.towns) {
      for (const id of t.streets) {
        const c = net.corridors.get(id);
        if (!c) continue;
        for (const side of [1, -1] as const) {
          const lanes = withCurb(net, c, side);
          if (!lanes) continue;
          const plan = g.roadBuilder.plan((n) => n.setLanes(n.corridor(id), lanes), { shove: true });
          if (plan.ok && plan.squeeze?.length && !plan.demolish.length) found ??= { id, side };
        }
      }
    }
    expect(found).not.toBeNull();
    const { id, side } = found!;
    const lanes = withCurb(net, net.corridor(id), side)!;
    const plan = g.roadBuilder.plan((n) => n.setLanes(n.corridor(id), lanes), { shove: true });
    const squeezed = plan.squeeze!;
    // Цена — 0,8 полосы улицы на её длине.
    const plain = g.roadBuilder.plan((n) => n.setLanes(n.corridor(id), lanes.map(({ park: _p, ...l }) => l)), { shove: true });
    expect(plan.cost / plain.cost).toBeGreaterThan(0.7);
    expect(plan.cost / plain.cost).toBeLessThan(0.9);
    // Какие дома ужмутся и куда от улицы у каждого «вглубь».
    const ctx = { ...(g as unknown as { worldContext(): WorldContext }).worldContext(), roads: plan.net! };
    const c1 = plan.net!.corridor(id);
    const list = curbSqueeze(ctx, c1, frontage(g.towns.find((t) => t.streets.includes(id))!, c1).get(side)!).filter((x) => x.fp);
    expect(list).toHaveLength(squeezed.length);
    const away = (b: TownBuilding) => {
      const hit = c1.lut.closest(b.fp.center);
      return scale(rightNormal(c1.lut.tangentAt(hit.s)), side);
    };
    const depthOf = (fp: Footprint, dir: Vec) => {
      const ux = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
      return Math.abs(dot(dir, { x: -ux.y, y: ux.x })) >= Math.abs(dot(dir, ux)) ? fp.h : fp.w;
    };
    // Мелкий участок (глубиной 8 ед. при том же фасаде) не ужать — под снос, и снос в цене.
    const victim = list[0].b;
    const keep = { ...victim.fp };
    const dir = away(victim);
    const d0 = depthOf(keep, dir);
    const ux = { x: Math.cos(keep.angle), y: Math.sin(keep.angle) };
    const alongH = Math.abs(dot(dir, { x: -ux.y, y: ux.x })) >= Math.abs(dot(dir, ux));
    g.index.remove(victim);
    victim.fp = { ...keep, center: sub(keep.center, scale(dir, (d0 - 8) / 2)), ...(alongH ? { h: 8 } : { w: 8 }) };
    g.index.add(victim);
    const razed = g.roadBuilder.plan((n) => n.setLanes(n.corridor(id), lanes), { shove: true });
    expect(razed.demolish).toContain(victim.id);
    expect(razed.cost).toBeGreaterThan(plan.cost);
    g.index.remove(victim);
    victim.fp = keep;
    g.index.add(victim);
    // Строим: участки ужались — задняя граница вглубь не дальше 10 ед. (6 м), фасад — за новой кромкой.
    const rear = new Map(list.map((x) => [x.b.id, add(x.b.fp.center, scale(away(x.b), depthOf(x.b.fp, away(x.b)) / 2))]));
    g.roadBuilder.apply(plan);
    g.applyCurbSqueeze(plan.changed);
    for (const x of list) {
      const dirB = away(x.b);
      const now = add(x.b.fp.center, scale(dirB, depthOf(x.b.fp, dirB) / 2));
      expect(dot(sub(now, rear.get(x.b.id)!), dirB)).toBeLessThanOrEqual(SQUEEZE.back + 0.01);
      expect(depthOf(x.b.fp, dirB)).toBeGreaterThanOrEqual(SQUEEZE.minDepth - 0.01);
    }
  });
});

describe('Одно место — одна машина', { timeout: 120_000 }, () => {
  type CurbView = {
    host: { car: VehicleSpec };
    moves: { kind: 'in' | 'out'; stall: CurbStall; run: Run | null }[];
    homing: Map<number, { stall?: CurbStall }>;
  };

  it('кузова на соседних местах не пересекаются', () => {
    const g = freshGame(PARK);
    const spec = (g.curb as unknown as CurbView).host.car;
    const byLane = new Map<string, CurbStall[]>();
    for (const st of g.curb.stalls()) byLane.set(`${st.corridor}:${st.lane}`, [...(byLane.get(`${st.corridor}:${st.lane}`) ?? []), st]);
    let pairs = 0;
    for (const list of byLane.values()) {
      const at = new Map(list.map((st) => [st.idx, st]));
      for (const st of list) {
        const next = at.get(st.idx + 1);
        // Машина на месте — в его габарите.
        expect(boxesOverlap(stallBox(st), body(spec, st.pos, st.dir))).toBe(true);
        if (!next) continue;
        pairs++;
        expect(boxesOverlap(body(spec, st.pos, st.dir), body(spec, next.pos, next.dir))).toBe(false);
      }
    }
    expect(pairs).toBeGreaterThan(500);
  });

  it('одна выезжает, другая хочет на это место: вторая не встаёт, пока кузов первой в габарите места; бронь у места одна', () => {
    const g = withoutCitizens(freshGame(PARK));
    const curb = g.curb;
    const view = curb as unknown as CurbView;
    const spec = view.host.car;
    // Ничьё место посреди длинной связи: есть где подъехать сзади и где встать задом.
    const st = curb.stalls().find((s) => {
      const slot = curb.slotOf(s);
      return curb.isFree(s.key) && !!slot && slot.u > 80 && slot.u + 80 < slot.lane.length;
    })!;
    const slot = curb.slotOf(st)!;
    const b = g.towns[0].buildings[0];
    // Первая (гость −7) стоит на месте и выезжает: место её, пока она стоит, потом — бронь выезда.
    curb.park(st.key, -7);
    let first: Vehicle | null = null;
    const opt = { color: '#8b5a2b', hooks: { joined: (sim: Vehicle) => ((first = sim), curb.unpark(st.key, -7)) } };
    expect(curb.leave(st, slot.link.toNode!, { from: b, to: b }, opt)).toBe(true);
    // Второй выезд с того же места — нельзя: бронь у места одна.
    expect(curb.leave(st, slot.link.toNode!, { from: b, to: b }, { color: '#000000' })).toBe(false);
    expect(runUntil(g, 20, () => !!first)).toBe(true);
    // Вторая подъезжает сзади, пока первая выезжает, и хочет именно на это место.
    const second = g.roads.traffic.placeOnLane({ ...spec, color: '#3a7d44', targetNode: slot.link.toNode!, endLink: slot.link.id }, slot.lane.id, slot.u - 30)!;
    expect(second).not.toBeNull();
    let arrived = false;
    let missed = false;
    curb.toCurb(second, slot.link.id, () => [st], { arrived: () => (arrived = true), missed: () => (missed = true) });
    const box = stallBox(st);
    let waited = 0;
    let bad = 0;
    runUntil(
      g,
      40,
      () => arrived || missed,
      () => {
        const out = view.moves.find((m) => m.kind === 'out' && m.stall.key === st.key);
        const pose = out?.run ? runPose(out.run) : null;
        const inside = !!out && (!pose || boxesOverlap(box, body(spec, pose.c, pose.h)));
        if (!inside) return;
        // Кузов первой ещё в габарите места: бронь — её выезда, второй ни брони, ни манёвра на это место.
        const wants = view.moves.some((m) => m.kind === 'in' && m.stall.key === st.key) || [...view.homing.values()].some((h) => h.stall?.key === st.key);
        if (curb.holder(st.key)?.kind !== 'out' || wants) bad++;
        if (curb.isHoming(second.id)) waited++;
      },
    );
    expect(bad).toBe(0);
    expect(waited).toBeGreaterThan(0);
    // Первая уехала — вторая встала на освободившееся место.
    expect(arrived).toBe(true);
    expect(curb.holder(st.key)).toBeNull();
  });

  it('место, где стоит гость, не становится местом ночёвки; после загрузки — так же', () => {
    const g = freshGame(PARK);
    expect(runUntil(g, 60, () => atCurb(g).some((e) => !g.carHomes.isMoving(e.car)))).toBe(true);
    // Машина дома на своём месте у бордюра — и гость у цели.
    const town = g.towns.find((t) => g.carHomes.fleet(t).cars.some((c) => c.place?.curb && g.carHomes.isHome(t, c.key)))!;
    const owner = g.carHomes.fleet(town).cars.find((c) => c.place?.curb && g.carHomes.isHome(town, c.key))!;
    const st = owner.place!.curb!;
    const guest = atCurb(g).find((e) => !g.carHomes.isMoving(e.car))!;
    // Гость встал на место, пока оно было ничьим (город с тех пор вырос — места ночёвки назначаются заново).
    g.curb.unpark(guest.curb!, guest.car);
    guest.curb = st.key;
    guest.cp = [st.pos.x, st.pos.y];
    g.towns.forEach((t) => (t.cars = t.cars && [...t.cars]));
    town.buildings = [...town.buildings];
    const fleet = g.carHomes.fleet(town);
    // Хозяину — другое место: гость остался на своём, вдвоём на одном не стоят.
    expect(fleet.byKey.get(owner.key)!.place?.curb?.key).not.toBe(st.key);
    expect(g.curb.isAssigned(st.key)).toBe(false);
    expect(doubled(g)).toEqual([]);
    runSeconds(g, 5);
    expect(doubled(g)).toEqual([]);
    const h = new Game(structuredClone(g.settings), JSON.parse(JSON.stringify(g.toSave())) as SaveData);
    expect(doubled(h)).toEqual([]);
    runSeconds(h, 5);
    expect(doubled(h)).toEqual([]);
  });
});
