/**
 * Сеть, открытая для движения: без полотен, что ещё строятся (Corridor.build, режим «Со строительством»). По ней
 * собирается граф движения и рисуются дороги; строящееся рисуется отдельно — чертежом (src/render/constructionArt.ts).
 * Строящихся нет — это та же сеть (режим «Мгновенно» ничего не копирует).
 */
import { scale } from '../core/vec';
import type { LaneNet } from './model';

const cache = new WeakMap<LaneNet, { version: number; open: LaneNet }>();

/** Есть ли в сети строящиеся полотна. */
export function hasBuilding(net: LaneNet): boolean {
  for (const c of net.corridors.values()) if (c.build) return true;
  return false;
}

/**
 * Копия сети без строящихся полотен (кэш по версии сети: стройка меняет версию, когда открывает участок).
 * Перекрёсток, у которого осталась одна дорога, становится её тупиком — как после сноса (edit.ts, bulldoze);
 * узлы, у которых не осталось дорог, уходят.
 */
export function openNet(net: LaneNet): LaneNet {
  const hit = cache.get(net);
  if (hit && hit.version === net.version) return hit.open;
  let open = net;
  if (hasBuilding(net)) {
    open = net.clone();
    const touched = new Set<number>();
    for (const c of net.corridors.values()) {
      if (!c.build) continue;
      open.removeCorridor(c.id);
      touched.add(c.a);
      touched.add(c.b);
    }
    for (const id of touched) {
      const n = open.nodes.get(id);
      if (!n || n.kind !== 'junction' || open.ends(n).length !== 1) continue;
      // Свой объект узла: у копии сети узлы свои, исходный не трогаем.
      const e = open.ends(n)[0];
      open.nodes.set(id, { ...n, kind: 'seam', dir: scale(e.away, -1) });
    }
    open.version = net.version;
  }
  cache.set(net, { version: net.version, open });
  return open;
}
