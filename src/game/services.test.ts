import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { serviceCall, SERVICE_KINDS, SERVICE_TRAFFIC, type ServiceKind } from './services';
import { runSeconds } from './testkit';

describe('Спецтранспорт городов', { timeout: 60_000 }, () => {
  it('выезды — по seed партии: те же номер и город — та же машина; все три службы, мигалка — у части', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const kinds = new Map<ServiceKind, number>();
    let sirens = 0;
    let calls = 0;
    for (let n = 1; n <= 300; n++) {
      const call = serviceCall(game.seed, town, n);
      expect(serviceCall(game.seed, town, n)).toEqual(call);
      if (!call) continue;
      calls++;
      kinds.set(call.kind, (kinds.get(call.kind) ?? 0) + 1);
      if (call.siren) sirens++;
      expect(call.from.townId).toBe(town.id);
      expect(call.to.townId).toBe(town.id);
    }
    expect(calls).toBeGreaterThan(250);
    for (const k of SERVICE_KINDS) expect(kinds.get(k) ?? 0).toBeGreaterThan(10);
    expect(sirens / calls).toBeGreaterThan(SERVICE_TRAFFIC.sirenShare - 0.12);
    expect(sirens / calls).toBeLessThan(SERVICE_TRAFFIC.sirenShare + 0.12);
    // Другая партия — другие выезды.
    const other = Array.from({ length: 20 }, (_, i) => serviceCall(game.seed + 1, town, i + 1)?.to.id);
    const mine = Array.from({ length: 20 }, (_, i) => serviceCall(game.seed, town, i + 1)?.to.id);
    expect(other).not.toEqual(mine);
  });

  it('в партии спецмашины выезжают сами, по городу; партия повторяется точь-в-точь, общий генератор не сбит', () => {
    const play = () => {
      const game = new Game(7);
      const seen = new Map<number, string>();
      runSeconds(game, 90, () => {
        for (const v of game.traffic.vehicles.values()) {
          const kind = game.serviceOfSim(v.id);
          if (kind && !seen.has(v.id)) seen.set(v.id, `${kind}${v.siren ? '!' : ''}@${Math.round(v.pos.x)},${Math.round(v.pos.y)}`);
        }
      });
      return { game, seen: [...seen.values()] };
    };
    const a = play();
    expect(a.seen.length).toBeGreaterThan(2);
    expect(a.seen.some((s) => s.includes('!'))).toBe(true);
    expect(a.game.serviceCars).toBeLessThanOrEqual(SERVICE_TRAFFIC.maxCars);
    const calls = a.game.towns.reduce((n, t) => n + (t.serviceCalls ?? 0), 0);
    expect(calls).toBeGreaterThanOrEqual(a.seen.length);
    const b = play();
    expect(b.seen).toEqual(a.seen);
    expect(b.game.rng.seedState).toBe(a.game.rng.seedState);
    // Машин в потоке — столько же, сколько им числится (доехавшие и потерявшиеся сняты со счёта).
    const live = [...a.game.traffic.vehicles.values()].filter((v) => a.game.serviceOfSim(v.id)).length;
    expect(live).toBe(a.game.serviceCars);
  });

  it('счётчик выездов — в сохранении; старое сохранение без него открывается и выезды идут', () => {
    const game = new Game(7);
    runSeconds(game, 20);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(loaded.towns.map((t) => t.serviceCalls ?? 0)).toEqual(game.towns.map((t) => t.serviceCalls ?? 0));
    for (const t of save.towns) {
      delete t.serviceAcc;
      delete t.serviceCalls;
    }
    const old = new Game(save.settings, save);
    runSeconds(old, 60);
    expect(old.towns.reduce((n, t) => n + (t.serviceCalls ?? 0), 0)).toBeGreaterThan(0);
  });

  it('карточка машины: спецмашина узнаётся — какая служба', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const call = Array.from({ length: 50 }, (_, i) => serviceCall(game.seed, town, i + 1)).find((c) => c)!;
    const sim = game.spawnService('fire', true, call.from.anchor, call.to.anchor)!;
    expect(sim).not.toBeNull();
    expect(game.serviceOfSim(sim.id)).toBe('fire');
    expect(sim.siren).toBe(true);
    expect(sim.body).toBe('fire');
  });
});
