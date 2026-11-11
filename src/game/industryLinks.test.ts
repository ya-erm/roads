import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game } from './game';
import { industryFlow, type FlowWorld } from './industryLinks';
import { freightRoute, nearestPair, withoutCitizens } from './testkit';

const world = (g: Game): FlowWorld => ({
  lines: g.lines.values(),
  stations: g.stations,
  industries: g.industries,
  towns: g.towns,
  freight: (l) => g.lineTakes(l, 'freight'),
});

describe('откуда везут сырьё и куда продукцию — по маршрутам', () => {
  it('без маршрута сырьё никто не везёт и продукцию не вывозят', () => {
    const g = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5 }));
    const { b: plant } = nearestPair(g, 'farm', 'foodplant');
    const flow = industryFlow(plant, world(g));
    expect(flow.routed).toBe(false);
    expect(flow.inputs).toEqual([{ cargo: 'grain', from: [] }]);
    expect(flow.output).toEqual({ cargo: 'food', to: [] });
  });

  it('маршрут ферма → комбинат: у комбината зерно с фермы, у фермы зерно на комбинат', () => {
    const g = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5 }));
    const { from: farm, to: plant } = freightRoute(g);
    const p = industryFlow(plant, world(g));
    expect(p.routed).toBe(true);
    expect(p.inputs[0].from).toEqual([{ ref: { type: 'industry', id: farm.id }, name: farm.name }]);
    const f = industryFlow(farm, world(g));
    expect(f.routed).toBe(true);
    expect(f.output.to.map((l) => l.ref)).toEqual([{ type: 'industry', id: plant.id }]);
    // Заброшенный поставщик не везёт.
    farm.ruin = true;
    expect(industryFlow(plant, world(g)).inputs[0].from).toEqual([]);
  });

  it('пассажирский маршрут груз не возит — не в счёт', () => {
    const g = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5 }));
    const { to: plant } = freightRoute(g);
    const flow = industryFlow(plant, { ...world(g), freight: () => false });
    expect(flow.routed).toBe(false);
    expect(flow.inputs[0].from).toEqual([]);
  });
});
