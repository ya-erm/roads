import { add, angleOf, cross, dist, dot, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { isTrunk, LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { Corridor, CorridorEnd, End, LaneNet, LaneNode, LaneSlot, taperLen } from './model';

export const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Доля полной ширины полосы на s: 1 — полная, 0 — нет; на отгоне — плавно. */
export function laneShare(c: Corridor, l: LaneSlot, s: number): number {
  const T = Math.max(1, taperLen(c.cls));
  if (s < l.from - 1e-6) return smooth((s - (l.from - T)) / T);
  if (s > l.to + 1e-6) return smooth((l.to + T - s) / T);
  return 1;
}

/**
 * Поперечный отрезок полосы на s — [lo, hi] в смещениях от оси, или null, если её там нет.
 * На отгоне полоса сужается к оси полотна: у правой неподвижна левая кромка, у левой — правая.
 */
export function laneBand(c: Corridor, l: LaneSlot, s: number): [number, number] | null {
  const w = laneShare(c, l, s) * LANE_W;
  if (w < 0.05) return null;
  const h = LANE_W / 2;
  if (l.offset > 0.01) return [l.offset - h, l.offset - h + w];
  if (l.offset < -0.01) return [l.offset + h - w, l.offset + h];
  return [-w / 2, w / 2];
}

/** Крайние кромки полос на s: [левая, правая] в смещениях от оси; null — полос нет. */
export function edgesAt(c: Corridor, s: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of c.lanes) {
    const b = laneBand(c, l, s);
    if (!b) continue;
    lo = Math.min(lo, b[0]);
    hi = Math.max(hi, b[1]);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Точка на s, смещённая вправо от оси на off. */
export function pointOff(c: Corridor, s: number, off: number): Vec {
  const p = c.lut.pointAt(s);
  return off ? add(p, scale(rightNormal(c.lut.tangentAt(s)), off)) : p;
}

/** Отметки вдоль оси на [s0, s1]: с шагом не больше step и все места, где меняется профиль. */
export function stations(c: Corridor, s0: number, s1: number, step = 4): number[] {
  const res: number[] = [];
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let i = 0; i <= n; i++) res.push(s0 + ((s1 - s0) * i) / n);
  const T = taperLen(c.cls);
  for (const l of c.lanes) {
    for (const x of [l.from - T, l.from, l.to, l.to + T]) if (x > s0 + 0.1 && x < s1 - 0.1) res.push(x);
  }
  return res.sort((x, y) => x - y);
}

/** У магистралей и односторонних кромки нарисованы краской; у улиц — только бордюр. */
export const paintedEdges = (c: Corridor) => isTrunk(c.cls) || c.lanes.every((l) => l.flow === c.lanes[0].flow);

/** Знак «вправо от направления от узла» в смещениях полотна. */
export const awaySign = (end: End) => (end === 'a' ? 1 : -1);
/** s на расстоянии d от конца end. */
export const sFrom = (c: Corridor, end: End, d: number) => (end === 'a' ? d : c.length - d);
/** Направление «от узла» на расстоянии d от конца. */
export const awayAt = (c: Corridor, end: End, d: number): Vec => scale(c.lut.tangentAt(sFrom(c, end, d)), awaySign(end));

/** Полуширина асфальта на конце полотна (по большей стороне). */
export function halfAt(c: Corridor, end: End): number {
  const e = edgesAt(c, end === 'a' ? 0 : c.length);
  return e ? Math.max(-e[0], e[1]) + ROAD_MARGIN : 0;
}

/** Запас сверх ширины поперечной дороги — на скругление углов перекрёстка. */
const CORNER = 6;

/**
 * Где полотна обрываются у перекрёстков: [у конца a, у конца b] по каждому полотну. У каждого подъезда
 * своё место — сразу за краем поперечной дороги и скруглением угла, как стоп-линия; у стыков — 0.
 */
export function junctionCuts(net: LaneNet): Map<number, [number, number]> {
  const res = new Map<number, [number, number]>();
  for (const c of net.corridors.values()) res.set(c.id, [0, 0]);
  for (const n of net.nodes.values()) {
    if (n.kind !== 'junction') continue;
    const ends = net.ends(n);
    if (ends.length < 2) continue;
    nodeCuts(net, n, ends).forEach((cut, i) => {
      res.get(ends[i].corridor.id)![ends[i].end === 'a' ? 0 : 1] = cut;
    });
  }
  return res;
}

/**
 * Обрезы подъездов одного перекрёстка (по порядку ends): за краем поперечной дороги и скруглением угла.
 * Угол со своим радиусом (`corners` узла) отодвигает обрезы обоих своих подъездов до начала дуги.
 */
export function nodeCuts(net: LaneNet, n: LaneNode, ends: CorridorEnd[] = net.ends(n)): number[] {
  if (n.kind !== 'junction' || ends.length < 2) return ends.map(() => 0);
  const half = ends.map((e) => halfAt(e.corridor, e.end));
  const res = ends.map((e, i) => {
    let d = 0;
    ends.forEach((o, j) => {
      if (i === j) return;
      const cos = Math.max(-1, Math.min(1, e.away.x * o.away.x + e.away.y * o.away.y));
      const theta = Math.acos(cos);
      // Почти напротив — продолжение, а не поперечная дорога.
      if (theta > Math.PI - 0.15) return;
      // Обращённые друг к другу края подъездов i и j пересекаются на таком расстоянии вдоль i.
      d = Math.max(d, (half[j] + half[i] * cos) / Math.max(0.1, Math.sin(theta)));
    });
    return Math.min(Math.max(d, 0) + CORNER, 80, e.corridor.length * 0.45);
  });
  if (n.corners) {
    for (const k of junctionCorners(net, n, ends)) {
      const r = n.corners[k.key];
      if (!(r > 0)) continue;
      const t = filletTangent(r, k.theta);
      res[k.ia] = Math.max(res[k.ia], Math.min(k.da + t, cutCap(net, k.a).cap));
      res[k.ib] = Math.max(res[k.ib], Math.min(k.db + t, cutCap(net, k.b).cap));
    }
  }
  return res;
}

// ---------- Скругление углов перекрёстка ----------

/** Скругляются углы между соседними подъездами от ~11° до ~137°: шире — кромка и так почти прямая. */
export const CORNER_MIN = 0.2;
export const CORNER_MAX = 2.4;
/** Обрез подъезда ради скругления — не дальше этого от узла. */
export const CORNER_CUT_MAX = 150;
/** Самый большой радиус скругления угла, м. */
export const CORNER_R_MAX = 120;
/** Сколько дороги оставить между обрезом и узлом на том конце полотна (и обрезом перекрёстка там), м. */
export const CORNER_GAP = 10;

/**
 * Что держит обрез подъезда e при скруглении угла: `stop` — дальше CORNER_CUT_MAX от перекрёстка, `junction` —
 * перекрёсток на том конце полотна, `node` — узел дороги там (стык, тупик).
 */
export type CutLimit = 'stop' | 'junction' | 'node';

/**
 * Докуда от узла можно отодвинуть обрез подъезда e ради скругления угла. До узла на том конце полотна — не ближе
 * CORNER_GAP: у стыка или тупика обреза нет, у перекрёстка — его собственный обрез (как сам выходит). Если и тот
 * перекрёсток скругляет угол на этом полотне (или полотно — петля), каждому — не дальше 45% длины: друг на друга
 * они не наедут.
 */
export function cutCap(net: LaneNet, e: CorridorEnd): { cap: number; why: CutLimit } {
  const c = e.corridor;
  const farId = e.end === 'a' ? c.b : c.a;
  const far = net.nodes.get(farId);
  let room: number;
  let why: CutLimit = 'node';
  if (!far || farId === e.node.id) room = c.length * 0.45;
  else if (far.kind !== 'junction') room = c.length - CORNER_GAP;
  else {
    why = 'junction';
    const shared = !!far.corners && Object.keys(far.corners).some((k) => k.split('-').includes(String(c.id)));
    if (shared) room = c.length * 0.45;
    else {
      const ends = net.ends(far);
      const i = ends.findIndex((x) => x.corridor.id === c.id && x.end !== e.end);
      const plain = i >= 0 ? nodeCuts(net, { ...far, corners: undefined }, ends)[i] : c.length * 0.45;
      room = c.length - plain - CORNER_GAP;
    }
  }
  if (room > CORNER_CUT_MAX) return { cap: CORNER_CUT_MAX, why: 'stop' };
  return { cap: Math.max(0, room), why };
}

/** Ключ угла в настройках узла (`corners`): пара полотен соседних подъездов, меньший номер первым. */
export const cornerKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Касательная скругления: на столько от вершины угла theta дуга радиуса r отходит вдоль каждой кромки. */
export const filletTangent = (r: number, theta: number) => r / Math.tan(theta / 2);
/** На столько середина дуги радиуса r дальше вершины угла theta — по биссектрисе, наружу от перекрёстка. */
export const filletDepth = (r: number, theta: number) => r * (1 / Math.sin(theta / 2) - 1);
/** Радиус дуги, у которой середина на depth от вершины угла theta (обратное к filletDepth). */
export const filletRadius = (depth: number, theta: number) => Math.max(0, depth) / (1 / Math.sin(theta / 2) - 1);
/** Площадь асфальта между вершиной угла theta и дугой радиуса r, м². */
export const filletArea = (r: number, theta: number) => r * r * (1 / Math.tan(theta / 2) - (Math.PI - theta) / 2);

/**
 * Угол перекрёстка между соседними подъездами a и b: b — следующий по возрастанию угла (на экране — по часовой).
 * Обращённые друг к другу кромки: у a — справа от направления «от узла», у b — слева. Без скругления они
 * сходятся в вершине apex; дуга скругления лежит снаружи от неё — по биссектрисе out.
 */
export interface JunctionCorner {
  key: string;
  a: CorridorEnd;
  b: CorridorEnd;
  /** Номера подъездов в net.ends(узла). */
  ia: number;
  ib: number;
  /** Угол между подъездами, рад. */
  theta: number;
  apex: Vec;
  out: Vec;
  /** От узла до вершины вдоль оси подъезда a и b. */
  da: number;
  db: number;
}

/** Полуширина асфальта на конце подъезда e со стороны side от направления «от узла» (1 — справа). */
export function sideHalfAt(e: CorridorEnd, side: 1 | -1): number {
  const c = e.corridor;
  const ed = edgesAt(c, e.end === 'a' ? 0 : c.length);
  if (!ed) return ROAD_MARGIN;
  return (awaySign(e.end) * side > 0 ? ed[1] : -ed[0]) + ROAD_MARGIN;
}

/** Углы перекрёстка, которые можно скруглить: между соседними подъездами, не развёрнутые и не почти прямые. */
export function junctionCorners(net: LaneNet, n: LaneNode, ends: CorridorEnd[] = net.ends(n)): JunctionCorner[] {
  if (n.kind !== 'junction' || ends.length < 2) return [];
  const order = ends.map((e, i) => ({ e, i, ang: Math.atan2(e.away.y, e.away.x) })).sort((x, y) => x.ang - y.ang);
  const res: JunctionCorner[] = [];
  order.forEach((A, k) => {
    const B = order[(k + 1) % order.length];
    if (A.e.corridor.id === B.e.corridor.id || A.e.corridor.ring || B.e.corridor.ring) return;
    let theta = B.ang - A.ang;
    if (theta <= 0) theta += Math.PI * 2;
    if (theta < CORNER_MIN || theta > CORNER_MAX) return;
    const ea = A.e.away;
    const eb = B.e.away;
    // Кромки: n.pos + ea·s + справа·ha и n.pos + eb·t − справа(eb)·hb; вершина — где они сходятся.
    const p = add(n.pos, scale(rightNormal(ea), sideHalfAt(A.e, 1)));
    const q = sub(n.pos, scale(rightNormal(eb), sideHalfAt(B.e, -1)));
    const den = cross(ea, eb);
    if (Math.abs(den) < 1e-6) return;
    const r = sub(q, p);
    const da = cross(r, eb) / den;
    const db = cross(r, ea) / den;
    res.push({ key: cornerKey(A.e.corridor.id, B.e.corridor.id), a: A.e, b: B.e, ia: A.i, ib: B.i, theta, apex: add(p, scale(ea, da)), out: norm(add(ea, eb)), da, db });
  });
  return res;
}

/** Точка кромки подъезда e в d от узла со стороны side (1 — справа от направления «от узла») и это направление там. */
export function edgePoint(e: CorridorEnd, d: number, side: 1 | -1): { p: Vec; away: Vec } {
  const c = e.corridor;
  const s = sFrom(c, e.end, d);
  const ed = edgesAt(c, s) ?? [0, 0];
  const off = awaySign(e.end) * side > 0 ? ed[1] + ROAD_MARGIN : ed[0] - ROAD_MARGIN;
  return { p: pointOff(c, s, off), away: awayAt(c, e.end, d) };
}

/**
 * Бордюр угла площадки перекрёстка от кромки подъезда a (точка aR у обреза, направление «от узла» ea) до кромки b
 * (bL, eb): точки между ними и середина — где за него берут. Дуга окружности, касательная к обеим кромкам, — самая
 * широкая, что помещается до ближнего из обрезов (дальше по другой кромке — прямо). Траектория поворота вдоль угла
 * («прямо — дуга — прямо» от концов полос у тех же обрезов, `filletPath`) — дуга с тем же центром, внутри на
 * расстояние от бордюра до оси полосы: машины не съезжают с асфальта. Радиус угла задают обрезы: свой радиус
 * (`corners`) отодвигает их до начала своей дуги. reflex — внешняя сторона излома (угол больше развёрнутого):
 * плавная кривая, как раньше. Не сходятся — прямо.
 */
export function cornerCurb(aR: Vec, ea: Vec, bL: Vec, eb: Vec, reflex = false): { pts: Vec[]; mid: Vec } {
  const den = cross(ea, eb);
  const q = sub(bL, aR);
  const t = Math.abs(den) > 0.05 ? cross(q, eb) / den : NaN;
  // Кромки сходятся позади обоих обрезов (ближе к узлу) — угол; сходятся за обрезом изогнутой ветки (её кромка у
  // обреза смотрит мимо: дуга подходит почти вдоль соседней дороги) — угла нет, площадка до обрезов — прямо, а не
  // клином вдоль ветки.
  const u = Math.abs(den) > 0.05 ? cross(q, ea) / den : NaN;
  if (!Number.isFinite(t) || t >= 0 || !(u < 0)) return { pts: [], mid: scale(add(aR, bL), 0.5) };
  const x = add(aR, scale(ea, t));
  const la = dist(aR, x);
  const lb = dist(bL, x);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(ea, eb))));
  if (!reflex && theta > 0.02 && la > 0.01 && lb > 0.01) {
    const ua = scale(sub(aR, x), 1 / la);
    const ub = scale(sub(bL, x), 1 / lb);
    const T = Math.min(la, lb);
    const rr = T * Math.tan(theta / 2);
    const out = norm(add(ua, ub));
    const c = add(x, scale(out, rr / Math.sin(theta / 2)));
    const ta = add(x, scale(ua, T));
    const tb = add(x, scale(ub, T));
    const a0 = angleOf(sub(ta, c));
    let sweep = angleOf(sub(tb, c)) - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / 0.12));
    const pts = [ta];
    for (let k = 1; k < steps; k++) {
      const ang = a0 + (sweep * k) / steps;
      pts.push(add(c, { x: Math.cos(ang) * rr, y: Math.sin(ang) * rr }));
    }
    pts.push(tb);
    return { pts, mid: add(x, scale(out, filletDepth(rr, theta))) };
  }
  const pts: Vec[] = [];
  for (let k = 1; k < 12; k++) {
    const f = k / 12;
    pts.push(add(add(scale(aR, (1 - f) * (1 - f)), scale(x, 2 * f * (1 - f))), scale(bL, f * f)));
  }
  return { pts, mid: add(scale(add(aR, bL), 0.25), scale(x, 0.5)) };
}

/**
 * Траектория «прямо — дуга — прямо» от точки a (по направлению a.dir) к точке b (выезжает по b.dir): самая плавная
 * дуга окружности, что помещается между продолжениями полос, — касается той, до схода с которой ближе. r — её радиус,
 * mid — середина дуги и направление там. null — линии не сходятся впереди (почти параллельны, разворот).
 */
export function filletPath(a: { pos: Vec; dir: Vec }, b: { pos: Vec; dir: Vec }, steps = 10): { points: Vec[]; r: number; mid: { pos: Vec; dir: Vec } } | null {
  const den = cross(a.dir, b.dir);
  if (Math.abs(den) < 0.05 || dot(a.dir, b.dir) < -0.95) return null;
  // a.pos + a.dir·s = b.pos − b.dir·t
  const back = scale(b.dir, -1);
  const w = sub(b.pos, a.pos);
  const d2 = cross(a.dir, back);
  const s = cross(w, back) / d2;
  const t = cross(w, a.dir) / d2;
  if (!(s > 0.01 && t > 0.01)) return null;
  const x = add(a.pos, scale(a.dir, s));
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(a.dir, b.dir))));
  const T = Math.min(s, t);
  const r = T / Math.tan(phi / 2);
  const ta = sub(x, scale(a.dir, T));
  // Поворот к правой нормали (по ходу) — центр справа, иначе слева.
  const side = den > 0 ? 1 : -1;
  const c = add(ta, scale(rightNormal(a.dir), side * r));
  const a0 = angleOf(sub(ta, c));
  const points: Vec[] = [a.pos];
  if (dist(a.pos, ta) > 0.05) points.push(ta);
  for (let k = 1; k <= steps; k++) {
    const ang = a0 + (side * phi * k) / steps;
    points.push(add(c, { x: Math.cos(ang) * r, y: Math.sin(ang) * r }));
  }
  if (dist(points[points.length - 1], b.pos) > 0.05) points.push(b.pos);
  const half = a0 + (side * phi) / 2;
  const mid = { pos: add(c, { x: Math.cos(half) * r, y: Math.sin(half) * r }), dir: norm(add(a.dir, b.dir)) };
  return { points, r, mid };
}
