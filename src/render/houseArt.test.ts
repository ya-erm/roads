import { describe, expect, it } from 'vitest';
import type { HouseForm, TownBuilding } from '../world/entities';
import { FORM_NAMES } from '../world/townForms';
import { drawHouseArt, houseReach, tone } from './houseArt';

/** Холст-заглушка: сколько раз позван каждый метод и какие свойства выставлялись. */
function stub() {
  const calls: Record<string, number> = {};
  const set = new Set<string>();
  const rotations: number[] = [];
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) =>
      k in t
        ? t[k]
        : (...args: unknown[]) => {
            if (k === 'rotate') rotations.push(args[0] as number);
            calls[String(k)] = (calls[String(k)] ?? 0) + 1;
          },
    set: (t, k, v) => {
      set.add(String(k));
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, set, rotations };
}

const FORMS = Object.keys(FORM_NAMES) as HouseForm[];

function building(form: HouseForm, o: Partial<TownBuilding> = {}): TownBuilding {
  const big = ['courtyard', 'slab', 'tower', 'market', 'school', 'hospital', 'office', 'hall', 'temple', 'church'].includes(form);
  return {
    type: 'building',
    id: 41,
    townId: 1,
    fp: { center: { x: 300, y: 200 }, w: form === 'slab' || form === 'tower' ? 70 : big ? 32 : 20, h: big ? 26 : 18, angle: 0.4 },
    kind: form === 'hall' || form === 'temple' ? 'landmark' : ['cottage', 'dacha', 'walkup', 'townhouse', 'courtyard', 'slab', 'tower'].includes(form) ? 'res' : 'com',
    floors: form === 'tower' ? 12 : form === 'slab' ? 5 : 2,
    anchor: 0,
    color: '#efe3cf',
    roof: '#b9654d',
    form,
    face: -1,
    ...o,
  };
}

describe('Дома городов — рисунок по типу застройки', () => {
  it('каждый тип рисуется на любом зуме; издали — немного вызовов, вблизи — с тенями и мелочами', () => {
    for (const form of FORMS) {
      const far = stub();
      drawHouseArt(far.ctx, building(form), 0.15);
      const near = stub();
      drawHouseArt(near.ctx, building(form), 0.8);
      const fine = stub();
      drawHouseArt(fine.ctx, building(form), 2);
      const total = (c: Record<string, number>) => Object.values(c).reduce((s, n) => s + n, 0);
      expect(total(far.calls), form).toBeGreaterThan(2);
      expect(total(near.calls), form).toBeGreaterThan(total(far.calls));
      expect(total(fine.calls), form).toBeGreaterThanOrEqual(total(near.calls));
      // Без размытия и фильтров — их видеокарта считает дорого (коммит 30440ed).
      for (const s of [far, near, fine]) {
        expect(s.set.has('filter'), form).toBe(false);
        expect(s.set.has('shadowBlur'), form).toBe(false);
        expect(s.calls.save).toBe(s.calls.restore);
      }
    }
  });

  it('издали без теней: одна заливка участка и крыши; ближе — тень всех построек одной заливкой', () => {
    const far = stub();
    drawHouseArt(far.ctx, building('cottage'), 0.15);
    expect(far.calls.fill ?? 0).toBe(0);
    expect(far.calls.fillRect).toBeLessThanOrEqual(3);
    const near = stub();
    drawHouseArt(near.ctx, building('cottage'), 0.4);
    expect(near.calls.fill).toBeGreaterThan(1);
  });

  it('улица с другой стороны (face = 1) — сцена повёрнута на пол-оборота, а не отражена', () => {
    const a = stub();
    drawHouseArt(a.ctx, building('cottage'), 1);
    const b = stub();
    drawHouseArt(b.ctx, building('cottage', { face: 1 }), 1);
    expect(b.rotations[0] - a.rotations[0]).toBeCloseTo(Math.PI);
    expect(b.calls.scale ?? 0).toBe(0);
  });

  it('рамка в кэше карты — с тенью: у высотки дальше, у ратуши — ещё и площадь', () => {
    expect(houseReach(building('tower', { floors: 16 }))).toBeGreaterThan(houseReach(building('cottage')) + 20);
    expect(houseReach(building('hall', { floors: 4 }))).toBeGreaterThan(14);
    // Дорожка к крыльцу и съезд доходят до тротуара — за 5 м от участка.
    expect(houseReach(building('cottage'))).toBeGreaterThanOrEqual(5);
  });

  it('тон цвета — снова #rrggbb: его можно тонировать ещё раз', () => {
    expect(tone('#808080', 0.5)).toBe('#c0c0c0');
    expect(tone('#808080', -0.5)).toBe('#404040');
    expect(tone(tone('#b9654d', 0.2), -0.2)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
