import { LaneGraph } from './graph';
import { LaneNet } from './model';

/**
 * Стоп-линии и стрелки поворотов в предпросмотре правки дорог («Двигать», стройка): у перекрёстков, которые правка
 * меняет, — по графу движения сети с правкой, у остальных — по графу игры. Граф всей сети с правкой на каждый кадр
 * протяжки — дорого, поэтому он строится только вокруг этих перекрёстков (`localGraph`).
 */
export interface JunctionPreview {
  /** Сеть с правкой. */
  net: LaneNet;
  /** Перекрёстки, у которых правка поменяла подъезды (в net). */
  nodes: Set<number>;
  /** Граф движения вокруг них; null — таких нет. */
  graph: LaneGraph | null;
}

/** Настройки перекрёстка, от которых зависят его обрезы и манёвры (при правке объекты заменяются целиком). */
const SETTINGS = ['corners', 'bans', 'lanes', 'mainPair', 'control', 'roundabout'] as const;

/**
 * Перекрёстки сети next (копии before с правкой), у которых поменялись подъезды: узел новый или стал перекрёстком,
 * другие полотна, их форма или полосы, место узла, настройки (скругления углов, запреты, связи полос).
 */
export function changedJunctions(before: LaneNet, next: LaneNet): Set<number> {
  const res = new Set<number>();
  for (const n of next.nodes.values()) {
    if (n.kind !== 'junction') continue;
    const old = before.nodes.get(n.id);
    const same =
      !!old &&
      old.kind === n.kind &&
      old.pos.x === n.pos.x &&
      old.pos.y === n.pos.y &&
      old.corridors.length === n.corridors.length &&
      n.corridors.every((id) => old.corridors.includes(id) && before.corridors.get(id)?.rev === next.corridors.get(id)?.rev) &&
      SETTINGS.every((k) => old[k] === n[k]);
    if (!same) res.add(n.id);
  }
  return res;
}

/** Граф движения только у перекрёстков ids сети net: их полотна и узлы на других концах; обрезы — как во всей сети (cuts). */
export function localGraph(net: LaneNet, ids: Set<number>, cuts: Map<number, [number, number]>): LaneGraph {
  const corridors = new Set<number>();
  for (const id of ids) for (const c of net.nodes.get(id)?.corridors ?? []) corridors.add(c);
  const nodes = new Set(ids);
  for (const id of corridors) {
    const c = net.corridor(id);
    nodes.add(c.a);
    nodes.add(c.b);
  }
  const piece = LaneNet.fromJSON({
    nextId: 0,
    nodes: [...nodes].map((id) => {
      const { corridors: _, ...n } = net.node(id);
      return n;
    }),
    corridors: [...corridors].map((id) => {
      const { lut: _l, length: _n, rev: _r, ...c } = net.corridor(id);
      return c;
    }),
  });
  return new LaneGraph(piece, cuts);
}

/** Предпросмотр сети next поверх before; null — это та же сеть. cuts — обрезы у перекрёстков сети next. */
export function junctionPreview(before: LaneNet, next: LaneNet, cuts: () => Map<number, [number, number]>): JunctionPreview | null {
  if (next === before) return null;
  const nodes = changedJunctions(before, next);
  return { net: next, nodes, graph: nodes.size ? localGraph(next, nodes, cuts()) : null };
}

/** Стоп-линии и стрелки этого перекрёстка графа игры не рисуем: в предпросмотре он другой (или его уже нет). */
export const previewHides = (p: JunctionPreview | null, id: number) => !!p && (p.nodes.has(id) || p.net.nodes.get(id)?.kind !== 'junction');
