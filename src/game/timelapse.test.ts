import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { Game, type SaveData } from './game';
import type { JournalEntry } from './journal';
import { anchorOf, fieldSpot, freightRoute, freshGame, runMonths, STREET, withoutCitizens } from './testkit';
import {
  buildTimeline,
  curveRec,
  journalFrames,
  mergeFrames,
  recCurve,
  TimelapseRecorder,
  timelapseOf,
  TL_CHARS,
  TL_FRAMES,
  TL_LAYERS,
  TL_STEP,
  tlLayers,
  type TimelapseFrame,
  type TlLayer,
} from './timelapse';

/** Состояние сети после всех кадров: слой → id → запись строкой. */
function replay(frames: TimelapseFrame[]): Record<TlLayer, Map<number, string>> {
  const state = tlLayers(() => new Map<number, string>());
  for (const f of frames) {
    for (const L of TL_LAYERS) {
      if (f.full) state[L].clear();
      for (const id of f[`${L}d` as const] ?? []) state[L].delete(id);
      for (const rec of f[L] ?? []) state[L].set(rec[0] as number, JSON.stringify(rec));
    }
  }
  return state;
}

/** Что видно на последнем кадре раскладки: слой → id. */
function aliveAtEnd(frames: TimelapseFrame[]): Record<TlLayer, number[]> {
  const tl = buildTimeline(frames);
  const out = {} as Record<TlLayer, number[]>;
  for (const L of TL_LAYERS) out[L] = tl.layers[L].filter((i) => i.to > frames.length - 1).map((i) => i.id).sort((a, b) => a - b);
  return out;
}

/** Сохранение через JSON — как в localStorage. */
const roundTrip = (game: Game): SaveData => JSON.parse(JSON.stringify(game.toSave())) as SaveData;

describe('Таймлапс партии: запись кадров', { timeout: 120_000 }, () => {
  it('кривая пишется с точностью до шага округления, почти прямая — двумя точками', () => {
    const curve = { p0: { x: 101.3, y: 2003.9 }, p1: { x: 300, y: 2100 }, p2: { x: 500, y: 1900 }, p3: { x: 703.2, y: 2001 } };
    const rec = curveRec(5, 2, curve);
    expect(rec).toHaveLength(10);
    const back = recCurve(rec);
    for (const k of ['p0', 'p1', 'p2', 'p3'] as const) expect(dist(back[k], curve[k])).toBeLessThan(TL_STEP * 1.5);
    const line = { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0.4 }, p2: { x: 200, y: -0.3 }, p3: { x: 300, y: 0 } };
    expect(curveRec(6, 0, line)).toEqual([6, 0, 0, 0, 75, 0]);
    expect(dist(recCurve(curveRec(6, 0, line)).p3, line.p3)).toBeLessThan(TL_STEP);
  });

  it('первый кадр — мир на старте целиком, дальше — только изменения: дорога, станции, маршрут, транспорт', () => {
    const game = withoutCitizens(freshGame(7));
    const frames = game.timelapse.frames;
    expect(frames).toHaveLength(1);
    const start = frames[0];
    expect(start.full).toBe(1);
    expect(start.m).toBe(0);
    // Улицы городов есть с начала, станций и маршрутов ещё нет.
    expect(start.r?.length).toBe(game.roads.net.corridors.size);
    expect(start.s).toBeUndefined();
    expect(start.tw).toEqual(game.towns.map((t) => t.id));
    expect(start.p).toEqual(game.towns.map((t) => Math.round(t.population)));

    const { built, line, sA, sB } = freightRoute(game);
    expect(built).toBe(true);
    game.buyVehicle(line.id, 'truck');
    runMonths(game, 1.05);
    expect(frames).toHaveLength(2);
    const month = frames[1];
    expect(month.full).toBeUndefined();
    expect(month.m).toBeCloseTo(1, 1);
    expect(month.s?.map((r) => r[0]).sort()).toEqual([sA.id, sB.id].sort());
    expect(month.l).toEqual([[line.id, line.color, 0, sA.id, sB.id]]);
    expect(month.n).toBe(1);
    // Новые полотна — дорога между станциями и выезды; остальные улицы не повторяются.
    expect(month.r!.length).toBeGreaterThan(0);
    expect(month.r!.length).toBeLessThan(start.r!.length);
    // Список городов не менялся — без повторного tw.
    expect(month.tw).toBeUndefined();
    // Кадры по порядку дают ровно сеть игры.
    const state = replay(frames);
    expect([...state.r.keys()].sort((a, b) => a - b)).toEqual([...game.roads.net.corridors.keys()].sort((a, b) => a - b));
    expect([...state.s.keys()].sort()).toEqual([...game.stations.keys()].sort());

    // Тихий месяц — кадр без изменений сети, только счётчики.
    runMonths(game, 1);
    const quiet = frames[2];
    expect(quiet.s).toBeUndefined();
    expect(quiet.l).toBeUndefined();
    expect(quiet.sd).toBeUndefined();
  });

  it('снос — номером в кадре; раскладка знает, когда объект появился и когда исчез', () => {
    const game = withoutCitizens(freshGame(7));
    const { line, sA } = freightRoute(game);
    runMonths(game, 1.05);
    game.deleteLine(line.id);
    runMonths(game, 1);
    const last = game.timelapse.frames[2];
    expect(last.ld).toEqual([line.id]);
    const tl = buildTimeline(game.timelapse.frames);
    const item = tl.layers.l.find((i) => i.id === line.id)!;
    expect(item.from).toBe(1);
    expect(item.to).toBe(2);
    const st = tl.layers.s.find((i) => i.id === sA.id)!;
    expect(st.to).toBe(Infinity);
    expect(tl.frames.map((f) => f.m)).toEqual(game.timelapse.frames.map((f) => f.m));
    expect(tl.frames[0].pops.get(game.towns[0].id)).toBe(game.timelapse.frames[0].p[0]);
  });

  it('кадры сохраняются и загружаются: после загрузки запись продолжается изменениями, не целиком', () => {
    const game = withoutCitizens(freshGame(7));
    freightRoute(game);
    runMonths(game, 2.05);
    const saved = roundTrip(game);
    expect(saved.timelapse?.frames).toHaveLength(3);
    const loaded = withoutCitizens(new Game(saved.settings, saved));
    expect(loaded.timelapse.frames).toEqual(game.timelapse.frames);
    // Без новых улиц от роста городов: месяц после загрузки — без правок дорог.
    for (const t of loaded.towns) t.autoStreets = false;
    runMonths(loaded, 1);
    const next = loaded.timelapse.frames[3];
    expect(next.full).toBeUndefined();
    expect(next.r).toBeUndefined();
    expect(next.s).toBeUndefined();
    const state = replay(loaded.timelapse.frames);
    expect(state.r.size).toBe(loaded.roads.net.corridors.size);
    expect(state.l.size).toBe(loaded.lines.size);
  });

  it('старое сохранение без кадров: запись начинается с загрузки — первым кадром целиком', () => {
    const game = withoutCitizens(freshGame(7));
    const { sA } = freightRoute(game);
    runMonths(game, 1.05);
    const saved = roundTrip(game);
    delete saved.timelapse;
    const loaded = withoutCitizens(new Game(saved.settings, saved));
    expect(loaded.timelapse.frames).toHaveLength(1);
    const first = loaded.timelapse.frames[0];
    expect(first.full).toBe(1);
    expect(first.m).toBeCloseTo(1.05, 1);
    expect(first.s?.some((r) => r[0] === sA.id)).toBe(true);
    // Начало партии добирается по журналу: станции и маршрут — с первого месяца, без дорог.
    const src = timelapseOf(loaded);
    expect(src.rough).toBe(true);
    expect(src.frames[0].m).toBe(0);
    expect(src.frames[0].r).toBeUndefined();
    expect(src.frames.some((f) => f.m < 1.05 && f.s?.some((r) => r[0] === sA.id))).toBe(true);
  });

  it('новая партия — без кадров по журналу; финал — сеть на сейчас, даже если месяц не кончился', () => {
    const game = withoutCitizens(freshGame(7));
    freightRoute(game);
    const src = timelapseOf(game);
    expect(src.rough).toBe(false);
    // Стройка на паузе до конца первого месяца: кадр старта и кадр «сейчас».
    expect(src.frames).toHaveLength(2);
    expect(src.frames[1].s).toHaveLength(2);
    expect(aliveAtEnd(src.frames).s).toEqual([...game.stations.keys()].sort((a, b) => a - b));
    // Запись при этом не меняется.
    expect(game.timelapse.frames).toHaveLength(1);
  });

  it('склейка кадров не меняет итоговую сеть, а запись держится в пределах', () => {
    const rec = new TimelapseRecorder();
    const frames: TimelapseFrame[] = [{ m: 0, full: 1, $: 0, n: 0, p: [1], tw: [1], r: [[1, 0, 0, 0, 10, 0]] }];
    for (let i = 1; i <= 700; i++) {
      const f: TimelapseFrame = { m: i, $: i, n: i % 7, p: [100 + i], r: [[1000 + i, 0, i, i, 10, 0]] };
      if (i % 3 === 0) f.rd = [1000 + i - 1];
      if (i % 50 === 0) f.s = [[i, 0, i, i, 0]];
      if (i % 100 === 0) f.sd = [i - 50];
      frames.push(f);
    }
    // Склейка двух кадров — как оба по очереди.
    for (let i = 1; i < frames.length - 1; i += 37) {
      const merged = [...frames.slice(0, i), mergeFrames(frames[i], frames[i + 1]), ...frames.slice(i + 2)];
      expect(replay(merged)).toEqual(replay(frames));
    }
    // Запись сверх предела кадров — склеивает старшую половину.
    rec.frames.push(...frames);
    (rec as unknown as { limit(): void }).limit();
    expect(rec.frames.length).toBeLessThanOrEqual(TL_FRAMES);
    expect(rec.frames[0]).toBe(frames[0]);
    expect(rec.frames[rec.frames.length - 1]).toBe(frames[frames.length - 1]);
    expect(replay(rec.frames)).toEqual(replay(frames));
    expect(aliveAtEnd(rec.frames)).toEqual(aliveAtEnd(frames));
    // Недавние месяцы — помесячно, старые — реже.
    const ms = rec.frames.map((f) => f.m);
    expect(ms[ms.length - 1] - ms[ms.length - 2]).toBe(1);
    expect(ms[2] - ms[1]).toBeGreaterThan(1);
  });

  it('предел по размеру: история больше TL_CHARS прореживается, а сама сеть — нет', () => {
    const chars = (rec: TimelapseRecorder) => {
      (rec as unknown as { chars: number }).chars = rec.frames.reduce((s, f) => s + JSON.stringify(f).length, 0);
      (rec as unknown as { last: null }).last = null;
    };
    const towns = { p: Array.from({ length: 30 }, () => 5000), tw: Array.from({ length: 30 }, (_, k) => k) };
    // Одни и те же 40 дорог каждый месяц перестраиваются — история большая, сеть маленькая.
    const churn = new TimelapseRecorder();
    for (let i = 0; i < 400; i++) {
      churn.frames.push({ m: i, $: 1_000_000 + i, n: i, ...towns, ...(i ? {} : { full: 1 as const }), r: Array.from({ length: 40 }, (_, k) => [k, 0, 1000 + k + i, 1000, 25, 25]) });
    }
    chars(churn);
    const final = replay(churn.frames);
    expect(churn.size).toBeGreaterThan(TL_CHARS);
    (churn as unknown as { limit(): void }).limit();
    expect(churn.size).toBeLessThanOrEqual(TL_CHARS + 40 * 30);
    expect(churn.size).toBe(churn.frames.reduce((s, f) => s + JSON.stringify(f).length, 0));
    expect(churn.frames.length).toBeGreaterThan(50);
    expect(replay(churn.frames)).toEqual(final);
    // Каждый месяц 40 новых дорог, ничего не сносится: вся запись — это сама сеть, прореживать нечего.
    const growth = new TimelapseRecorder();
    for (let i = 0; i < 400; i++) {
      growth.frames.push({ m: i, $: 0, n: 0, p: [], ...(i ? {} : { full: 1 as const, tw: [] }), r: Array.from({ length: 40 }, (_, k) => [i * 100 + k, 0, 1000 + k, 1000, 25, 25]) });
    }
    chars(growth);
    expect(growth.size).toBeGreaterThan(TL_CHARS);
    (growth as unknown as { limit(): void }).limit();
    expect(growth.frames).toHaveLength(400);
  });

  it('«Со строительством»: проект дороги — своим слоем b, построенный участок уходит из b в r', () => {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
    const at = fieldSpot(game, 600);
    const plan = game.roadBuilder.road(anchorOf(game, { free: at }), anchorOf(game, { free: { x: at.x + 600, y: at.y } }), STREET, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    const net = game.roads.net;
    const ids = () => [...net.corridors.values()].filter((c) => c.build).map((c) => c.id).sort((a, b) => a - b);
    const planned = ids();
    expect(planned.length).toBeGreaterThan(0);
    // Проект — не дорога: в слое проектов, не в дорогах. Баз нет — так и стоит проектом.
    runMonths(game, 1.05);
    const month = game.timelapse.frames[1];
    expect(month.b?.map((r) => r[0] as number).sort((a, b) => a - b)).toEqual(planned);
    expect(month.r?.some((r) => planned.includes(r[0] as number)) ?? false).toBe(false);
    for (const rec of month.b!) expect(rec[1]).toBe(0);
    // Тихий месяц — проект не повторяется.
    runMonths(game, 1);
    expect(game.timelapse.frames[2].b).toBeUndefined();
    // Участки открыли (как стройка: у полотна снимается build): те же полотна — дорогами, из проектов — сносом.
    for (const id of planned) delete net.corridor(id).build;
    const opened = game.timelapse.capture(game);
    expect(opened.bd?.slice().sort((a, b) => a - b)).toEqual(planned);
    expect((opened.r ?? []).map((r) => r[0] as number).filter((id) => planned.includes(id)).sort((a, b) => a - b)).toEqual(planned);
    const state = replay(game.timelapse.frames);
    expect(state.b.size).toBe(0);
    expect([...state.r.keys()].sort((a, b) => a - b)).toEqual([...net.corridors.keys()].sort((a, b) => a - b));
    // Раскладка: проект виден с кадра 1 до 3, дорога — с 3.
    const tl = buildTimeline(game.timelapse.frames);
    for (const id of planned) {
      expect(tl.layers.b.find((i) => i.id === id)).toMatchObject({ from: 1, to: 3 });
      expect(tl.layers.r.find((i) => i.id === id)).toMatchObject({ from: 3, to: Infinity });
    }
    // Склейка кадров держит и проекты.
    expect(replay([game.timelapse.frames[0], mergeFrames(game.timelapse.frames[1], game.timelapse.frames[2]), game.timelapse.frames[3]])).toEqual(state);
  });

  it('за год партии кадры весят малую долю сохранения', () => {
    const game = withoutCitizens(freshGame(7));
    freightRoute(game);
    runMonths(game, 12.05);
    const save = JSON.stringify(game.toSave()).length;
    const frames = JSON.stringify(game.timelapse.toSave()).length;
    expect(game.timelapse.frames).toHaveLength(13);
    // Первый кадр — все улицы городов; помесячные — по сотне символов.
    expect(frames / save).toBeLessThan(0.1);
    const monthly = game.timelapse.frames.slice(2).map((f) => JSON.stringify(f).length);
    expect(Math.max(...monthly)).toBeLessThan(600);
  });
});

describe('Таймлапс по журналу (старые сохранения)', () => {
  it('станции — по координатам из записей station, маршруты — из line и route, счётчики — из сводок', () => {
    const entries: JournalEntry[] = [
      { m: 0, k: 'game', money: 500000 },
      { m: 0.1, k: 'station', id: 3, kind: 'road', pos: [400, 800] },
      { m: 0.2, k: 'station', id: 4, kind: 'stop', pos: [1200, 800] },
      { m: 0.3, k: 'line', id: 1, mode: 'road', stops: [3, 4] },
      { m: 1, k: 'month', money: 420000, lines: [[1, 0, 0, 0, null, 2]], towns: [[10, 1500, 0, {}], [11, 900, 0, {}]] },
      { m: 1.4, k: 'station', id: 5, kind: 'rail', pos: [2000, 400] },
      { m: 1.5, k: 'route', id: 1, stops: [3, 4, 5] },
      { m: 1.6, k: 'station-', id: 4 },
      { m: 2, k: 'month', money: 380000, lines: [[1, 0, 0, 0, null, 3]], towns: [[10, 1600, 0, {}], [11, 950, 0, {}]] },
      { m: 2.5, k: 'line-', id: 1 },
      { m: 3, k: 'month', money: 400000, lines: [], towns: [[10, 1650, 0, {}], [11, 960, 0, {}]] },
    ];
    const frames = journalFrames(entries, () => '#e5534b');
    expect(frames.map((f) => f.m)).toEqual([0, 1, 2, 3]);
    expect(frames.map((f) => f.$)).toEqual([500000, 420000, 380000, 400000]);
    expect(frames.map((f) => f.n)).toEqual([0, 2, 3, 0]);
    expect(frames[1].s).toEqual([
      [3, 0, 100, 200, 0],
      [4, 1, 300, 200, 0],
    ]);
    expect(frames[1].l).toEqual([[1, '#e5534b', 0, 3, 4]]);
    expect(frames[2].l).toEqual([[1, '#e5534b', 0, 3, 4, 5]]);
    expect(frames[2].s?.map((r) => r[0])).toEqual([3, 5]);
    expect(frames[3].l).toEqual([]);
    expect(frames[2].tw).toEqual([10, 11]);
    expect(frames[2].p).toEqual([1600, 950]);
    // Кадры целиком: раскладка сама видит, что станция 4 снесена, а маршрут поменялся.
    const tl = buildTimeline(frames);
    expect(tl.layers.s.find((i) => i.id === 4)).toMatchObject({ from: 1, to: 2 });
    expect(tl.layers.s.find((i) => i.id === 3)).toMatchObject({ from: 1, to: Infinity });
    expect(tl.layers.l.map((i) => [i.from, i.to])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    // Предел по времени: только до второго месяца.
    expect(journalFrames(entries, () => '#000', 2).map((f) => f.m)).toEqual([0, 1]);
  });
});
