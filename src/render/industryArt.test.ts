import { describe, expect, it } from 'vitest';
import { INDUSTRY_LIST } from '../world/cargo';
import type { Industry } from '../world/entities';
import { annexMotion, drawAnnexArt } from './annexArt';
import { artMoves, type ArtLayer, drawEmitters, drawIndustryArt, industryMotion } from './industryArt';

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
      // Излучатели — без save/restore: каждый ставит своё преобразование, в конце — прежнее.
      expect(moves.moves.save ?? 0, info.kind).toBe(0);
      expect(moves.moves.setTransform ?? 0, info.kind).toBe(moves.list.length + 1);
      if (moves.list.length) moving++;
    }
    // Дым, огонь или качалки есть не у всех, но у многих.
    expect(moving).toBeGreaterThan(3);
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
