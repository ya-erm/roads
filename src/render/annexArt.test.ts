import { describe, expect, it } from 'vitest';
import { ANNEX } from '../config';
import { INDUSTRY_LIST, INDUSTRY_TYPES, type IndustryKind } from '../world/cargo';
import type { Annex, Industry } from '../world/entities';
import { annexVariant, annexVariants, drawAnnexArt, tone, type AnnexVariant } from './annexArt';

/** Предприятие вида kind с пристройками с данными id (по оси предприятия, справа от него). */
function industry(kind: IndustryKind, annexIds: number[]): Industry {
  const info = INDUSTRY_TYPES[kind];
  const angle = 0.4;
  const ind = {
    type: 'industry',
    id: 100,
    info,
    name: info.name,
    fp: { center: { x: 0, y: 0 }, w: info.w, h: info.h, angle },
    stock: {},
    output: 0,
    producedMonth: 5,
    producedLast: 5,
    prodAcc: 0,
    level: 2.25,
  } as Industry;
  ind.annexes = annexIds.map(
    (id, k): Annex => ({
      type: 'annex',
      id,
      industryId: ind.id,
      fp: { center: { x: 90, y: k * 50 }, w: info.w * ANNEX.scale, h: info.h * ANNEX.scale, angle },
    }),
  );
  return ind;
}

const variantsOf = (ind: Industry) => (ind.annexes ?? []).map((a) => annexVariant(ind, a));

/** Холст-заглушка: считает вызовы методов рисования, свойства запоминает, все цвета заливки и обводки — копит. */
function stubCanvas() {
  const calls: Record<string, number> = {};
  const colors = new Set<string>();
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) =>
      k in t
        ? t[k]
        : () => {
            calls[String(k)] = (calls[String(k)] ?? 0) + 1;
          },
    set: (t, k, v) => {
      if (k === 'fillStyle' || k === 'strokeStyle') colors.add(String(v));
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, colors };
}

describe('Графика пристроек', () => {
  it('у каждого вида предприятия — не меньше двух разных пристроек', () => {
    for (const info of INDUSTRY_LIST) {
      const list = annexVariants(info.kind);
      expect(list.length, info.kind).toBeGreaterThanOrEqual(2);
      expect(new Set(list).size, info.kind).toBe(list.length);
    }
  });

  it('вид пристройки — по типу предприятия: у фермы теплицы и сушилка, у шахты — ствол и обогатительная фабрика', () => {
    const farm = annexVariants('farm');
    expect(farm).toContain('granary');
    expect(farm).toContain('greenhouse');
    const mine = annexVariants('coalmine');
    expect(mine).toContain('shaft');
    expect(mine).toContain('concentrator');
    expect(farm.filter((v) => mine.includes(v))).toEqual([]);
    expect(annexVariants('ranch')).toContain('cowshed');
    expect(annexVariants('refinery')).toContain('columns');
    expect(annexVariants('steelmill')).toContain('cooling');
    expect(annexVariants('fishery')).toContain('smokehouse');
    // Одна группа — одни и те же пристройки.
    expect(annexVariants('sunflower')).toEqual(farm);
    expect(annexVariants('ironmine')).toEqual(mine);
  });

  it('tone осветляет и затемняет, оставляя цвет в виде #rrggbb', () => {
    expect(tone('#3a3d43', 0)).toBe('#3a3d43');
    expect(tone('#000000', 0.5)).toBe('#808080');
    expect(tone('#ffffff', -0.5)).toBe('#808080');
    expect(tone('#a9a49c', 0.12)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('у пристройки всегда вариант своей группы, один и тот же от кадра к кадру', () => {
    for (const info of INDUSTRY_LIST) {
      const ind = industry(info.kind, [301]);
      const v = annexVariant(ind, ind.annexes![0]);
      expect(annexVariants(info.kind)).toContain(v);
      expect(annexVariant(ind, ind.annexes![0])).toBe(v);
    }
  });

  it('несколько пристроек одного предприятия не повторяют друг друга', () => {
    for (const info of INDUSTRY_LIST) {
      const n = annexVariants(info.kind).length;
      for (let id = 1; id < 60; id++) {
        const ids = Array.from({ length: Math.min(3, n) }, (_, k) => id * 7 + k * 13);
        const vs = variantsOf(industry(info.kind, ids));
        expect(new Set(vs).size, `${info.kind}: ${vs.join(', ')}`).toBe(vs.length);
      }
    }
  });

  it('новая пристройка не меняет вид уже стоящих', () => {
    for (let id = 1; id < 40; id++) {
      const one = variantsOf(industry('farm', [id]));
      const two = variantsOf(industry('farm', [id, id + 50]));
      expect(two[0]).toBe(one[0]);
    }
  });

  it('у разных ферм первые пристройки бывают разными', () => {
    const seen = new Set<AnnexVariant>();
    for (let id = 1; id < 60; id++) seen.add(variantsOf(industry('farm', [id]))[0]);
    expect(seen.size).toBe(annexVariants('farm').length);
  });

  it('каждый вариант рисуется без ошибок на всех приближениях — с тенями и мелочами', () => {
    for (const info of INDUSTRY_LIST) {
      // Подбираем id, при которых пристройка получает каждый из вариантов группы.
      const byVariant = new Map<AnnexVariant, number>();
      for (let id = 1; byVariant.size < annexVariants(info.kind).length && id < 500; id++) {
        const ind = industry(info.kind, [id]);
        byVariant.set(annexVariant(ind, ind.annexes![0]), id);
      }
      expect(byVariant.size, info.kind).toBe(annexVariants(info.kind).length);
      for (const [variant, id] of byVariant) {
        const ind = industry(info.kind, [id]);
        for (const zoom of [0.2, 0.4, 1]) {
          const { ctx, calls, colors } = stubCanvas();
          drawAnnexArt(ctx, ind, ind.annexes![0], zoom, 3);
          expect(calls.fill ?? 0, `${info.kind}/${variant}`).toBeGreaterThan(1);
          expect(calls.save, `${info.kind}/${variant}`).toBe(calls.restore);
          // Цвет, осветлённый дважды (shade от rgb(...)), превращается в NaN — такой кучи не видно.
          expect([...colors].filter((c) => c.includes('NaN')), `${info.kind}/${variant}`).toEqual([]);
        }
      }
    }
  });
});
