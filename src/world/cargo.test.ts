import { describe, expect, it } from 'vitest';
import { LEGACY_KINDS } from './biomes';
import { CargoType, consumersOf, FREIGHT, INDUSTRY_LIST, INDUSTRY_TYPES, producersOf, TOWN_CARGO } from './cargo';

const kinds = (list: { kind: string }[]) => list.map((t) => t.kind).sort();
/** Только предприятия старых миров (до биомов). */
const legacy = <T extends { kind: (typeof INDUSTRY_LIST)[number]['kind'] }>(list: T[]) => list.filter((t) => LEGACY_KINDS.has(t.kind));

describe('Цепочки производства', () => {
  it('у каждого сырья есть производитель, у каждого груза — получатель', () => {
    for (const c of FREIGHT) {
      expect(producersOf(c).length, c).toBeGreaterThan(0);
      expect(consumersOf(c).length + (TOWN_CARGO.includes(c) ? 1 : 0), c).toBeGreaterThan(0);
    }
  });

  it('поставщики завода стоят в списке раньше него: мир расставляет завод ближе к ним', () => {
    INDUSTRY_LIST.forEach((plant, at) => {
      for (const c of plant.accepts) expect(INDUSTRY_LIST.findIndex((t) => t.produces === c), `${plant.kind} ← ${c}`).toBeLessThan(at);
    });
  });

  it('предприятия старых миров — первыми в списке: мир по старому seed расставляет их как раньше', () => {
    const at = INDUSTRY_LIST.findIndex((t) => !LEGACY_KINDS.has(t.kind));
    expect(at).toBe(LEGACY_KINDS.size);
    expect(INDUSTRY_LIST.slice(at).some((t) => LEGACY_KINDS.has(t.kind))).toBe(false);
  });

  it('новые цепочки: скот, песок, стекло и мебель', () => {
    expect(INDUSTRY_TYPES.ranch).toMatchObject({ produces: 'livestock', accepts: [] });
    expect(INDUSTRY_TYPES.sandpit).toMatchObject({ produces: 'sand', accepts: [] });
    expect(INDUSTRY_TYPES.meatplant).toMatchObject({ produces: 'food', accepts: ['livestock', 'grain'] });
    expect(INDUSTRY_TYPES.glassworks).toMatchObject({ produces: 'glass', accepts: ['sand', 'coal'] });
    expect(INDUSTRY_TYPES.furniture).toMatchObject({ produces: 'furniture', accepts: ['planks', 'glass'] });
    expect(INDUSTRY_TYPES.cement).toMatchObject({ produces: 'construction', accepts: ['stone', 'sand'] });
  });

  it('в старых мирах часть сырья нужна двум видам заводов, часть продуктов делают два вида заводов', () => {
    const shared: Partial<Record<CargoType, string[]>> = {
      grain: ['foodplant', 'meatplant'],
      coal: ['glassworks', 'steelmill'],
      planks: ['factory', 'furniture'],
      stone: ['buildmat', 'cement'],
      sand: ['cement', 'glassworks'],
    };
    for (const [c, expected] of Object.entries(shared)) expect(kinds(legacy(consumersOf(c as CargoType))), c).toEqual(expected);
    expect(kinds(legacy(producersOf('food')))).toEqual(['foodplant', 'meatplant']);
    expect(kinds(legacy(producersOf('construction')))).toEqual(['buildmat', 'cement']);
    // Остальное — по-прежнему один к одному: разнообразия немного.
    for (const c of ['logs', 'ore', 'oil', 'livestock', 'steel', 'glass'] as CargoType[]) expect(legacy(consumersOf(c)), c).toHaveLength(1);
  });

  it('продукцию новых цепочек просят города: стекло — ещё и мебельная фабрика, мебель — только города', () => {
    expect(TOWN_CARGO).toEqual(expect.arrayContaining(['glass', 'furniture']));
    expect(kinds(consumersOf('glass'))).toEqual(['furniture']);
    expect(consumersOf('furniture')).toHaveLength(0);
    expect(kinds(producersOf('furniture'))).toEqual(['furniture']);
  });

  it('цепочки биомов: ткани из льна, шерсти и хлопка, украшения из золота и самоцветов, товары и из меди', () => {
    expect(kinds(producersOf('textiles'))).toEqual(['cottonmill', 'linenmill', 'woolmill']);
    expect(kinds(producersOf('jewelry'))).toEqual(['gemcutter', 'jeweler']);
    expect(kinds(producersOf('goods'))).toEqual(['electro', 'factory']);
    expect(kinds(producersOf('food'))).toEqual(['cannery', 'foodplant', 'meatplant', 'oilmill']);
    expect(kinds(producersOf('fuel'))).toEqual(['gasplant', 'refinery']);
    expect(INDUSTRY_TYPES.smelter).toMatchObject({ produces: 'copper', accepts: ['copperore', 'coal'] });
    expect(INDUSTRY_TYPES.electro).toMatchObject({ produces: 'goods', accepts: ['copper', 'steel'] });
    expect(INDUSTRY_TYPES.papermill).toMatchObject({ produces: 'paper', accepts: ['logs'] });
    expect(TOWN_CARGO).toEqual(expect.arrayContaining(['textiles', 'paper', 'jewelry']));
  });
});
