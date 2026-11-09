import type { Vec } from '../core/vec';
import { isDirt } from '../world/roadTypes';
import { turnPaths } from './junctionMarks';
import { LaneNet, LaneNode } from './model';
import { localGraph } from './preview';

/**
 * Колеи по земляной площадке перекрёстка (все подъезды — грунтовые): по траектории каждого манёвра, кроме разворота,
 * — как ездят машины. С каждой полосы подъезда колеи плавно расходятся дугами во все стороны, куда можно повернуть,
 * и продолжают колеи полотен (они — по середине полос, траектории начинаются и кончаются там же).
 * cuts — обрезы подъездов у перекрёстков, как у отрисовки. Не перекрёсток или есть асфальт — колей нет.
 */
export function junctionRuts(net: LaneNet, n: LaneNode, cuts: Map<number, [number, number]>): Vec[][] {
  if (n.kind !== 'junction') return [];
  const ends = net.ends(n);
  if (ends.length < 2 || !ends.every((e) => isDirt(e.corridor.cls))) return [];
  const g = localGraph(net, new Set([n.id]), cuts);
  return turnPaths(g, n.id)
    .filter((p) => p.kind !== 'uturn' && p.points.length > 1)
    .map((p) => p.points);
}
