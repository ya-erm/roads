import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, TERM_SCALE } from '../config';
import { dist } from '../core/vec';
import { twoWay } from '../lanes/model';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game } from './game';
import { Journal, JOURNAL_LIMIT, journalFile, tidy } from './journal';
import { connectStations, freshGame, stationAtIndustry, withoutCitizens } from './testkit';

/** months месяцев — и ещё кадр: ровно на границе месяца время, накопленное шагами симуляции, может не дотянуть. */
function runMonths(game: Game, months: number): void {
  game.speed = 1;
  for (let t = 0; t < months * MONTH_LENGTH + 0.1; t += 0.1) game.update(0.1);
}

/**
 * Грузовая линия от ближайшей фермы к комбинату на трёх грузовиках. Трасса — своя сеть в стороне от городов,
 * машины жителей на неё не попадают: игра — без них, так месяц симуляции в разы быстрее.
 */
function farmLine(game: Game) {
  withoutCitizens(game);
  game.money = 5_000_000;
  const { f, p } = game.industries
    .filter((i) => i.info.kind === 'farm')
    .flatMap((f) => game.industries.filter((i) => i.info.kind === 'foodplant').map((p) => ({ f, p, d: dist(f.fp.center, p.fp.center) })))
    .sort((a, b) => a.d - b.d)[0];
  game.checkpoint('станция');
  const sA = stationAtIndustry(game, f, p.fp.center)!;
  const sB = stationAtIndustry(game, p, f.fp.center)!;
  game.commit();
  game.checkpoint('дорога');
  expect(connectStations(game, sA, sB, { cls: 'highway', lanes: twoWay(1, 1) })).toBe(true);
  game.commit();
  const line = game.createLine([sA.id, sB.id])!;
  for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
  return { line, farm: f, plant: p, sA, sB };
}

/** В записи нет чисел длиннее сотых. */
const LONG_NUMBER = /\d\.\d{3,}/;

describe('Журнал партии', { timeout: 120_000 }, () => {
  it('округляет числа до сотых и выбрасывает пустые поля', () => {
    expect(tidy({ a: 1.23456, b: [0.1 + 0.2, -0.0001], c: undefined, d: null, e: { f: 1234.5678 } })).toEqual({ a: 1.23, b: [0.3, 0], e: { f: 1234.57 } });
    let t = 1 / 3;
    const j = new Journal(() => t);
    j.add('x', { v: Math.PI });
    expect(j.entries[0]).toEqual({ m: 0.33, k: 'x', v: 3.14 });
    t = 2;
  });

  it('пишет стройку, станции, маршрут, покупки, рейсы с доставкой и месячные сводки производства', () => {
    const game = freshGame(7);
    const { line, farm, plant, sA, sB } = farmLine(game);
    // 2 мин 24 с: рейсы с доставкой и две месячные сводки.
    runMonths(game, 1.2 * TERM_SCALE);
    const kinds = (k: string) => game.journal.entries.filter((e) => e.k === k);
    expect(kinds('game')).toHaveLength(1);
    expect(kinds('station').map((e) => e.id)).toEqual([sA.id, sB.id]);
    const builds = kinds('build');
    expect(builds.map((e) => e.what)).toEqual(['станция', 'дорога']);
    expect(builds[1].$).toBeGreaterThan(0);
    expect(builds[1].roads).toBeGreaterThan(0);
    // Что именно построено: длины по классу дороги и полосам.
    expect(Object.keys(builds[1].kinds as Record<string, number>).some((k) => k.startsWith('highway 1+1'))).toBe(true);
    expect(kinds('line')[0]).toMatchObject({ id: line.id, stops: [sA.id, sB.id] });
    expect(kinds('buy')).toHaveLength(3);
    // Рейсы: на ферме грузят зерно (пока стоят — видно при отправлении), на комбинате выгружают его комбинату
    // и получают деньги.
    const stops = kinds('stop');
    expect(stops.some((e) => e.st === sA.id)).toBe(true);
    const delivered = stops.filter((e) => e.st === sB.id && e.drop);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered[0]).toMatchObject({ l: line.id, to: `industry:${plant.id}`, from: sA.id });
    expect(delivered[0].pay).toBeGreaterThan(0);
    // Рейс: сколько ехал от прошлой станции, длина пути по дороге, средняя скорость и простой в пути.
    const leg = delivered[0] as Record<string, number>;
    expect(leg.trip).toBeGreaterThan(0);
    expect(leg.len).toBeGreaterThan(dist(sA.fp.center, sB.fp.center) * 0.9);
    expect(leg.kmh).toBeGreaterThan(10);
    expect(leg.kmh).toBeLessThan(130);
    expect(leg.jam).toBeGreaterThanOrEqual(0);
    expect(kinds('go').some((e) => e.st === sA.id && (e.load as number) > 0 && e.cargo === 'grain')).toBe(true);
    // Смена «пассажиры / груз» у станции — тоже в журнале.
    game.setStationServes(sA.id, { pax: false, cargo: true });
    expect(kinds('serves').at(-1)).toMatchObject({ st: sA.id, pax: false, cargo: true });
    // Сводки по месяцам: линия, ферма и комбинат с уровнем, выпуском и складом.
    const months = kinds('month');
    expect(months).toHaveLength(TERM_SCALE);
    const last = months[months.length - 1];
    expect(months.some((m) => (m.lines as number[][]).find((l) => l[0] === line.id)![3] > 0)).toBe(true);
    const inds = last.inds as number[][];
    expect(inds.some((i) => i[0] === farm.id && i[2] > 0)).toBe(true);
    expect(inds.some((i) => i[0] === plant.id)).toBe(true);
    expect(typeof last.date).toBe('string');
    // Ни одного длинного числа во всём журнале.
    expect(LONG_NUMBER.test(JSON.stringify(game.journal.entries))).toBe(false);
  });

  it('хранится в сохранении и продолжается после загрузки', () => {
    const game = freshGame(7);
    farmLine(game);
    runMonths(game, 0.5);
    const n = game.journal.entries.length;
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = withoutCitizens(new Game(save.settings, save));
    expect(loaded.journal.entries.slice(0, n)).toEqual(game.journal.entries);
    expect(loaded.journal.entries[n].k).toBe('load');
    // До конца месяца — с запасом: время копится шагами симуляции, ровно на границе конец мог не наступить.
    runMonths(loaded, 0.7);
    expect(loaded.journal.entries.slice(n + 1).some((e) => e.k === 'month')).toBe(true);
  });

  it('сверх предела первыми уходят старые рейсы, а задания, события и сводки остаются', () => {
    const j = new Journal(() => 0);
    j.add('obj', { id: 'o1' });
    for (let i = 0; i < JOURNAL_LIMIT; i++) j.add(i % 50 ? 'stop' : 'month', { i });
    expect(j.entries.length).toBeLessThanOrEqual(JOURNAL_LIMIT);
    expect(j.entries[0]).toMatchObject({ k: 'obj', id: 'o1' });
    expect(j.entries.filter((e) => e.k === 'month')).toHaveLength(JOURNAL_LIMIT / 50);
  });

  it('сценарий пишет старт, задания с оценкой выполнимого, принятие, события и сводку прогресса; файл читается построчно', () => {
    // Месяц без машин жителей: журнал сценария от них не зависит.
    const game = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 42, scenario: { difficulty: 'normal', challenge: false } }));
    const sc = game.scenario!;
    const kinds = (k: string) => game.journal.entries.filter((e) => e.k === k);
    expect(kinds('scenario')[0]).toMatchObject({ archetype: sc.state.archetype, difficulty: 'normal' });
    const objs = kinds('obj');
    expect(objs.length).toBe(sc.state.objectives.length);
    expect(objs.find((e) => e.role === 'main')!.est).toBeGreaterThan(0);
    sc.accept(sc.offers[0].id);
    expect(kinds('accept')).toHaveLength(1);
    runMonths(game, 1);
    const month = kinds('month')[0];
    expect((month.obj as unknown[][]).length).toBe(sc.current.length);
    expect(month.rep).toBe(sc.state.reputation);
    const lines = journalFile(game).split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ k: 'header', seed: 42 });
    expect(lines[0].legend.stop).toBeTruthy();
    expect(lines[1].k).toBe('world');
    expect(lines[2].k).toBe('state');
    expect(lines.length).toBe(3 + game.journal.entries.length);
  });
});
