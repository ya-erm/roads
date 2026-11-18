import { add, dist, scale, type Vec } from '../core/vec';
import type { Game } from '../game/game';
import type { HouseForm, Town, TownBuilding } from '../world/entities';
import { cottagePlan, dachaPlan, LOT_SETBACK } from '../world/houseAccess';
import { lotClearOfRoads } from '../world/lotClear';
import { isTrunk, WALK_EDGE } from '../world/roadTypes';
import { footprintRadius, footprintsOverlap } from '../world/spatial';
import { FORM_NAMES, SETTLE_RULE, stackFolk, yardOf } from '../world/townForms';
import { anchorFor, halfAtS, normalTowards, placeable, recountPopulation } from '../world/worldgen';

export const TEST_BUILDING_FORMS = Object.keys(FORM_NAMES) as HouseForm[];
const RESIDENTIAL = new Set<HouseForm>(['cottage', 'dacha', 'walkup', 'townhouse', 'courtyard', 'slab', 'tower']);

export interface TestBuildingOptions {
  form: HouseForm;
  width: number;
  depth: number;
  floors: number;
  variant: number;
  parking: 'any' | 'garage' | 'pad' | 'none';
  side: 'any' | 'left' | 'right';
  homeSpaces: 1 | 2 | 3;
  garageSpaces: 1 | 2;
  color: string;
  roof: string;
  bays: number;
}

export function defaultTestBuildingOptions(form: HouseForm): TestBuildingOptions {
  const wide = ['slab', 'courtyard', 'market', 'hospital', 'school', 'warehouse', 'depot'].includes(form);
  return { form, width: wide ? 88 : 64, depth: form === 'slab' ? 70 : 64, floors: form === 'tower' ? 12 : form === 'slab' ? 5 : form === 'cottage' || form === 'dacha' || form === 'shop' || form === 'store' ? 1 : 3, variant: 1, parking: 'any', side: 'any', homeSpaces: 1, garageSpaces: 1, color: '#ded3bb', roof: '#ad7055', bays: 3 };
}

/** Варианты используют те же id-хеши и планировки, что и естественная застройка. */
export function testBuildingBlueprint(id: number, options: TestBuildingOptions): TownBuilding {
  const o = options;
  const kind = RESIDENTIAL.has(o.form) ? 'res' : o.form === 'hall' || o.form === 'temple' ? 'landmark' : 'com';
  const b: TownBuilding = {
    type: 'building', id, townId: 0, fp: { center: { x: 0, y: 0 }, w: o.width, h: o.depth, angle: 0 },
    form: o.form, kind, floors: o.floors, anchor: 0, color: o.color, roof: o.roof, face: -1,
    ...(o.form === 'hospital' ? { bays: o.bays } : {}),
    ...(o.form === 'cottage' || o.form === 'dacha' ? { homeSpaces: o.homeSpaces, garageSpaces: Math.min(o.garageSpaces, o.homeSpaces) as 1 | 2 } : {}),
  };
  if (kind === 'res') b.people = o.form === 'cottage' ? o.floors >= 2 ? 6 : 3 : o.form === 'dacha' ? 3 : stackFolk(b);
  return b;
}

export function matchesTestBuilding(b: TownBuilding, o: TestBuildingOptions): boolean {
  if (o.form !== 'cottage' && o.form !== 'dacha') return true;
  const plan = o.form === 'cottage' ? cottagePlan(b) : dachaPlan(b);
  const parking = 'garage' in plan && plan.garage ? 'garage' : plan.pad ? 'pad' : 'none';
  const count = o.parking === 'none' || (plan.spaces.length === o.homeSpaces && (parking !== 'garage' || plan.spaces.filter((s) => s.garage).length === Math.min(o.garageSpaces, o.homeSpaces)));
  return count && (o.parking === 'any' || parking === o.parking) && (o.side === 'any' || plan.left === (o.side === 'left'));
}

/** Получает уникальный id, в том числе при запущенной симуляции; не меняет RNG партии. */
export function nextTestBuilding(game: Game, o: TestBuildingOptions): TownBuilding | null {
  for (let skip = 1; skip < o.variant; skip++) game.nextId();
  for (let attempts = 0; attempts < 2048; attempts++) {
    const b = testBuildingBlueprint(game.nextId(), o);
    if (game.index.items.size && [...game.index.items].some((x) => x.id === b.id)) continue;
    if (matchesTestBuilding(b, o)) return b;
  }
  return null;
}

export interface TestBuildingPlan {
  building: TownBuilding | null;
  ok: boolean;
  label: string;
  town?: Town;
  corridor?: number;
}

/** Тот же отступ от дороги, фасад и проверки участка, что при обычной городской застройке. */
export function planTestBuilding(game: Game, blueprint: TownBuilding, p: Vec): TestBuildingPlan {
  const net = game.roads.net;
  const candidates = net.corridorsNear(p, Math.max(100, blueprint.fp.h + 50)).filter((c) => !isTrunk(c.cls) && !c.ring && net.node(c.a).level === 0 && net.node(c.b).level === 0).map((c) => ({ c, hit: c.lut.closest(p) })).sort((a, b) => a.hit.d - halfAtS(a.c, a.hit.s) - (b.hit.d - halfAtS(b.c, b.hit.s)));
  const at = candidates[0];
  if (!at || at.hit.d > halfAtS(at.c, at.hit.s) + blueprint.fp.h + 40) return { building: null, ok: false, label: 'Поставьте здание рядом с улицей' };
  const n = normalTowards(at.c, at.hit.s, p);
  const t = at.c.lut.tangentAt(at.hit.s);
  const yard = yardOf(blueprint);
  const center = add(at.c.lut.pointAt(at.hit.s), scale(n, halfAtS(at.c, at.hit.s) + Math.max(LOT_SETBACK, WALK_EDGE + 0.5) + blueprint.fp.h / 2 + yard));
  const face: 1 | -1 = -t.y * n.x + t.x * n.y >= 0 ? -1 : 1;
  const town = game.towns.slice().sort((a, b) => dist(a.center, center) - dist(b.center, center))[0];
  const building: TownBuilding = { ...blueprint, townId: town?.id ?? 0, fp: { ...blueprint.fp, center, angle: Math.atan2(t.y, t.x) }, anchor: anchorFor(net, center), face };
  const lot = { ...building.fp, w: building.fp.w + yard * 2, h: building.fp.h + yard * 2 };
  const fail = (label: string): TestBuildingPlan => ({ building, ok: false, label, town, corridor: at.c.id });
  if (!placeable({ roads: net, terrain: game.terrain, index: game.index, rng: game.rng, nextId: () => 0, rail: game.net }, lot, at.c.id)) return fail('Здесь недостаточно свободного места');
  if (!lotClearOfRoads(net, lot, WALK_EDGE)) return fail('Участок пересекает дорогу или тротуар');
  if (game.towns.some((x) => (x.parks ?? []).some((park) => footprintsOverlap(lot, park.fp, 2)) || (x.lots ?? []).some((parking) => !parking.removed && footprintsOverlap(lot, parking.fp, 2)))) return fail('Участок занят парком или парковкой');
  return { building, ok: true, label: `${FORM_NAMES[blueprint.form!]} · установить · Esc или правый клик — отмена`, town, corridor: at.c.id };
}

/** Только тестовые сцены: без оплаты, c обычными данными домов, подъездов и стоянок. */
export function placeTestBuilding(game: Game, plan: TestBuildingPlan): TownBuilding | null {
  if (!plan.ok || !plan.building) return null;
  const b = plan.building;
  // Проверяем занятость ещё раз: между превью и кликом симуляция могла продолжиться.
  if (game.index.overlaps(b.fp, 2)) return null;
  let town = plan.town;
  if (!town) {
    const id = Math.max(0, ...game.towns.map((t) => t.id)) + 1;
    town = { id, name: 'Тестовый район', center: { ...b.fp.center }, radius: 150, top: b.fp.center.y - b.fp.h, style: 'linear', population: 0, buildings: [], streets: [], demands: [], supplied: {}, lastSupplied: {}, tripAcc: 0, growthAcc: 0, autoStreets: false, labelOnly: true, settled: SETTLE_RULE };
    game.towns.push(town);
  }
  b.townId = town.id;
  town.buildings = [...town.buildings, b];
  if (plan.corridor !== undefined && !town.streets.includes(plan.corridor)) town.streets.push(plan.corridor);
  const reach = dist(town.center, b.fp.center) + footprintRadius(b.fp) + 10;
  town.radius = Math.max(town.radius, reach);
  town.extent = Math.max(town.extent ?? 0, reach);
  recountPopulation(town);
  game.index.add(b);
  game.layoutRev++;
  game.townRev++;
  if (b.kind === 'com') game.refreshReceivers(town);
  game.refreshCatchmentsNear(b.fp.center);
  return b;
}
