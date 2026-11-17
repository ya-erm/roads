import { dot, rightNormal, sub } from '../core/vec';
import { CURB, curbAllowed, curbEndRoom } from '../lanes/curb';
import { besideOffset, type Corridor, type LaneNet, type LaneSlot, taperLen } from '../lanes/model';
import { curbSqueeze } from './curbSqueeze';
import type { Town, TownBuilding } from './entities';
import { PARK_W } from './roadTypes';
import { edgeOf, formOf, inDistrict } from './townForms';
import { landmarkClear, type WorldContext } from './worldgen';
import { slabPlan } from './yardLots';

/**
 * Полосы стоянки на улицах городов сами (docs/PARKING.md, этап 2; WorldSettings.parking — только новые партии): при
 * генерации — центр (edgeOf < CURB_TOWN.centre) с обеих сторон напротив деловых домов, новый район — с одной стороны,
 * где панельки, улицы у рынка и ратуши — со стороны их. Дома у новой кромки ужимают участки (curbSqueeze); где пришлось
 * бы сносить — стоянки с этой стороны нет. Генератор случайных чисел не трогается: мир по seed тот же, кроме этого.
 */
export const CURB_TOWN = {
  /** Центр города — ближе этой доли радиуса (edgeOf). */
  centre: 0.35,
  /** Дома у улицы — ближе стольких ед. к её оси. */
  reach: 70,
};

/**
 * Рост (Game.curbGrow): улица, где за месяц машинам у цели не хватило мест больше чем у short просивших (и просили
 * не меньше ask раз), получает полосу стоянки — одну на город в месяц.
 */
export const CURB_GROW = { ask: 6, short: 0.25 };

/** Дома города вдоль полотна seg по сторонам (1 — справа по a→b): середина участка напротив полотна. */
export function frontage(town: Town, seg: Corridor): Map<1 | -1, TownBuilding[]> {
  const out = new Map<1 | -1, TownBuilding[]>([
    [1, []],
    [-1, []],
  ]);
  const mid = seg.lut.pointAt(seg.length / 2);
  const r = seg.length / 2 + CURB_TOWN.reach;
  for (const b of town.buildings) {
    if (Math.abs(b.fp.center.x - mid.x) > r || Math.abs(b.fp.center.y - mid.y) > r) continue;
    const hit = seg.lut.closest(b.fp.center);
    if (hit.d > CURB_TOWN.reach || hit.s <= 1 || hit.s >= seg.length - 1) continue;
    const side = dot(sub(b.fp.center, hit.point), rightNormal(seg.lut.tangentAt(hit.s))) >= 0 ? 1 : -1;
    out.get(side)!.push(b);
  }
  return out;
}

/** Панелька с карманом у улицы перед фасадом. */
function pocketed(b: TownBuilding): boolean {
  if (b.kind !== 'res') return false;
  const p = slabPlan(b);
  return p.kind === 'along' && p.doors === 'front';
}

/** С каких сторон улицы seg город при генерации ставит стоянку: центр, новый район, рынок и ратуша. */
export function curbSides(town: Town, seg: Corridor): (1 | -1)[] {
  const mid = seg.lut.pointAt(seg.length / 2);
  const front = frontage(town, seg);
  const has = (side: 1 | -1, f: (b: TownBuilding) => boolean) => front.get(side)!.some(f);
  const out: (1 | -1)[] = [];
  for (const side of [1, -1] as const) {
    if (has(side, (b) => formOf(b) === 'market' || formOf(b) === 'hall')) out.push(side);
    else if (edgeOf(town, mid) < CURB_TOWN.centre && has(side, (b) => b.kind === 'com')) out.push(side);
  }
  if (!out.length && inDistrict(town.district, mid)) {
    // Новый район — одна сторона: где панелек больше (поровну — справа). Панелька с карманом у улицы (места перед
    // фасадом, заезд с полосы прямо на место — world/yardLots.slabPlan) не в счёт: её машинам полоса не нужна, а вдоль
    // кармана на полосе и мест бы не было — у каждого заезда их нет (Game.curbSkips).
    const slabs = (side: 1 | -1) => front.get(side)!.filter((b) => formOf(b) === 'tower' || (formOf(b) === 'slab' && !pocketed(b))).length;
    const r = slabs(1);
    const l = slabs(-1);
    if (r || l) out.push(r >= l ? 1 : -1);
  }
  return out;
}

/**
 * Профиль полотна c с полосой стоянки со стороны side: снаружи крайней полосы движения этой стороны, ход — её же (места
 * справа по ходу), на всём полотне с отгонами внутри него — у перекрёстка за его площадкой (curbEndRoom). Нельзя
 * (магистраль, грунтовка, коротко, там уже стоянка, сторона слева по ходу) — null.
 */
export function withCurb(net: LaneNet, c: Corridor, side: 1 | -1): LaneSlot[] | null {
  if (!curbAllowed(c) || c.build) return null;
  const T = taperLen(c.cls);
  const outer = c.lanes.reduce<LaneSlot | null>((best, l) => (l.offset * side > 0 && (!best || l.offset * side > best.offset * side) ? l : best), null);
  if (!outer || outer.park || outer.offset * outer.flow < 0) return null;
  if (outer.from > 0.5 || outer.to < c.length - 0.5) return null;
  const [lo, hi] = curbEndRoom(net, c);
  const from = Math.max(T, lo);
  const to = Math.min(c.length - T, hi);
  if (to - from < 2 * CURB.stallLen + 2 * CURB.nodeRoom) return null;
  return [...c.lanes, { offset: besideOffset(outer, side, PARK_W), flow: outer.flow, from, to, park: true }];
}

/**
 * Полосы стоянки на улицах города town при генерации (curbSides): по каждой улице и стороне — профиль со стоянкой,
 * дома у новой кромки ужимают участки; кого пришлось бы снести — стоянки с этой стороны нет. Площадь вокруг ратуши
 * (landmarkClear) кромка не задевает: задела бы — стоянки с этой стороны тоже нет. Ответ — сколько полос.
 */
export function curbTown(ctx: WorldContext, town: Town): number {
  let added = 0;
  const hall = town.buildings.find((b) => b.kind === 'landmark');
  for (const id of town.streets) {
    const c = ctx.roads.corridors.get(id);
    if (!c) continue;
    for (const side of curbSides(town, c)) {
      const lanes = withCurb(ctx.roads, c, side);
      if (!lanes) continue;
      const was = c.lanes;
      ctx.roads.setLanes(c, lanes);
      const houses = frontage(town, c).get(side)!;
      const res = curbSqueeze(ctx, c, houses);
      if (res.some((x) => !x.fp) || (hall && !landmarkClear(ctx.roads, hall))) {
        ctx.roads.setLanes(c, was);
        continue;
      }
      for (const x of res) {
        ctx.index.remove(x.b);
        x.b.fp = x.fp!;
        ctx.index.add(x.b);
      }
      added++;
    }
  }
  return added;
}
