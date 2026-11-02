import { Cubic, CurveLUT } from '../core/bezier';
import { add, angleDiff, angleOf, dist, rightNormal, scale, sub, Vec } from '../core/vec';
import { ROAD_CLASS_IDS, RoadClass, RoadSpec } from '../world/roadTypes';
import { Anchor, bulldozeInside, corridorUnder, insideRuns, joinDeadEnd, splitCorridor } from './edit';
import { Corridor, LaneNet, LaneNode, LAT_EPS, laneKey, parseLaneKey } from './model';

/**
 * Ж/д пути куска: узлы (стрелки, концы, высота, сигналы — на выезд к каким участкам, oneWay — какие из них
 * запрещают встречное движение) и участки с формой.
 */
export interface RailFragment {
  nodes: { id: number; pos: Vec; level: number; signals?: number[]; oneWay?: number[] }[];
  segs: { id: number; a: number; b: number; curve: Cubic; spec: RoadSpec }[];
}

/**
 * Кусок сети дорог — для копирования и своих шаблонов: узлы и полотна с настройками перекрёстков,
 * координаты — от центра рамки, в которой его взяли.
 */
export interface Fragment {
  nodes: Omit<LaneNode, 'corridors'>[];
  corridors: Omit<Corridor, 'lut' | 'rev'>[];
  /** Половины сторон рамки (всё содержимое — внутри). */
  half: Vec;
  /** Ж/д пути в рамке (у шаблонов, сохранённых раньше, их нет). */
  rail?: RailFragment;
}

/** Куски дорог короче этого у края рамки не берём. */
const MIN = 10;
/** Тупик вставки примыкает к чужому узлу не дальше этого (срез дороги под рамкой бывает чуть за краем). */
const JOIN = 12;

type JunctionSettings = Pick<LaneNode, 'control' | 'mainPair' | 'bans' | 'greens' | 'adaptive' | 'lanes'>;
const SETTINGS = ['control', 'mainPair', 'bans', 'greens', 'adaptive', 'lanes'] as const;

/** Настройки перекрёстка — на новые номера полотен; то, что ссылается на полотна, которых нет, — прочь. */
function remapArms(n: JunctionSettings, map: (id: number) => number | undefined): void {
  const all = (ids: (number | undefined)[]): ids is number[] => ids.every((x) => x !== undefined);
  if (n.bans) {
    n.bans = n.bans.flatMap((k) => {
      const ids = k.split('>').map((x) => map(Number(x)));
      return all(ids) ? [ids.join('>')] : [];
    });
  }
  if (n.mainPair) {
    const ids = n.mainPair.map(map);
    if (all(ids)) n.mainPair = ids;
    else delete n.mainPair;
  }
  if (n.lanes) {
    n.lanes = n.lanes.flatMap((k) => {
      const l = parseLaneKey(k);
      const from = l ? map(l.from) : undefined;
      const to = l ? map(l.to) : undefined;
      return l && from !== undefined && to !== undefined ? [laneKey({ ...l, from, to })] : [];
    });
  }
}

// ---------- Копирование ----------

/**
 * Копия дорог в рамке: полотна, задетые краем, режутся по нему (концы становятся тупиками), кольцо,
 * задетое рамкой, берётся целиком. null — в рамке нет дорог.
 */
export function copyBox(net: LaneNet, x0: number, y0: number, x1: number, y1: number): Fragment | null {
  const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const work = net.clone();
  const keep = new Set<number>();
  const rings = new Set<number>();
  for (const c0 of work.corridorsInBox(x0, y0, x1, y1)) {
    let c: Corridor | null = work.corridors.get(c0.id) ?? null;
    if (!c) continue;
    // Просветы короче MIN (дорога вдоль самого края рамки) — не разрезаем.
    const runs: [number, number][] = [];
    for (const r of insideRuns(c, inside)) {
      const last = runs[runs.length - 1];
      if (last && r[0] - last[1] < MIN) last[1] = r[1];
      else runs.push([...r]);
    }
    if (c.ring) {
      const ring = work.node(c.a).roundabout ?? null;
      if (runs.length && ring !== null) rings.add(ring);
      continue;
    }
    // С конца к началу: разрез у бо́льшего s не сдвигает координаты меньших.
    for (const [sa, sb] of runs.reverse()) {
      if (!c) break;
      if (sb - sa < MIN) continue;
      let piece = c;
      let rest: Corridor | null = null;
      if (sb < c.length - 1) piece = splitCorridor(work, piece, sb, 'seam').first;
      if (sa > 1) {
        const r = splitCorridor(work, piece, sa, 'seam');
        rest = r.first;
        piece = r.second;
      }
      keep.add(piece.id);
      c = rest;
    }
  }
  if (rings.size) {
    for (const c of work.corridors.values()) if (c.ring && rings.has(work.node(c.a).roundabout ?? -1)) keep.add(c.id);
  }
  if (!keep.size) return null;

  const nodeIds = new Set<number>();
  const corridors = [...keep].map((id) => {
    const { lut: _l, length: _n, rev: _r, ...c } = work.corridor(id);
    nodeIds.add(c.a);
    nodeIds.add(c.b);
    return { ...c, curve: { ...c.curve }, lanes: c.lanes.map((l) => ({ ...l })) };
  });
  const nodes = [...nodeIds].map((id) => {
    const { corridors: arms, ...n } = work.node(id);
    const out: Omit<LaneNode, 'corridors'> = { ...n, pos: { ...n.pos }, dir: { ...n.dir } };
    const kept = arms.filter((x) => keep.has(x));
    if (n.kind === 'junction') {
      // Без части дорог фазы светофора — уже другие.
      if (kept.length < arms.length) delete out.greens;
      remapArms(out, (x) => (keep.has(x) ? x : undefined));
    } else if (kept.length === 1) {
      // Съезд, у которого не осталось магистрали: тупик — на месте его полосы.
      const c = corridors.find((k) => k.id === kept[0])!;
      const port = c.a === id ? c.portA : c.portB;
      if (port && c.a !== c.b) {
        out.pos = add(out.pos, scale(rightNormal(out.dir), port));
        if (c.a === id) c.portA = 0;
        else c.portB = 0;
      }
    }
    return out;
  });
  const top = Math.max(...nodes.map((n) => n.id), ...corridors.map((c) => c.id));
  const piece = LaneNet.fromJSON({ nextId: top + 1, nodes, corridors });
  tidy(piece);
  return toFragment(piece, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, { x: (x1 - x0) / 2, y: (y1 - y0) / 2 });
}

/** Края куска: перекрёсток с одной дорогой — её тупик; полосы, оборванные в стыке (съезда больше нет), кончаются чуть раньше. */
function tidy(net: LaneNet): void {
  for (const n of net.nodes.values()) {
    const ends = net.ends(n);
    if (n.kind !== 'junction' || ends.length !== 1) continue;
    n.kind = 'seam';
    n.dir = scale(ends[0].away, -1);
    for (const k of SETTINGS) delete n[k];
  }
  for (const c of net.corridors.values()) {
    for (const end of ['a', 'b'] as const) {
      const e = net.end(c, end);
      if (e.node.kind !== 'seam' || net.isDeadEnd(e.node)) continue;
      const broken = c.lanes.map((l, i) => net.reaches(c, l, end) && !net.across(c, i, end));
      if (!broken.some(Boolean)) continue;
      net.setLanes(
        c,
        c.lanes.map((l, i) => (!broken[i] ? l : end === 'a' ? { ...l, from: 1 } : { ...l, to: c.length - 1 })),
      );
    }
  }
}

/** Сеть куска — в координаты от центра; рамка растёт, если содержимое (кольцо целиком) из неё выходит. */
function toFragment(net: LaneNet, center: Vec, half: Vec): Fragment {
  const rel = (p: Vec) => sub(p, center);
  const save = net.toJSON();
  const box = { ...half };
  const corridors = save.corridors.map((c) => {
    const curve: Cubic = { p0: rel(c.curve.p0), p1: rel(c.curve.p1), p2: rel(c.curve.p2), p3: rel(c.curve.p3) };
    for (const p of [curve.p0, curve.p1, curve.p2, curve.p3]) {
      box.x = Math.max(box.x, Math.abs(p.x));
      box.y = Math.max(box.y, Math.abs(p.y));
    }
    return { ...c, curve, length: net.corridor(c.id).length };
  });
  return { nodes: save.nodes.map((n) => ({ ...n, pos: rel(n.pos) })), corridors, half: box };
}

// ---------- Вставка ----------

/** Точка куска → точка карты: центр куска — в at, поворот на angle (рад). */
export function placer(at: Vec, angle: number): { place: (p: Vec) => Vec; turn: (v: Vec) => Vec } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const turn = (v: Vec) => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos });
  return { turn, place: (p: Vec) => add(at, turn(p)) };
}

/** Углы рамки куска на карте. */
export function frameOf(frag: Fragment, at: Vec, angle: number): Vec[] {
  const { place } = placer(at, angle);
  const { x, y } = frag.half;
  return [place({ x: -x, y: -y }), place({ x, y: -y }), place({ x, y }), place({ x: -x, y })];
}

/** Оси полотен и путей куска на карте — для предпросмотра и значков. */
export function fragmentCurves(frag: Fragment, at: Vec, angle: number): Cubic[] {
  const { place } = placer(at, angle);
  const curves = [...frag.corridors.map((c) => c.curve), ...(frag.rail?.segs.map((s) => s.curve) ?? [])];
  return curves.map((c) => ({ p0: place(c.p0), p1: place(c.p1), p2: place(c.p2), p3: place(c.p3) }));
}

/**
 * Вставка куска: центр — в at, поворот на angle (рад). Дороги под рамкой сносятся (задетые краем —
 * режутся по нему), тупики куска примыкают к оставшимся дорогам рядом. Кольца получают свои номера.
 * Возвращает полотна куска.
 */
export function pasteFragment(net: LaneNet, frag: Fragment, at: Vec, angle: number): Set<number> {
  const { place, turn } = placer(at, angle);
  const back = placer({ x: 0, y: 0 }, -angle).turn;
  const inside = (p: Vec) => {
    const q = back(sub(p, at));
    return Math.abs(q.x) <= frag.half.x && Math.abs(q.y) <= frag.half.y;
  };
  const frame = frameOf(frag, at, angle);
  const xs = frame.map((p) => p.x);
  const ys = frame.map((p) => p.y);
  bulldozeInside(net, inside, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));

  const nodeOf = new Map<number, LaneNode>();
  const ringOf = new Map<number, number>();
  for (const n of frag.nodes) {
    const m = n.kind === 'seam' ? net.addSeam(place(n.pos), turn(n.dir), n.level) : net.addJunction(place(n.pos), n.level);
    nodeOf.set(n.id, m);
    const ring = n.roundabout ?? null;
    if (ring === null) continue;
    if (!ringOf.has(ring)) ringOf.set(ring, net.reserveId());
    m.roundabout = ringOf.get(ring)!;
  }
  const arm = new Map<number, number>();
  for (const c of frag.corridors) {
    const k = net.addCorridor(nodeOf.get(c.a)!.id, nodeOf.get(c.b)!.id, {
      cls: c.cls,
      limit: c.limit,
      ring: c.ring,
      portA: c.portA,
      portB: c.portB,
      curve: { p0: place(c.curve.p0), p1: place(c.curve.p1), p2: place(c.curve.p2), p3: place(c.curve.p3) },
      lanes: c.lanes.map((l) => ({ ...l, to: l.to >= c.length - 0.01 ? Infinity : l.to })),
    });
    arm.set(c.id, k.id);
  }
  for (const n of frag.nodes) {
    if (n.kind !== 'junction') continue;
    const m = nodeOf.get(n.id)!;
    const s: JunctionSettings = { ...n, greens: n.greens && [...n.greens] };
    remapArms(s, (x) => arm.get(x));
    for (const k of SETTINGS) if (s[k] !== undefined) Object.assign(m, { [k]: s[k] });
  }

  const mineN = new Set([...nodeOf.values()].map((m) => m.id));
  const mineC = new Set(arm.values());
  for (const m of nodeOf.values()) {
    if (!net.nodes.has(m.id) || !net.isDeadEnd(m) || m.corridors.length !== 1) continue;
    const target = joinTarget(net, m, mineN, mineC);
    if (target) joinDeadEnd(net, m.id, target);
  }
  return mineC;
}

/** К чему примкнуть тупик m: чужой узел рядом (перекрёсток, тупик, стык без съездов) или чужая дорога под ним. */
function joinTarget(net: LaneNet, m: LaneNode, mineN: Set<number>, mineC: Set<number>): Anchor | null {
  let best: LaneNode | null = null;
  for (const o of net.nodesNear(m.pos, JOIN)) {
    if (mineN.has(o.id) || Math.abs(o.level - m.level) > 0.25) continue;
    if (o.kind === 'seam' && !net.isDeadEnd(o) && !net.ends(o).every((e) => Math.abs(e.port) < LAT_EPS)) continue;
    if (!best || dist(o.pos, m.pos) < dist(best.pos, m.pos)) best = o;
  }
  if (best) return { kind: 'node', node: best.id, pos: best.pos };
  const c = corridorUnder(net, m.pos, 1, m.level, (k) => mineC.has(k.id));
  if (!c) return null;
  const hit = c.lut.closest(m.pos);
  if (Math.abs(net.heightAt(c, hit.s) - m.level) > 0.25 || c.length < MIN * 2) return null;
  const s = Math.max(MIN, Math.min(c.length - MIN, hit.s));
  return { kind: 'corridor', corridor: c.id, s, pos: c.lut.pointAt(s) };
}

// ---------- Прилипание ----------

/** Главная дорога куска: самого высокого класса, из таких — самая длинная; точка у центра и направление там. */
const axes = new WeakMap<Fragment, { cls: RoadClass; p: Vec; dir: Vec } | null>();

export function mainAxis(frag: Fragment): { cls: RoadClass; p: Vec; dir: Vec } | null {
  if (axes.has(frag)) return axes.get(frag)!;
  const rank = (c: RoadClass) => ROAD_CLASS_IDS.indexOf(c);
  let best: Fragment['corridors'][number] | null = null;
  for (const c of frag.corridors) {
    if (c.ring) continue;
    if (!best || rank(c.cls) > rank(best.cls) || (rank(c.cls) === rank(best.cls) && c.length > best.length)) best = c;
  }
  let axis: { cls: RoadClass; p: Vec; dir: Vec } | null = null;
  if (best) {
    const lut = new CurveLUT(best.curve);
    const hit = lut.closest({ x: 0, y: 0 });
    axis = { cls: best.cls, p: hit.point, dir: lut.tangentAt(hit.s) };
  }
  axes.set(frag, axis);
  return axis;
}

/**
 * Вставка ложится на дорогу: если у главной дороги куска рядом (radius) дорога того же класса, кусок
 * поворачивается вдоль неё (из двух направлений — ближе к angle) и сдвигается на её ось.
 */
export function snapPaste(net: LaneNet, frag: Fragment, at: Vec, angle: number, radius: number): { at: Vec; angle: number; snapped: boolean } {
  const axis = mainAxis(frag);
  if (!axis) return { at, angle, snapped: false };
  const onAxis = () => placer(at, angle).place(axis.p);
  let host: Corridor | null = null;
  let bestD = radius;
  const q0 = onAxis();
  for (const c of net.corridorsNear(q0, radius)) {
    if (c.ring || c.cls !== axis.cls) continue;
    const d = c.lut.closest(q0).d;
    if (d < bestD) {
      bestD = d;
      host = c;
    }
  }
  if (!host) return { at, angle, snapped: false };
  // Дважды: на изогнутой дороге касательная в новой точке — уже чуть другая.
  for (let k = 0; k < 2; k++) {
    const q = onAxis();
    const hit = host.lut.closest(q);
    const base = angleOf(host.lut.tangentAt(hit.s)) - angleOf(axis.dir);
    angle = Math.abs(angleDiff(angle, base)) <= Math.PI / 2 ? base : base + Math.PI;
    const q2 = onAxis();
    at = add(at, sub(host.lut.closest(q2).point, q2));
  }
  return { at, angle, snapped: true };
}
