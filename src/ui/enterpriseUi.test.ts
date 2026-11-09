import { describe, expect, it } from 'vitest';
import { ENTERPRISE } from '../config';
import { Game } from '../game/game';
import { withoutCitizens } from '../game/testkit';
import { CARGO, INDUSTRY_TYPES } from '../world/cargo';
import { townEdge, workersNeeded } from '../world/enterprise';
import { NEW_GAME_SETTINGS, type WorldSettings } from '../world/settings';
import { depositCardHtml, depositPlace } from './enterpriseUi';

const WORLD: WorldSettings = { ...NEW_GAME_SETTINGS, seed: 7, size: 'small', towns: 5, money: 5_000_000, biome: 'temperate', relief: 'plains' };

/** Свободное месторождение за городами (там добычу можно ставить). */
function freeDeposit(g: Game) {
  const d = g.enterprises.deposits.find((x) => x.used === undefined && g.towns.every((t) => Math.hypot(t.center.x - x.center.x, t.center.y - x.center.y) > townEdge(t) + 200));
  if (!d) throw new Error('нет свободного месторождения');
  return d;
}

describe('карточка месторождения', () => {
  it('клик по пятну выбирает свободное месторождение; занятое — нет', () => {
    const g = withoutCitizens(new Game(WORLD));
    const d = freeDeposit(g);
    expect(g.enterprises.depositAt({ x: d.center.x + 20, y: d.center.y })?.id).toBe(d.id);
    const used = g.enterprises.deposits.find((x) => x.used !== undefined);
    if (used) expect(g.enterprises.depositAt(used.center)?.id).not.toBe(used.id);
  });

  it('что за сырьё, размер, добыча в месяц, рабочие и что строить — с ценой и кнопкой', () => {
    const g = withoutCitizens(new Game(WORLD));
    const d = freeDeposit(g);
    const info = INDUSTRY_TYPES[d.kind];
    const html = depositCardHtml(g, d.id);
    expect(html).toContain(CARGO[info.produces].name);
    expect(html).toContain(depositPlace(d.kind));
    expect(html).toContain(`×${ENTERPRISE.deposits.sizes[d.size].k}`);
    expect(html).toContain(`<b>${g.enterprises.depositYield(d)}</b>`);
    expect(html).toContain(`👷 <b>${workersNeeded(info)}</b>`);
    expect(html).toContain(info.name);
    expect(html).toContain(`data-action="dep-build" data-id="${d.id}"`);
    // Подсказки — свои (data-tip), без системных title.
    expect(html).not.toMatch(/\stitle="/);
  });

  it('у кого перерабатывают — заводы на это сырьё; построили — записка со ссылкой на предприятие', () => {
    const g = withoutCitizens(new Game(WORLD));
    const d = freeDeposit(g);
    const cargo = INDUSTRY_TYPES[d.kind].produces;
    const plants = g.enterprises.kinds().filter((k) => k.accepts.includes(cargo));
    const html = depositCardHtml(g, d.id);
    for (const k of plants) expect(html).toContain(`data-action="ind-build-for" data-id="${k.kind}"`);
    expect(g.enterprises.build(d.kind, d.center, d.angle)).toBeNull();
    expect(d.used).toBeDefined();
    const after = depositCardHtml(g, d.id);
    expect(after).toContain('занято');
    expect(after).toContain(`data-type="industry" data-id="${d.used}"`);
    expect(g.enterprises.depositAt(d.center)?.id).not.toBe(d.id);
  });

  it('добыча на нём — с его богатством; прогноз в месяц по размеру', () => {
    const g = withoutCitizens(new Game(WORLD));
    const d = freeDeposit(g);
    const probe = g.enterprises.depositProbe(d);
    expect(probe.info.kind).toBe(d.kind);
    expect(probe.fp.center).toEqual(d.center);
    expect(probe.richness).toBe(ENTERPRISE.deposits.sizes[d.size].k);
    expect(g.enterprises.depositYield(d)).toBe(Math.round(INDUSTRY_TYPES[d.kind].rate * ENTERPRISE.deposits.sizes[d.size].k));
  });
});
