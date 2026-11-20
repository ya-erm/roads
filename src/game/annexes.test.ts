import { describe, expect, it } from 'vitest';
import { ANNEX, COST, MONTH_LENGTH } from '../config';
import { add, type Vec } from '../core/vec';
import { annexHtml } from '../ui/annexUi';
import type { Industry } from '../world/entities';
import { INDUSTRY_MODULES, industryOutputCapacity, type IndustryModule } from '../world/industryModules';
import { sitePoint } from '../world/industrySites';
import { annexZone, growthCap } from './annexes';
import { Game } from './game';
import { freshGame, stationAtIndustry, withoutCitizens } from './testkit';

function setup() {
  const game = withoutCitizens(freshGame(7));
  game.money = 5_000_000;
  const farm = game.industries.find((i) => i.info.kind === 'farm')!;
  return { game, farm };
}

function freeSpot(game: Game, ind: Industry, kind: IndustryModule): Vec {
  for (let y = -2.9; y <= 2.7; y += 0.19) {
    for (let x = -3.6; x <= 2.5; x += 0.19) {
      const p = sitePoint(ind.fp, [x, y]);
      if (game.annexPlan(ind.id, p, kind).ok) return p;
    }
  }
  throw new Error('Нет подходящего участка с подъездом');
}

const grow = (game: Game) => (game as unknown as { growIndustries(): void }).growIndustries();

describe('Секции предприятий', () => {
  it('естественный рост ограничен ×2 без производственных секций', () => {
    const { game, farm } = setup();
    expect(stationAtIndustry(game, farm, sitePoint(farm.fp, [2, 0.29]))).toBeDefined();
    (game as unknown as { routed(): boolean }).routed = () => true;
    farm.level = 1.75;
    farm.streak = 1;
    for (let i = 0; i < 5; i++) {
      farm.producedLast = 40;
      farm.piledMonth = 0;
      grow(game);
    }
    expect(farm.level).toBe(ANNEX.base);
    expect(growthCap(farm)).toBe(ANNEX.base);
  });

  it('поле доступно сразу, меняет фактический выпуск и предел роста', () => {
    const { game, farm } = setup();
    expect(annexHtml(farm)).toContain('data-module="field"');
    expect(annexHtml(farm)).toContain('data-module="warehouse"');
    expect(annexHtml(farm)).not.toContain('data-module="pit"');
    const money = game.money;
    const rate = game.industryRate(farm);
    const p = freeSpot(game, farm, 'field');
    expect(game.buildAnnex(farm.id, p, 'field')).toBeNull();
    expect(game.money).toBe(money - INDUSTRY_MODULES.field.cost);
    expect(farm.annexes?.[0]?.connector?.length).toBeGreaterThan(1);
    expect(farm.level ?? 1).toBe(1);
    expect(Math.abs(game.industryRate(farm) - rate * 1.25)).toBeLessThanOrEqual(1);
    expect(growthCap(farm)).toBe(ANNEX.base + 1);
    expect(game.structureAt(p)).toMatchObject({ type: 'annex', industryId: farm.id, module: 'field' });
  });

  it('не даёт построить секцию неподходящего типа, вдали и поверх фермы', () => {
    const { game, farm } = setup();
    expect(game.annexPlan(farm.id, farm.fp.center, 'pit').reason).toBe('Секция не подходит этому предприятию');
    const far = add(farm.fp.center, { x: annexZone(farm) + 50, y: 0 });
    expect(game.annexPlan(farm.id, far, 'field').reason).toBe('Секция должна быть рядом с предприятием');
    expect(game.annexPlan(farm.id, farm.fp.center, 'field').reason).toBe('Мешает предприятие');
  });

  it('склад увеличивает запас без изменения выпуска и не уничтожает груз при заполненной станции', () => {
    const { game, farm } = setup();
    const st = stationAtIndustry(game, farm, sitePoint(farm.fp, [2, 0.29]))!;
    expect(st).toBeDefined();
    const production = game as unknown as { routed(): boolean; updateIndustries(dt: number): void };
    production.routed = () => true;
    const rate = game.industryRate(farm);
    const base = industryOutputCapacity(farm);
    const p = freeSpot(game, farm, 'warehouse');
    expect(game.buildAnnex(farm.id, p, 'warehouse')).toBeNull();
    expect(industryOutputCapacity(farm)).toBe(base + 200);
    expect(game.industryRate(farm)).toBe(rate);
    expect(growthCap(farm)).toBe(ANNEX.base);
    st.cargo[farm.info.produces] = game.stationStorage(st);
    farm.output = base + 195;
    production.updateIndustries(MONTH_LENGTH);
    expect(farm.output).toBe(base + 200);
    expect(game.removeAnnex(farm.annexes![0])).toBeNull();
    production.updateIndustries(MONTH_LENGTH);
    expect(farm.output).toBe(base + 200);
  });

  it('снос производственной секции возвращает часть цены и снижает выросший уровень', () => {
    const { game, farm } = setup();
    const p = freeSpot(game, farm, 'field');
    game.buildAnnex(farm.id, p, 'field');
    farm.level = 2.75;
    const money = game.money;
    expect(game.removeAnnex(farm.annexes![0])).toBeNull();
    expect(farm.annexes).toEqual([]);
    expect(farm.level).toBe(ANNEX.base);
    expect(game.money).toBe(money + Math.round(INDUSTRY_MODULES.field.cost * COST.refundRatio));
    expect(game.structureAt(p)?.type).not.toBe('annex');
  });

  it('отмена, повтор и сохранение сохраняют тип секции и её подъезд', () => {
    const { game, farm } = setup();
    const money = game.money;
    const p = freeSpot(game, farm, 'field');
    game.buildAnnex(farm.id, p, 'field');
    const connector = farm.annexes?.[0]?.connector;
    expect(game.undo()).toBe('секция предприятия');
    expect(game.money).toBe(money);
    expect(game.structureAt(p)?.type).not.toBe('annex');
    expect(game.redo()).toBe('секция предприятия');
    const loaded = withoutCitizens(new Game(game.settings, JSON.parse(JSON.stringify(game.toSave()))));
    const lf = loaded.industries.find((i) => i.id === farm.id)!;
    expect(lf.annexes).toHaveLength(1);
    expect(lf.annexes?.[0]).toMatchObject({ module: 'field', connector });
    expect(growthCap(lf)).toBe(ANNEX.base + 1);
    expect(loaded.structureAt(p)).toMatchObject({ type: 'annex', industryId: farm.id });
  });
});
