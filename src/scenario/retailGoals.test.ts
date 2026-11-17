import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { freshGame } from '../game/testkit';
import type { Town } from '../world/entities';
import { receiverOf } from '../world/retail';
import { DEFAULT_SETTINGS, NEW_GAME_SETTINGS } from '../world/settings';
import { townNeed } from '../world/townSupply';
import { linkEffort, RETAIL_TRIP } from './analysis';
import { assess } from './feasibility';
import { shopsHint } from './generator';
import { goalShops } from './objectives';

/** Этап 4 получателей грузов (docs/RETAIL.md): задания и их оценка с развозкой по магазинам. */

const shopTown = (depot: boolean): Town =>
  ({
    id: 1,
    receivers: [{ b: 1, cargo: ['food'], w: 1, stock: {}, at: 0 }, ...(depot ? [{ b: 2, cargo: ['food'], w: 0, stock: {}, at: 0, depot: true as const }] : [])],
  }) as unknown as Town;

describe('Задания: развозка по магазинам', () => {
  it('перевозка в магазины весит ×1,3; с оптовой базой дальняя — подвоз на базу и короткая развозка', () => {
    const on = { retail: true };
    expect(linkEffort({ retail: false }, 2500, shopTown(false), 'food')).toBe(1);
    expect(linkEffort(on, 2500, shopTown(false), 'food')).toBeCloseTo(RETAIL_TRIP.round);
    // Магазины этот груз не берут — как прежде.
    expect(linkEffort(on, 2500, shopTown(false), 'goods')).toBe(1);
    // База: близко — дешевле прямо (1,3 < 1,5), далеко — через базу (5 × 1,3 = 6,5 > 5,5).
    expect(linkEffort(on, 2500, shopTown(true), 'food')).toBeCloseTo(RETAIL_TRIP.round);
    expect(linkEffort(on, 12_500, shopTown(true), 'food')).toBeCloseTo(5 + RETAIL_TRIP.depotLink);
  });

  it('этап A: «Развезти N ед. … по 2 магазинам» — продукция завода первой линии, магазины подсвечены; награда скромнее главной', () => {
    // Партия, где этап A — поставки зерна на пищевой комбинат (scripts: seed 8919, средняя карта).
    const game = new Game({ ...NEW_GAME_SETTINGS, seed: 8919, size: 'medium', scenario: { difficulty: 'normal', challenge: false } });
    const sc = game.scenario!;
    const o = sc.state.objectives.find((x) => x.params.kind === 'deliver' && !!x.params.shops)!;
    expect(o).toBeDefined();
    const p = o.params as Extract<typeof o.params, { kind: 'deliver' }>;
    expect(o.title).toMatch(/^Развезти \d+ ед\. «.+» по 2 магазинам /);
    expect(o.why).toContain('🛒');
    const town = game.towns.find((t) => t.id === p.to!.id)!;
    expect(p.shops).toHaveLength(2);
    for (const b of p.shops!) expect(receiverOf(town, b)?.cargo).toContain(p.cargo);
    // Подсветка на карте — пока задание не выполнено.
    expect([...goalShops(game).keys()].sort()).toEqual([...p.shops!].sort());
    o.status = 'done';
    expect(goalShops(game).size).toBe(0);
    const main = sc.state.objectives.find((x) => x.role === 'main' && x.phase === 0)!;
    expect(o.reward.money ?? 0).toBeLessThan(main.reward.money ?? 0);
  });

  it('«снабжать город»: невыполнимо, если к магазинам не подъехать; подсказка — везти во все магазины', () => {
    const game = freshGame({ ...DEFAULT_SETTINGS, seed: 7, retail: true });
    const t = game.towns.find((x) => x.receivers?.some((r) => !r.depot && r.cargo.includes('food')))!;
    const p = { kind: 'supply' as const, town: t.id, months: 2, needs: 1 };
    expect(assess(game, p, 20).ok).toBe(true);
    (game.docks as unknown as { reachable: () => boolean }).reachable = () => false;
    const all = { ...p, needs: t.demands.length };
    // Потребности без получателей (по-старому) закрыть можно и так — проверяем ту, что у магазинов.
    const v = assess(game, all, 20);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/не подъехать/);
    expect(shopsHint(t)).toContain('«🛒 все магазины»');
  });

  it('рост от снабжения в партии с получателями — по доле привезённого, а не «всё или ничего»', () => {
    const game = freshGame({ ...DEFAULT_SETTINGS, seed: 7, retail: true });
    const t = game.towns.find((x) => x.demands.length >= 2)!;
    const need = townNeed(t.population);
    t.lastSupplied = { [t.demands[0]]: need / 2 };
    expect(game.townSatisfaction(t)).toBeCloseTo(0.5 / t.demands.length);
    t.lastSupplied = Object.fromEntries(t.demands.map((c) => [c, need * 2]));
    expect(game.townSatisfaction(t)).toBe(1);
    // Старая партия — по-прежнему: половина нормы — не в счёт.
    const old = freshGame({ ...DEFAULT_SETTINGS, seed: 7 });
    const u = old.towns.find((x) => x.demands.length >= 2)!;
    u.lastSupplied = { [u.demands[0]]: townNeed(u.population) / 2 };
    expect(old.townSatisfaction(u)).toBe(0);
  });
});
