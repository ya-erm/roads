import { dot, rightNormal, scale, sub, Vec } from '../core/vec';
import { KMH_PER_UNIT } from '../world/roadTypes';
import { corridorUnder } from './edit';
import type { GLane, LaneGraph } from './graph';
import type { Corridor, Flow } from './model';
import { type LaneProfile, PROFILE_STEP } from './speedProfile';

/**
 * Скорость у курсора на карте скоростей (V, инструмент «Выбор»): сколько разрешено на дороге под курсором — числом
 * на знаке. Как и на карте — разрешённая скорость полотна, а на повороте — сниженная изгибом (там, где курсор).
 */

/** Скорость в одном направлении: км/ч и куда по нему едут (единичный вектор по ходу; null — в обе стороны одинаково). */
export interface SpeedReading {
  kmh: number;
  dir: Vec | null;
}

/**
 * Число на знаке, как у знаков на поворотах: разрешённая limitKmh, а где изгиб снижает скорость до curveKmh заметно
 * (больше чем на 5 км/ч) — она, кратно 10 вниз (не меньше 10).
 */
export function signKmh(limitKmh: number, curveKmh: number): number {
  const limit = Math.round(limitKmh);
  if (curveKmh >= limitKmh - 5) return limit;
  // Запас — на округление профиля (он во float32: 20 км/ч там чуть меньше 20).
  return Math.min(limit, Math.max(10, Math.floor((curveKmh + 0.01) / 10) * 10));
}

/** Скорость полосы в u от её начала по ходу, км/ч — как цвет карты скоростей там (шаг профиля, в который попал u). */
export function laneKmhAt(lane: GLane, prof: LaneProfile, u: number): number {
  const k = Math.min(prof.c.length - 1, Math.floor(Math.max(0, Math.min(lane.length, u)) / PROFILE_STEP));
  return signKmh(lane.speed * KMH_PER_UNIT, Math.min(lane.speed, prof.c[k]) * KMH_PER_UNIT);
}

/**
 * Скорости на полотне c в точке оси s, курсор — на lat вправо от оси (по a→b): по каждому направлению, что тут
 * есть, — у полосы, ближайшей к курсору. Первым — направление полосы под курсором. Везде одинаково (и у односторонней) —
 * одно число без стрелки; по направлениям разное — каждое со стрелкой по ходу. Полос тут нет — пусто.
 */
export function speedsAt(graph: LaneGraph, profile: (lane: GLane) => LaneProfile, c: Corridor, s: number, lat: number): SpeedReading[] {
  const found: { kmh: number; flow: Flow; gap: number }[] = [];
  for (const flow of [1, -1] as const) {
    // Связь этого направления через s (на границе двух — первая: скорость полотна там у них одна).
    const link = graph.corridorLinks(c.id).find((l) => l.flow === flow && l.lanes.length && s >= l.s0 - 0.5 && s <= l.s1 + 0.5);
    if (!link) continue;
    let lane = link.lanes[0];
    let gap = Infinity;
    for (const l of link.lanes) {
      const d = Math.abs(l.offset - lat);
      if (d < gap) {
        gap = d;
        lane = l;
      }
    }
    const u = flow > 0 ? s - link.s0 : link.s1 - s;
    found.push({ kmh: laneKmhAt(lane, profile(lane), u), flow, gap });
  }
  if (!found.length) return [];
  found.sort((a, b) => a.gap - b.gap);
  if (found.every((f) => f.kmh === found[0].kmh)) return [{ kmh: found[0].kmh, dir: null }];
  const t = c.lut.tangentAt(s);
  return found.map((f) => ({ kmh: f.kmh, dir: scale(t, f.flow) }));
}

/** Скорости дороги под точкой p (верхнего полотна, если их там несколько, — его и видно); не на дороге — пусто. */
export function speedsUnder(graph: LaneGraph, profile: (lane: GLane) => LaneProfile, p: Vec): SpeedReading[] {
  const c = corridorUnder(graph.net, p);
  if (!c) return [];
  const hit = c.lut.closest(p);
  const lat = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
  return speedsAt(graph, profile, c, hit.s, lat);
}
