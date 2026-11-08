import { describe, expect, it } from 'vitest';
import { GROUND, pickLevel, SceneDiff, SETTLE_MS, SHRINK_MAX, STRETCH_MAX, TILE_PX, tileBox, TileCache, tileRange, tileRect, tileWorld, UNDER } from './tileCache';

/** Холст-заглушка: только вид и номер — чтобы видеть, что холсты возвращаются в запас и выдаются снова. */
let made = 0;
const fake = (opaque: boolean) => ({ opaque, n: ++made });

describe('Раскладка плиток', () => {
  it('плитка — TILE_PX пикселей холста: в мире тем меньше, чем крупнее зум и плотнее экран', () => {
    expect(tileWorld(1, 1)).toBe(TILE_PX);
    expect(tileWorld(2, 1)).toBe(TILE_PX / 2);
    expect(tileWorld(0.5, 2)).toBe(TILE_PX);
    expect(tileBox(-1, 2, 100)).toEqual({ x0: -100, y0: 200, x1: 0, y1: 300 });
  });

  it('рамка задевает плитки включительно, и с отрицательными номерами', () => {
    expect(tileRange({ x0: -1, y0: 0, x1: 250, y1: 99 }, 100)).toEqual({ i0: -1, i1: 2, j0: 0, j1: 0 });
  });

  it('свой уровень ложится на экран ровно TILE_PX и в целые пиксели; чужой — растянут', () => {
    const w = tileWorld(0.7, 2);
    const r = tileRect(3, -2, w, 0.7 * 2, -1234, 567);
    expect(r.size).toBe(TILE_PX);
    expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
    expect(r.x).toBe(3 * TILE_PX - 1234);
    const s = tileRect(3, -2, w, 0.7 * 2 * 1.2, -1234, 567);
    expect(s.size).toBeCloseTo(TILE_PX * 1.2);
  });
});

describe('Уровень зума плиток', () => {
  it('первый — ровно зум камеры; зум постоял — ровно под него', () => {
    expect(pickLevel(null, 0.8, 0)).toBe(0.8);
    expect(pickLevel(0.8, 0.9, SETTLE_MS)).toBe(0.9);
  });

  it('во время зума старый уровень растягивается, пока растяжение в пределах', () => {
    expect(pickLevel(1, 1.2, 10)).toBe(1);
    expect(pickLevel(1, 0.8, 10)).toBe(1);
    expect(pickLevel(1, STRETCH_MAX * 1.01, 10)).toBeCloseTo(STRETCH_MAX * 1.01);
    expect(pickLevel(1, 1 / SHRINK_MAX / 1.01, 10)).toBeCloseTo(1 / SHRINK_MAX / 1.01);
  });

  it('новый уровень заводится, прежний остаётся запасным', () => {
    const cache = new TileCache(fake);
    const a = cache.frame(1, 1, 0);
    expect(cache.frame(1.1, 1, 10)).toBe(a);
    const b = cache.frame(1.1, 1, 10 + SETTLE_MS);
    expect(b.zoom).toBe(1.1);
    expect(cache.sets).toEqual([b, a]);
    // Другая плотность экрана — всё заново.
    const c = cache.frame(1.1, 2, 1000);
    expect(cache.sets).toEqual([c]);
  });
});

describe('Слепок нарисованного', () => {
  const box = (x: number) => ({ x0: x, y0: 0, x1: x + 1, y1: 1 });

  it('первый раз — всё новое; без изменений — пусто', () => {
    const d = new SceneDiff();
    expect(d.update((add) => [1, 2].forEach((id) => add(id, 'a', box(id))))).toHaveLength(2);
    expect(d.update((add) => [1, 2].forEach((id) => add(id, 'a', box(id))))).toEqual([]);
  });

  it('изменённое — старая и новая рамки, пропавшее — его рамка, новое — своя', () => {
    const d = new SceneDiff();
    d.update((add) => {
      add(1, 'a', box(1));
      add(2, 'a', box(2));
    });
    const out = d.update((add) => {
      add(1, 'b', box(10));
      add(3, 'a', box(3));
    });
    expect(out).toEqual([box(1), box(10), box(3), box(2)]);
    expect(d.size).toBe(2);
  });
});

describe('Плитки кэша', () => {
  it('устаревают только задетые рамкой изменения', () => {
    const cache = new TileCache(fake);
    const set = cache.frame(1, 1, 0);
    const tiles = cache.cover(set, { x0: 0, y0: 0, x1: 3 * TILE_PX - 1, y1: TILE_PX - 1 });
    for (const t of tiles) t.ready = true;
    expect(cache.invalidate([{ x0: TILE_PX + 10, y0: 10, x1: TILE_PX + 20, y1: 20 }])).toBe(1);
    expect(tiles.map((t) => t.dirty)).toEqual([false, true, false]);
    cache.invalidateAll();
    expect(tiles.every((t) => t.dirty)).toBe(true);
  });

  it('работа на кадр: дыры первыми, потом устаревшие, потом про запас', () => {
    const cache = new TileCache(fake);
    const set = cache.frame(1, 1, 0);
    const screen = { x0: 0, y0: 0, x1: 2 * TILE_PX - 1, y1: TILE_PX - 1 };
    const [a, b] = cache.cover(set, screen);
    a.ready = true;
    a.dirty = true;
    const jobs = cache.jobs(set, screen, { x0: -1, y0: 0, x1: 2 * TILE_PX - 1, y1: TILE_PX - 1 });
    expect(jobs.map((j) => [j.tile === b ? 'b' : j.tile === a ? 'a' : 'x', j.must, j.dirty, j.ahead])).toEqual([
      ['b', true, false, false],
      ['a', false, true, false],
      ['x', false, false, true],
    ]);
  });

  it('недорисованная плитка нового уровня не дыра, если её закрывает запасной уровень', () => {
    const cache = new TileCache(fake);
    const old = cache.frame(1, 1, 0);
    for (const t of cache.cover(old, { x0: 0, y0: 0, x1: 2 * TILE_PX, y1: 2 * TILE_PX })) t.ready = true;
    const set = cache.frame(1.2, 1, SETTLE_MS * 2);
    const screen = { x0: 10, y0: 10, x1: TILE_PX, y1: TILE_PX };
    expect(cache.jobs(set, screen, screen).every((j) => !j.must)).toBe(true);
    // Вне готового — дыра.
    const far = { x0: 5 * TILE_PX, y0: 0, x1: 5 * TILE_PX + 10, y1: 10 };
    expect(cache.jobs(set, far, far).every((j) => j.must)).toBe(true);
  });

  it('устаревшая плитка на экран не копируется — её место рисуется вживую', () => {
    const cache = new TileCache(fake);
    const set = cache.frame(1, 1, 0);
    const screen = { x0: 0, y0: 0, x1: 3 * TILE_PX - 1, y1: TILE_PX - 1 };
    const [a, b, c] = cache.cover(set, screen);
    for (const t of [a, b, c]) t.ready = true;
    cache.invalidate([{ x0: TILE_PX + 10, y0: 10, x1: TILE_PX + 20, y1: 20 }]);
    const l = cache.layout(set, screen);
    expect(l.fresh).toEqual([a, c]);
    expect(l.live).toEqual([tileBox(1, 0, set.world)]);
    expect(l.holes).toEqual([]);
  });

  it('протяжка дороги: плитки устаревают каждый кадр, перерисовать успевают одну — на экране всё равно нет прежней', () => {
    const cache = new TileCache(fake);
    const set = cache.frame(1, 1, 0);
    // Дорога сверху вниз через 4 ряда плиток.
    const screen = { x0: 0, y0: 0, x1: TILE_PX - 1, y1: 4 * TILE_PX - 1 };
    for (const t of cache.cover(set, screen)) t.ready = true;
    const road = { x0: 100, y0: 0, x1: 200, y1: 4 * TILE_PX - 1 };
    for (let frame = 0; frame < 10; frame++) {
      cache.frame(1, 1, frame);
      cache.invalidate([road]);
      // Бюджет кадра — на одну плитку: первую по порядку работы (верхнюю).
      const [job] = cache.jobs(set, screen, screen);
      job.tile.dirty = false;
      const l = cache.layout(set, screen);
      // Ни одна плитка с прежней дорогой не копируется: свежая — только что перерисованная, остальное — вживую.
      expect(l.fresh).toEqual([job.tile]);
      expect(l.live).toHaveLength(3);
      expect(l.fresh.every((t) => !t.dirty)).toBe(true);
    }
  });

  it('дыра нового уровня: свежий запасной — растянутым, устаревший запасной — вживую', () => {
    const cache = new TileCache(fake);
    const old = cache.frame(1, 1, 0);
    for (const t of cache.cover(old, { x0: 0, y0: 0, x1: 4 * TILE_PX, y1: 2 * TILE_PX })) t.ready = true;
    cache.frame(1.2, 1, 10);
    const set = cache.frame(1.2, 1, 10 + SETTLE_MS);
    expect(cache.sets).toEqual([set, old]);
    const w = set.world;
    const screen = { x0: 10, y0: 10, x1: 2 * w - 10, y1: w - 10 };
    let l = cache.layout(set, screen);
    expect(l.live).toEqual([]);
    expect(l.holes).toEqual([tileBox(0, 0, w), tileBox(1, 0, w)]);
    expect(l.fallback.map((f) => f.set)).toEqual([old]);
    // Дорогу поменяли во второй дыре: запасная плитка под ней устарела — эту дыру вживую, первую — из запасного.
    cache.invalidate([{ x0: 1.5 * w, y0: 10, x1: 1.5 * w + 5, y1: 20 }]);
    l = cache.layout(set, screen);
    expect(l.holes).toEqual([tileBox(0, 0, w)]);
    expect(l.live).toEqual([tileBox(1, 0, w)]);
    expect(l.fallback.flatMap((f) => f.tiles).every((t) => !t.dirty)).toBe(true);
  });

  it('холсты слоёв: нужен — выдаётся (тот же при перерисовке), не нужен — в запас и снова в дело', () => {
    const cache = new TileCache(fake);
    const set = cache.frame(1, 1, 0);
    const t = cache.tile(set, 0, 0);
    const ground = cache.layer(t, GROUND, true)!;
    expect(cache.layer(t, GROUND, true)).toBe(ground);
    expect(cache.layer(t, UNDER, null)).toBeNull();
    // Появились тоннели: земля под ними — непрозрачная, слой земли — прозрачный (другой холст).
    const under = cache.layer(t, UNDER, true)!;
    expect(under).not.toBe(ground);
    const clear = cache.layer(t, GROUND, false)!;
    expect(clear.opaque).toBe(false);
    expect(cache.canvases).toBe(2);
    // Непрозрачный холст земли ушёл в запас — следующая плитка получит его.
    const t2 = cache.tile(set, 1, 0);
    expect(cache.layer(t2, GROUND, true)).toBe(ground);
  });

  it('вытесняются давно не нужные плитки, холсты — в запас', () => {
    const cache = new TileCache(fake);
    let set = cache.frame(1, 1, 0);
    for (let i = 0; i < 10; i++) cache.layer(cache.tile(set, i, 0), GROUND, true);
    set = cache.frame(1, 1, 1);
    cache.tile(set, 9, 0);
    cache.trim(4);
    expect(set.tiles.size).toBe(4);
    expect(set.tiles.has('9:0')).toBe(true);
    expect(cache.canvases).toBe(4);
  });
});
