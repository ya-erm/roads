import { describe, expect, it } from 'vitest';
import { runUntil } from '../game/testkit';
import { buildIndustryStationScene, INDUSTRY_STATION_LOAD, type IndustryStationOptions } from './industryStations';

describe('Сцена автостанций предприятий', () => {
  it.each([
    { access: 'shared', bays: 2, load: 'high', inGates: 1, outGates: 1, both: 1 },
    { access: 'split', bays: 4, load: 'medium', inGates: 1, outGates: 1, both: 0 },
    { access: 'dual', bays: 8, load: 'low', inGates: 2, outGates: 2, both: 2 },
  ] as const)('$access: $bays постов, нагрузка $load', ({ access, bays, load, inGates, outGates, both }) => {
    const options: IndustryStationOptions = { access, bays, load };
    const { game, yard, errors, stats, tick } = buildIndustryStationScene(options);
    expect(errors).toEqual([]);
    expect(yard?.bays).toBe(bays);
    expect(game.fleet.size).toBe(INDUSTRY_STATION_LOAD[load].vehicles);
    expect(new Set([...game.fleet.values()].map((v) => v.model))).toEqual(new Set(['truck', 'truck2', 'truck3']));
    expect(game.industries.map((i) => i.info.kind)).toEqual(['meatplant', 'farm', 'ranch']);
    expect(game.lines.size).toBe(2);
    const gates = game.stationRoadNodes(yard!).map((id) => ({
      inbound: !!game.roads.graph.inLinks.get(id)?.length,
      outbound: !!game.roads.graph.outLinks.get(id)?.length,
    }));
    expect(gates.filter((gate) => gate.inbound)).toHaveLength(inGates);
    expect(gates.filter((gate) => gate.outbound)).toHaveLength(outGates);
    expect(gates.filter((gate) => gate.inbound && gate.outbound)).toHaveLength(both);

    const moved = runUntil(game, 140, () => stats.arrivals >= 3 && stats.departures >= 3 && (load !== 'high' || stats.peakWaiting > 0), tick);
    expect(moved, JSON.stringify(stats)).toBe(true);
  });
});
