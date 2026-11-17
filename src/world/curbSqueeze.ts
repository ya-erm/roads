import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { edgesAt } from '../lanes/geometry';
import type { Corridor } from '../lanes/model';
import type { TownBuilding } from './entities';
import { ROAD_MARGIN } from './roadTypes';
import { footprintCorners, type Footprint } from './spatial';
import { placeable, type WorldContext } from './worldgen';

/**
 * Полоса стоянки на застроенной улице (docs/PARKING.md, этап 2): дома, на которые налезла новая кромка, сначала ужимают
 * участок — фасад отступает от улицы, задняя граница уходит вглубь не больше SQUEEZE.back (≈ 6 м), если за ней свободно
 * (placeable); не вышло — участок мельче, если он глубокий (остаётся не меньше SQUEEZE.minDepth). Иначе — дом под снос.
 * Предпросмотр: зелёный — всё помещается, жёлтый — участки ужимаются, красный — снос.
 */
export const SQUEEZE = {
  /** Задняя граница — не дальше стольких ед. вглубь (≈ 6 м; единица — 0,6 м). */
  back: 10,
  /** Участок не мельче стольких ед. после ужатия. */
  minDepth: 12,
  /** От кромки асфальта до фасада — не меньше стольких ед. (как при отодвигании домов, Game.roadWidened). */
  gap: 3,
};

/** Что станет с домом: новый контур или снос (fp — null). */
export interface Squeeze {
  b: TownBuilding;
  fp: Footprint | null;
}

/** Кромка асфальта с одной стороны полотна (side > 0 — справа по a→b) в s, с обочиной. */
function sideEdge(c: Corridor, s: number, side: number): number {
  const e = edgesAt(c, s);
  return (e ? Math.max(0, side > 0 ? e[1] : -e[0]) : 0) + ROAD_MARGIN;
}

/**
 * Дома у полотна seg (в сети после правки), на которые налезает его кромка, — как их ужать или снести. houses — дома
 * рядом (их и проверяет): перед проверкой места каждый на время убирается из ctx.index, потом возвращается.
 */
export function curbSqueeze(ctx: WorldContext, seg: Corridor, houses: readonly TownBuilding[]): Squeeze[] {
  const out: Squeeze[] = [];
  for (const b of houses) {
    if (b.kind === 'landmark') continue;
    const corners = footprintCorners(b.fp);
    // Глубже всего кромка заходит на угол дома: по его проекции на ось — кромка своей стороны там.
    let need = 0;
    let dir: Vec | null = null;
    const mid = seg.lut.closest(b.fp.center);
    if (mid.s <= 1 || mid.s >= seg.length - 1) continue;
    const side = Math.sign(dot(sub(b.fp.center, mid.point), rightNormal(seg.lut.tangentAt(mid.s)))) || 1;
    for (const p of corners) {
      const hit = seg.lut.closest(p);
      const lat = dot(sub(p, hit.point), rightNormal(seg.lut.tangentAt(hit.s))) * side;
      if (lat < 0) continue;
      const over = sideEdge(seg, hit.s, side) + SQUEEZE.gap - lat;
      if (over > need) need = over;
    }
    if (need <= 0.05) continue;
    need += 0.5;
    const away = scale(rightNormal(seg.lut.tangentAt(mid.s)), side);
    dir = away;
    // Глубина дома — его сторона, что смотрит на улицу.
    const ux = { x: Math.cos(b.fp.angle), y: Math.sin(b.fp.angle) };
    const alongH = Math.abs(dot(dir, { x: -ux.y, y: ux.x })) >= Math.abs(dot(dir, ux));
    const depth = alongH ? b.fp.h : b.fp.w;
    const shaped = (back: number): Footprint => {
      const d = depth - need + back;
      const center = add(b.fp.center, scale(dir!, (need + back) / 2));
      return alongH ? { ...b.fp, center, h: d } : { ...b.fp, center, w: d };
    };
    let fp: Footprint | null = null;
    ctx.index.remove(b);
    for (const back of [Math.min(need, SQUEEZE.back), SQUEEZE.back / 2, 0]) {
      if (back > need + 1e-6 || depth - need + back < SQUEEZE.minDepth) continue;
      const f = shaped(back);
      if (back === 0 || placeable(ctx, f, seg.id)) {
        fp = f;
        break;
      }
    }
    ctx.index.add(b);
    out.push({ b, fp });
  }
  return out;
}
