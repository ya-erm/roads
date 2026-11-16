import { describe, expect, it } from 'vitest';
import type { HouseForm, TownBuilding } from '../world/entities';
import { FORM_NAMES } from '../world/townForms';
import { drawHouseArt, grimy, houseReach, tone } from './houseArt';

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

describe('Налёт от вредных предприятий — серая, но не тёмная крыша', () => {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luma = (hex: string) => {
    const [r, g, b] = rgb(hex);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  const chroma = (hex: string) => Math.max(...rgb(hex)) - Math.min(...rgb(hex));
  /** Крыши панельных домов (townForms.PANEL_COLORS) и частных (worldgen.RES_COLORS) — из баг-репорта и рядом. */
  const ROOFS = ['#868d86', '#8e9398', '#a0907f', '#9c5a46', '#b9654d', '#6f7d8c', '#7d6a8f'];

  it('крыша блёкнет к серому, а яркость почти та же: не темнее 94% даже вплотную к заводу', () => {
    for (const roof of ROOFS) {
      expect(grimy(roof, 0)).toBe(roof);
      for (const g of [0.3, 0.6, 1]) {
        const v = grimy(roof, g);
        expect(v, `${roof} ${g}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(luma(v), `${roof} ${g}`).toBeGreaterThanOrEqual(luma(roof) * 0.94 - 0.5);
        expect(chroma(v), `${roof} ${g}`).toBeLessThanOrEqual(chroma(roof));
      }
      if (chroma(roof) > 20) expect(chroma(grimy(roof, 1))).toBeLessThan(chroma(roof) * 0.4);
    }
  });

  it('панельный дом в налёте: на участок не ложится тёмная пелена — крыша залита серым цветом самой крыши', () => {
    const b = building('slab', { roof: '#868d86', fp: { center: { x: 0, y: 0 }, w: 153, h: 80, angle: 0 }, floors: 9 });
    const fills: string[] = [];
    const { ctx: inner } = stub();
    const ctx = new Proxy(inner as unknown as Record<string, unknown>, {
      set: (t, k, v) => {
        if (k === 'fillStyle') fills.push(String(v));
        t[k as string] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    drawHouseArt(ctx, b, 0.8, undefined, 0.7);
    expect(fills).toContain(grimy('#868d86', 0.7));
    expect(fills).not.toContain('#868d86');
    // Полупрозрачное — только земля двора и тени; тёмного налёта поверх участка (было rgba(78,74,66,…)) нет.
    for (const f of fills) expect(f.startsWith('rgba(78,74,66')).toBe(false);
    // Следующий дом без налёта — с прежней крышей.
    fills.length = 0;
    drawHouseArt(ctx, b, 0.8);
    expect(fills).toContain('#868d86');
  });
});
