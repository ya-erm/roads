import { describe, expect, it, vi } from 'vitest';
import { CARGO, INDUSTRY_LIST, INDUSTRY_TYPES } from '../world/cargo';
import type { Industry } from '../world/entities';
import { annexMotion, drawAnnexArt } from './annexArt';
import { Art, artMoves, type ArtLayer, drawEmitters, drawIndustryArt, industryMotion } from './industryArt';
import { drawIndustryYardStock } from './industryStationArt';

/** Работающее предприятие вида info с пристройкой. */
function industry(info: (typeof INDUSTRY_LIST)[number]): Industry {
  return {
    type: 'industry',
    id: 7,
    info,
    name: info.name,
    fp: { center: { x: 100, y: 50 }, w: info.w, h: info.h, angle: 0.3 },
    stock: Object.fromEntries(info.accepts.map((c) => [c, 60])),
    output: 0,
    producedMonth: 5,
    producedLast: 5,
    prodAcc: 0,
    level: 2,
    annexes: [{ type: 'annex', id: 31, industryId: 7, fp: { center: { x: 200, y: 50 }, w: info.w * 0.6, h: info.h * 0.6, angle: 0.3 } }],
  } as Industry;
}

/** Холст-заглушка: сколько раз позван каждый метод рисования; преобразования — отдельно. */
function stub() {
  const draws: Record<string, number> = {};
  const moves: Record<string, number> = {};
  const transforms = new Set(['save', 'restore', 'translate', 'rotate', 'scale', 'transform', 'setTransform', 'resetTransform']);
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) =>
      k in t
        ? t[k]
        : (...args: unknown[]) => {
            void args;
            const book = transforms.has(String(k)) ? moves : draws;
            book[String(k)] = (book[String(k)] ?? 0) + 1;
          },
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws, moves };
}

function paint(ind: Industry, zoom: number, layer: ArtLayer) {
  const s = stub();
  drawIndustryArt(s.ctx, ind, zoom, 3.7, layer);
  drawAnnexArt(s.ctx, ind, ind.annexes![0], zoom, 3.7, layer);
  return s;
}

/** Движущееся вблизи — излучатели предприятия и пристройки, нарисованные поверх (как в кадре карты). */
function motion(ind: Industry) {
  const s = stub();
  const list = [...industryMotion(ind), ...annexMotion(ind, ind.annexes![0])];
  drawEmitters(s.ctx, list, 3.7, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  return { ...s, list };
}

const sum = (a: Record<string, number>, b: Record<string, number>) => {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

describe('Предприятия в кэше карты: неподвижное и движущееся', () => {
  it('вблизи «неподвижное» + «движущееся» — ровно вся сцена, у каждого вида предприятий', () => {
    let moving = 0;
    for (const info of INDUSTRY_LIST) {
      const ind = industry(info);
      const all = paint(ind, 1, 'all');
      const still = paint(ind, 1, 'still');
      const moves = motion(ind);
      expect(sum(still.draws, moves.draws), info.kind).toEqual(all.draws);
      // Только поворачивающейся технике нужны локальные save/restore.
      const turning = moves.list.filter((e) => e.kind === 'equipment' && e.equipment.kind !== 'rail').length;
      expect(moves.moves.save ?? 0, info.kind).toBe(turning);
      expect(moves.moves.restore ?? 0, info.kind).toBe(turning);
      expect(moves.moves.setTransform ?? 0, info.kind).toBe(moves.list.length + 1);
      if (moves.list.length) moving++;
    }
    // Дым, огонь или качалки есть не у всех, но у многих.
    expect(moving).toBeGreaterThan(3);
  });

  it('рабочая техника зависит от вида производства и останавливается при простое', () => {
    for (const [info, kinds] of [
      [INDUSTRY_TYPES.farm, ['harvester']],
      [INDUSTRY_TYPES.quarry, ['haul', 'excavator']],
      [INDUSTRY_TYPES.steelmill, ['rail']],
    ] as const) {
      const ind = industry(info);
      const equipment = (target: Industry) => industryMotion(target).flatMap((e) => e.kind === 'equipment' ? [e.equipment.kind] : []);
      expect(equipment(ind), info.kind).toEqual(kinds);
      expect(equipment({ ...ind, producedMonth: 0, producedLast: 0 }), info.kind).toEqual([]);
    }
  });

  it('излучатели — в мире: на участке своего предприятия или пристройки', () => {
    for (const info of INDUSTRY_LIST) {
      const ind = industry(info);
      for (const [fp, list] of [
        [ind.fp, industryMotion(ind)],
        [ind.annexes![0].fp, annexMotion(ind, ind.annexes![0])],
      ] as const) {
        for (const e of list) {
          const [a, b, c, d, ex, ey] = e.m;
          const x = a * e.x + c * e.y + ex;
          const y = b * e.x + d * e.y + ey;
          expect(Math.hypot(x - fp.center.x, y - fp.center.y), info.kind).toBeLessThan(Math.hypot(fp.w, fp.h) / 2 + 1);
        }
      }
    }
  });

  it('издалека движущегося нет: «неподвижное» — вся сцена', () => {
    expect(artMoves(0.5)).toBe(false);
    for (const info of INDUSTRY_LIST) {
      const ind = industry(info);
      for (const zoom of [0.2, 0.4]) expect(paint(ind, zoom, 'still').draws, info.kind).toEqual(paint(ind, zoom, 'all').draws);
    }
  });

  it('«неподвижное» не зависит от времени — его можно держать в кэше', () => {
    for (const info of INDUSTRY_LIST) {
      const ind = industry(info);
      const a = stub();
      const b = stub();
      const colors = (s: ReturnType<typeof stub>, t: number) => {
        const seen: unknown[] = [];
        const ctx = new Proxy(s.ctx as object, {
          get: (o, k) => Reflect.get(o, k),
          set: (o, k, v) => {
            if (k === 'fillStyle') seen.push(v);
            return Reflect.set(o, k, v);
          },
        }) as CanvasRenderingContext2D;
        drawIndustryArt(ctx, ind, 1, t, 'still');
        return seen;
      };
      expect(colors(a, 1), info.kind).toEqual(colors(b, 9.3));
    }
  });
});

describe('Ёмкости на складе грузового двора', () => {
  const fp = { center: { x: 0, y: 0 }, w: 81, h: 56, angle: 0 };

  it.each([0, 1, 300])('зерновые силосы занимают обе половины склада фермы при запасе %i', (grain) => {
    const tanks = vi.spyOn(Art.prototype, 'tank');
    try {
      drawIndustryYardStock(stub().ctx, { fp, id: 3, cargo: { grain } }, industry(INDUSTRY_TYPES.farm), 4, 300);
      expect(tanks.mock.calls).toHaveLength(2);
      const [left, right] = tanks.mock.calls;
      expect(left[0] + left[2]).toBeLessThan(-11);
      expect(right[0] - right[2]).toBeGreaterThan(11);
      expect(left[5]).toBe(grain > 0 ? CARGO.grain.color : '#a1a4a5');
      expect(right[5]).toBe(left[5]);
    } finally {
      tanks.mockRestore();
    }
  });

  it.each([39, 56])('у НПЗ резервуары сырья и продукции разнесены (глубина двора %i м)', (h) => {
    const tanks = vi.spyOn(Art.prototype, 'tank');
    try {
      drawIndustryYardStock(stub().ctx, { fp: { ...fp, h }, id: 3, cargo: { oil: 100, fuel: 200 } }, industry(INDUSTRY_TYPES.refinery), 4, 300);
      expect(tanks.mock.calls).toHaveLength(4);
      const [fuelA, fuelB, oilA, oilB] = tanks.mock.calls;
      expect(fuelB[0] + fuelB[2]).toBeLessThan(-11);
      expect(oilA[0] - oilA[2]).toBeGreaterThan(11);
      expect(fuelB[0] - fuelA[0]).toBeGreaterThan(fuelA[2] + fuelB[2]);
      expect(oilB[0] - oilA[0]).toBeGreaterThan(oilA[2] + oilB[2]);
    } finally {
      tanks.mockRestore();
    }
  });
});
