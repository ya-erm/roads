/**
 * Сеть, открытая для движения: без полотен, что ещё строятся (Corridor.build, режим «Со строительством»). По ней
 * собирается граф движения и рисуются дороги; строящееся рисуется отдельно — чертежом (src/render/constructionArt.ts).
 * Строящихся нет — это та же сеть (режим «Мгновенно» ничего не копирует).
 *
 * Перестройка готовой дороги (CorridorBuild.was, src/game/rebuild.ts) — по перекрытию (closure.ts): пока работы не
 * начаты, в сети прежняя дорога; начаты — перекрыта целиком (полотна нет) или по полосам (часть прежних полос, скорость
 * зоны работ); узкая «с проездом» — полосы вне участка под реверсом и полоса встречных по открытой половине в нём
 * (reverseLanes); участок, дошедший до стыка, заходит на соседа — съезд на открытую половину на нём (approachLanes).
 * Полосы соседей, что упёрлись в закрытые, сходят на нет отгоном (taperDeadLanes), как при перестройке.
 *
 * Для карты (view) — та же сеть, но такой, какая она на земле: без отгона у соседей (асфальт готовой дороги у
 * перекрытия не сужается — машины перестраиваются по конусам, их рисует drawClosures), а узкая «с проездом» — прежней
 * дорогой целиком (её не разрытое рисуется поверх стройки, constructionArt.drawOldRoad; полосы встречных в зоне
 * реверса на карте нет — она на той же полосе, что и открытая).
 */
import { scale } from '../core/vec';
import { ROAD_CLASSES } from '../world/roadTypes';
import { type Approach, approachLanes, closureOf, fitLanes, laneWise, partLanes, reverseLanes, type ReverseSite, reverseSite, workSide, zoneLimit } from './closure';
import { taperDeadLanes } from './edit';
import type { Corridor, End, LaneNet } from './model';

const cache = new WeakMap<LaneNet, { version: number; open: LaneNet }>();
const viewCache = new WeakMap<LaneNet, { version: number; open: LaneNet }>();
/** Ревизии прежней дороги в открытой сети: по ревизии полотна в стройке и его перекрытию. */
const revs = new Map<string, number>();

/** Есть ли в сети строящиеся полотна. */
export function hasBuilding(net: LaneNet): boolean {
  for (const c of net.corridors.values()) if (c.build) return true;
  return false;
}

/**
 * Копия сети без строящихся полотен (кэш по версии сети: стройка меняет версию, когда открывает участок).
 * Перекрёсток, у которого осталась одна дорога, становится её тупиком — как после сноса (edit.ts, bulldoze);
 * узлы, у которых не осталось дорог, уходят. Перестраиваемые полотна — прежней дорогой или её частью (closureOf).
 * view — сеть для карты (см. выше): без отгона соседей и без полосы встречных в зоне реверса.
 */
export function openNet(net: LaneNet, view = false): LaneNet {
  const store = view ? viewCache : cache;
  const hit = store.get(net);
  if (hit && hit.version === net.version) return hit.open;
  let open = net;
  if (hasBuilding(net)) {
    open = net.clone();
    const touched = new Set<number>();
    const kept: number[] = [];
    // Соседи за стыками, на которых съезжают на открытую половину перед участком под реверсом (closure.ts, reverseSite).
    const approaches: { c: Corridor; site: ReverseSite; at: End; r: Approach }[] = [];
    for (const c of net.corridors.values()) {
      if (!c.build) continue;
      const k = closureOf(c.build);
      const w = c.build.was;
      if (w && (k === 'old' || k === 'part')) {
        // Своё полотно копии: исходное (с проектом) не трогаем.
        const o = { ...c };
        delete o.build;
        open.corridors.set(c.id, o);
        o.cls = w.cls;
        // По полосам — половина прежних; у улицы в тупик — в обе стороны (развернуться там негде). Узкая «с проездом» —
        // реверс на участке у бригады, вне его — обе стороны.
        // На карте — прежняя дорога целиком: её ещё не разрытое рисуется поверх стройки (constructionArt, drawOldRoad).
        const site = k === 'part' && laneWise(c.build) ? reverseSite(net, c, c.build) : null;
        const zone = site?.zone;
        const lanes = zone ? (view ? fitLanes(w.lanes, w.len, c.length) : reverseLanes(c, c.build, zone)) : k === 'part' ? partLanes(net, c) : fitLanes(w.lanes, w.len, c.length);
        if (k === 'part') o.limit = zoneLimit(w.limit, ROAD_CLASSES[w.cls].limit);
        else if (w.limit === undefined) delete o.limit;
        else o.limit = w.limit;
        open.setLanes(o, lanes);
        // Ревизия — та же для того же полотна и перекрытия: отрисовка и граф движения не пересчитывают его зря.
        keepRev(o, `${c.rev}|${k}|${lanes.length}|${zone ? zone.map((x) => x.toFixed(1)).join(',') : ''}|${view ? 'v' : ''}`);
        kept.push(c.a, c.b);
        if (site && !view) site.reach.forEach((r, i) => r && approaches.push({ c, site, at: i ? 'b' : 'a', r }));
        continue;
      }
      open.removeCorridor(c.id);
      touched.add(c.a);
      touched.add(c.b);
    }
    // Съезд перед участком, дошедшим до стыка, — на соседе: его полосы, что продолжают перекладываемую половину,
    // кончаются раньше, у стыка — полоса встречных (approachLanes). На карте — нет: там асфальт как был.
    for (const { c, site, at, r } of approaches) {
      const cur = open.corridors.get(r.corridor.id);
      if (!cur) continue;
      const o = { ...cur };
      open.corridors.set(o.id, o);
      const lanes = approachLanes(c, c.build!, site.zone, r, at, cur.lanes);
      open.setLanes(o, lanes);
      keepRev(o, `${cur.rev}|near ${c.id}${at}|${workSide(c.build!)}|${lanes.length}|${site.zone.map((x) => x.toFixed(1)).join(',')}`);
      kept.push(o.a, o.b);
    }
    for (const id of touched) {
      const n = open.nodes.get(id);
      if (!n || n.kind !== 'junction' || open.ends(n).length !== 1) continue;
      // Свой объект узла: у копии сети узлы свои, исходный не трогаем.
      const e = open.ends(n)[0];
      open.nodes.set(id, { ...n, kind: 'seam', dir: scale(e.away, -1) });
    }
    // Прежняя дорога (её часть) у стыка с другим профилем: лишние полосы — отгоном, как после перестройки. На карте —
    // нет: асфальт на месте, полоса закрыта конусами и щитом.
    if (kept.length && !view) taperDeadLanes(open, kept);
    open.version = net.version;
  }
  store.set(net, { version: net.version, open });
  return open;
}

/** Ревизия полотна o копии — та же для того же ключа (полотно и его перекрытие): отрисовка и граф его не пересчитывают зря. */
function keepRev(o: Corridor, key: string): void {
  const rev = revs.get(key);
  if (rev === undefined) {
    if (revs.size > 2000) revs.clear();
    revs.set(key, o.rev);
  } else o.rev = rev;
}
