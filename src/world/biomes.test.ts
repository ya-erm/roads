import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { hasMarket, producible } from '../scenario/analysis';
import { BIOME_LIST, BIOMES, BiomeId, biomeForSeed, industryShare, LEGACY_KINDS, townCargo } from './biomes';
import { CargoType, INDUSTRY_LIST, IndustryKind } from './cargo';
import { footprintRadius } from './spatial';
import { DEFAULT_SETTINGS } from './settings';

/** Виды предприятий биома. */
const kindsOf = (id: BiomeId) => new Set(INDUSTRY_LIST.filter((t) => (BIOMES[id].industries[t.kind] ?? 0) > 0).map((t) => t.kind));

/** Груз можно получить в биоме: его делает вид из биома, всё сырьё которого тоже можно получить. */
function makes(kinds: Set<IndustryKind>, cargo: CargoType, seen: ReadonlySet<CargoType> = new Set()): boolean {
  if (seen.has(cargo)) return false;
  const next = new Set(seen).add(cargo);
  return INDUSTRY_LIST.some((t) => kinds.has(t.kind) && t.produces === cargo && t.accepts.every((c) => makes(kinds, c, next)));
}

const world = (biome: BiomeId, seed = 11, size: 'small' | 'medium' = 'small') => new Game({ ...DEFAULT_SETTINGS, seed, size, relief: 'hills', biome });

describe('Биомы: данные', () => {
  it('в каждом биоме цепочки замкнуты: заводу есть откуда взять сырьё, продукции — кому её продать', () => {
    for (const b of BIOME_LIST) {
      const kinds = kindsOf(b.id);
      const wanted = new Set<CargoType>([...b.towns, ...b.extra]);
      for (const t of INDUSTRY_LIST) if (kinds.has(t.kind)) for (const c of t.accepts) wanted.add(c);
      for (const t of INDUSTRY_LIST.filter((x) => kinds.has(x.kind))) {
        expect(makes(kinds, t.produces), `${b.id}: ${t.kind} — нет сырья`).toBe(true);
        expect(wanted.has(t.produces), `${b.id}: ${t.kind} — некому продать ${t.produces}`).toBe(true);
      }
    }
  });

  it('города просят только то, что в биоме можно сделать: у каждого городского груза есть цепочка', () => {
    for (const b of BIOME_LIST) {
      expect(b.towns.length, b.id).toBeGreaterThanOrEqual(3);
      for (const c of [...b.towns, ...b.extra]) expect(makes(kindsOf(b.id), c), `${b.id}: ${c}`).toBe(true);
    }
  });

  it('биомы разные: у каждого свои грузы, которых нет в других биомах', () => {
    const own: Record<BiomeId, CargoType[]> = {
      temperate: ['flax', 'clay'],
      taiga: ['fish', 'paper'],
      steppe: ['wool', 'sunflower'],
      mountains: ['gems', 'copperore', 'copper'],
      desert: ['cotton'],
    };
    for (const b of BIOME_LIST) {
      const kinds = kindsOf(b.id);
      for (const c of own[b.id]) {
        expect(makes(kinds, c), `${b.id}: ${c}`).toBe(true);
        for (const other of BIOME_LIST.filter((x) => x.id !== b.id)) expect(makes(kindsOf(other.id), c), `${other.id} не должен делать ${c}`).toBe(false);
      }
    }
    // Каждому биому чего-то из средней полосы не хватает (кроме самой средней полосы).
    for (const b of BIOME_LIST.filter((x) => x.id !== 'temperate')) expect([...LEGACY_KINDS].some((k) => !kindsOf(b.id).has(k)), b.id).toBe(true);
  });

  it('старый мир без биома — прежние предприятия и потребности; средняя полосы новой партии — ещё лён и глина', () => {
    expect(industryShare({}, 'farm')).toBe(1);
    expect(industryShare({}, 'flaxfarm')).toBe(0);
    expect(industryShare({ biome: 'temperate' }, 'flaxfarm')).toBeGreaterThan(0);
    expect(townCargo({}).extra).toEqual(['glass', 'furniture']);
    const g = new Game({ ...DEFAULT_SETTINGS, seed: 5, size: 'small' });
    expect(g.terrain.biome).toBe('temperate');
    expect(g.industries.every((i) => LEGACY_KINDS.has(i.info.kind))).toBe(true);
    expect(g.towns.flatMap((t) => t.demands).every((c) => ['food', 'goods', 'fuel', 'construction', 'glass', 'furniture'].includes(c))).toBe(true);
  });

  it('биом по seed: тот же seed — тот же биом, по разным seed выпадают все пять', () => {
    expect(biomeForSeed(12345)).toBe(biomeForSeed(12345));
    const seen = new Map<BiomeId, number>();
    for (let s = 1; s <= 500; s++) seen.set(biomeForSeed(s * 7919), (seen.get(biomeForSeed(s * 7919)) ?? 0) + 1);
    expect(seen.size).toBe(5);
    for (const n of seen.values()) expect(n).toBeGreaterThan(60);
  });
});

describe('Биомы: генерация мира', () => {
  for (const b of BIOME_LIST) {
    it(`${b.name}: мир генерируется, все цепочки и потребности выполнимы`, () => {
      const g = world(b.id);
      expect(g.towns.length).toBeGreaterThan(3);
      const kinds = kindsOf(b.id);
      for (const i of g.industries) {
        expect(kinds.has(i.info.kind), `${i.info.kind} не из биома`).toBe(true);
        expect(hasMarket(g, i), `${i.name}: некуда сбыть`).toBe(true);
        for (const c of i.info.accepts) expect(producible(g, c), `${i.name}: нет ${c}`).toBe(true);
      }
      for (const t of g.towns) {
        expect(t.demands.length, t.name).toBeGreaterThanOrEqual(2);
        for (const c of t.demands) expect(producible(g, c), `${t.name}: ${c}`).toBe(true);
      }
    });
  }

  it('тайга лесистее и озёрнее средней полосы, в степи и пустыне деревьев мало, горы выше', () => {
    const seed = 21;
    const t = world('temperate', seed);
    const taiga = world('taiga', seed);
    expect(taiga.terrain.trees.length).toBeGreaterThan(t.terrain.trees.length * 1.5);
    expect(taiga.terrain.lakes.length).toBeGreaterThanOrEqual(t.terrain.lakes.length);
    expect(world('steppe', seed).terrain.trees.length).toBeLessThan(t.terrain.trees.length * 0.5);
    expect(world('desert', seed).terrain.trees.length).toBeLessThan(t.terrain.trees.length * 0.3);
    expect(world('mountains', seed).terrain.amplitude).toBeGreaterThan(t.terrain.amplitude);
  });

  it('рыбаки стоят у воды', () => {
    const g = world('taiga', 3, 'medium');
    const fishers = g.industries.filter((i) => i.info.kind === 'fishery');
    expect(fishers.length).toBeGreaterThan(0);
    const shore = fishers.filter((i) => g.terrain.isWater(i.fp.center, footprintRadius(i.fp) + 130));
    expect(shore.length).toBeGreaterThanOrEqual(Math.ceil(fishers.length * 0.75));
  });

  it('биом переживает сохранение: та же земля, те же предприятия', () => {
    const g = world('desert', 8);
    const loaded = new Game(g.settings, JSON.parse(JSON.stringify(g.toSave())));
    expect(loaded.terrain.biome).toBe('desert');
    expect(loaded.terrain.trees.length).toBe(g.terrain.trees.length);
    expect(loaded.industries.map((i) => i.info.kind)).toEqual(g.industries.map((i) => i.info.kind));
    expect(loaded.towns.map((t) => t.demands)).toEqual(g.towns.map((t) => t.demands));
  });
});
