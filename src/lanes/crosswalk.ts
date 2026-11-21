import { lerp, rightNormal, scale, Vec } from '../core/vec';
import { SIDEWALK, WALK_EDGE } from '../world/roadTypes';
import { asphaltEdgesAt, edgesAt, junctionCuts, laneBand, pointOff, sFrom } from './geometry';
import { Corridor, corridorMargin, CorridorEnd, End, LaneNet, LaneNode } from './model';

/**
 * Пешеходные переходы на подъездах перекрёстков (docs/CROSSWALKS.md): настройка узла (`walks`), где переход возможен,
 * значение «само» и геометрия зебры. Движение — стоп-линия дальше (LaneGraph.stopBack) и пешеходы (src/game/crosswalks.ts).
 */

/** Размеры перехода, м: от обреза подъезда — зазор, зебра, до стоп-линии; полосы зебры; пешеходы; цена. */
export const XWALK = {
  gap: 0.5,
  depth: 5,
  stopGap: 1.5,
  /**
   * Полосы зебры — вдоль движения: ширина и шаг поперёк дороги (шаг подгоняется, чтобы крайние полосы легли у самых
   * бордюров — в curbPad от края асфальта).
   */
  stripe: 1.3,
  period: 2.6,
  curbPad: 0.3,
  /** Сверх двух переходов между обрезами полотна — хотя бы столько дороги. */
  minFree: 6,
  /** Пешеходы, м/с игры, и сколько секунд им сойти с бордюра. */
  speed: 3.5,
  start: 0.8,
  /** Разметка — за каждую полосу, которую переход пересекает, $. */
  laneCost: 40,
  underpassBase: 6000,
  underpassLane: 1500,
} as const;

/** На столько стоп-линия подъезда с переходом дальше от перекрёстка, м. */
export const XWALK_BACK = XWALK.gap + XWALK.depth + XWALK.stopGap;

/** Переход на подъезде: есть ли; own — выбрал игрок (иначе — «само», по городу). */
export interface WalkSetting {
  on: boolean;
  own?: true;
  underground?: true;
}

/**
 * Почему перехода на подъезде быть не может: node — у перекрёстка меньше трёх дорог или это петля, class — не улица и
 * не проспект, ring — участок кольца, level — мост или тоннель, build — строится, short — подъезд слишком короткий.
 */
export type WalkBan = 'node' | 'class' | 'ring' | 'level' | 'build' | 'short';

export interface WalkArm {
  corridor: Corridor;
  end: End;
  e: CorridorEnd;
  /** Обрез подъезда у этого узла, м от узла. */
  cut: number;
  ban: WalkBan | null;
  /** Переход есть: можно и включён. */
  on: boolean;
  /** Настройку задал игрок. */
  own: boolean;
  underground: boolean;
}

/** Причина недоступности — значком в подсказке. */
export const WALK_BAN_TEXT: Record<WalkBan, string> = {
  node: 'нужен перекрёсток от трёх дорог',
  class: 'только на улице или проспекте',
  ring: 'на кольце — только на въездах',
  level: 'только на земле',
  build: 'дорога ещё строится',
  short: 'подъезд слишком короткий',
};

/** Настройка перехода на подъезде полотна id (как задана, без проверки, можно ли). */
export const walkSetting = (n: LaneNode, id: number): WalkSetting | undefined => n.walks?.[String(id)];

/**
 * Подъезды перекрёстка n и переходы на них. cuts — обрезы полотен, если уже посчитаны (иначе — у n и узлов на других
 * концах его полотен).
 */
export function walkArms(net: LaneNet, n: LaneNode, cuts?: Map<number, [number, number]>): WalkArm[] {
  if (n.kind !== 'junction') return [];
  const ends = net.ends(n);
  if (!cuts) {
    const corridors = [...new Set(ends.map((e) => e.corridor))];
    const nodes = new Set<LaneNode>([n]);
    for (const c of corridors) for (const id of [c.a, c.b]) nodes.add(net.node(id));
    cuts = junctionCuts(net, corridors, nodes);
  }
  const nodeBan: WalkBan | null = ends.length < 3 ? 'node' : n.level !== 0 ? 'level' : null;
  return ends.map((e) => {
    const c = e.corridor;
    const cut = cuts.get(c.id) ?? [0, 0];
    const here = e.end === 'a' ? cut[0] : cut[1];
    const far = e.end === 'a' ? cut[1] : cut[0];
    let ban: WalkBan | null = nodeBan;
    if (!ban && c.a === c.b) ban = 'node';
    else if (!ban && c.ring) ban = 'ring';
    else if (!ban && c.cls !== 'street' && c.cls !== 'avenue') ban = 'class';
    else if (!ban && (net.node(c.a).level !== 0 || net.node(c.b).level !== 0)) ban = 'level';
    else if (!ban && c.build) ban = 'build';
    else if (!ban && c.length - here - far < 2 * XWALK_BACK + XWALK.minFree) ban = 'short';
    const set = walkSetting(n, c.id);
    const on = !ban && !!set?.on;
    return { corridor: c, end: e.end, e, cut: here, ban, on, own: !!set?.own, underground: on && set?.underground === true };
  });
}

/** Подъезды узла n, где переход есть. */
export const walksOn = (net: LaneNet, n: LaneNode, cuts?: Map<number, [number, number]>): WalkArm[] =>
  n.walks ? walkArms(net, n, cuts).filter((a) => a.on) : [];

/** Переход на подъезде id — так (own — выбор игрока; без own — «само»). Объект заменяется целиком. */
export function setWalk(n: LaneNode, id: number, on: boolean, own = true, underground = false): void {
  n.walks = { ...n.walks, [String(id)]: { on, ...(own && { own: true }), ...(on && underground && { underground: true }) } };
}

/**
 * Значения «само» на подъездах узла n: где переход возможен и игрок его не задавал — auto(подъезд); только у подъездов
 * без настройки (all — и у прежних «само»). Настройки полотен, которых у узла больше нет, — прочь. true — что-то поменялось.
 */
export function syncWalks(net: LaneNet, n: LaneNode, auto: (arm: WalkArm) => boolean, all = false, cuts?: Map<number, [number, number]>): boolean {
  if (n.kind !== 'junction') {
    if (!n.walks) return false;
    delete n.walks;
    return true;
  }
  const arms = walkArms(net, n, cuts);
  const here = new Set(arms.map((a) => String(a.corridor.id)));
  const next: Record<string, WalkSetting> = {};
  let changed = false;
  for (const [k, v] of Object.entries(n.walks ?? {})) {
    if (here.has(k)) next[k] = v;
    else changed = true;
  }
  for (const arm of arms) {
    const k = String(arm.corridor.id);
    const had = next[k];
    if (arm.ban || had?.own || (had && !all)) continue;
    const on = auto(arm);
    if (had?.on === on) continue;
    next[k] = { on };
    changed = true;
  }
  if (!changed) return false;
  if (Object.keys(next).length) n.walks = next;
  else delete n.walks;
  return true;
}

/** Переименовывает полотна в настройке переходов; map → undefined — настройка прочь. */
export function remapWalks(walks: Record<string, WalkSetting>, map: (id: number) => number | undefined): Record<string, WalkSetting> | undefined {
  const res: Record<string, WalkSetting> = {};
  for (const [k, v] of Object.entries(walks)) {
    const id = map(Number(k));
    if (id !== undefined) res[String(id)] = { ...v };
  }
  return Object.keys(res).length ? res : undefined;
}

/** Зебра подъезда: что рисовать и где ходят пешеходы. */
export interface WalkGeo {
  corridor: number;
  end: End;
  /** Середина зебры на оси полотна. */
  s: number;
  /** Кромки крайних полос поперёк (смещения от оси полотна вправо по a→b). */
  lo: number;
  hi: number;
  /** Ширина асфальта поперёк, м (пешеходам идти). */
  width: number;
  /** Асфальт от обреза до стоп-линии: под ним стёрта разметка полос. */
  cover: Vec[];
  /** Полосы зебры — четырёхугольники. */
  stripes: Vec[][];
  /** Лестницы вдоль бордюров, от тёмного конца к выходу на тротуар. */
  portals?: Vec[][];
  /** Примыкания площадок подземного перехода к тротуарам, по одному у каждой лестницы. */
  approaches?: Vec[];
  /** Концы перехода на тротуаре: со стороны lo и hi. */
  ends: [Vec, Vec];
  /** У бордюров посреди зебры и наружу от дороги: правого (от перекрёстка) и левого — у одного из них значок переключателя. */
  curb: Vec;
  out: Vec;
  curbL: Vec;
  outL: Vec;
  /** Сколько полос переход пересекает. */
  lanes: number;
}

/** Геометрия зебры подъезда arm (переход может быть и выключен — для значка). */
export function walkGeo(arm: WalkArm): WalkGeo {
  const c = arm.corridor;
  const end = arm.end;
  const at = (d: number) => Math.max(0, Math.min(c.length, sFrom(c, end, d)));
  const d0 = arm.cut + XWALK.gap;
  const d1 = d0 + XWALK.depth;
  const sMid = at((d0 + d1) / 2);
  const [lo, hi] = edgesAt(c, sMid) ?? [-7, 7];
  const margin = corridorMargin(c);
  const quad = (da: number, db: number, x0: number, x1: number): Vec[] => [
    pointOff(c, at(da), x0),
    pointOff(c, at(db), x0),
    pointOff(c, at(db), x1),
    pointOff(c, at(da), x1),
  ];
  // Полосы зебры — по всей ширине асфальта, от бордюра до бордюра (и через разделительную): крайние — в curbPad от края,
  // шаг подогнан под ширину (не уже промежутка 0,9 м).
  const left = lo - margin + XWALK.curbPad;
  const room = hi - lo + 2 * margin - 2 * XWALK.curbPad;
  let n = Math.max(2, Math.round((room - XWALK.stripe) / XWALK.period) + 1);
  while (n > 2 && (room - XWALK.stripe) / (n - 1) - XWALK.stripe < 0.9) n--;
  const step = (room - XWALK.stripe) / (n - 1);
  const stripes: Vec[][] = [];
  for (let i = 0; i < n; i++) stripes.push(quad(d0, d1, left + i * step, left + i * step + XWALK.stripe));
  const dc = arm.cut + XWALK_BACK;
  // Разметка полос стёрта до самых бордюров (и краской нарисованные кромки у магистралей и односторонних).
  const cl = lo - margin + 0.15;
  const ch = hi + margin - 0.15;
  const cover = [
    pointOff(c, at(arm.cut - 0.2), cl),
    pointOff(c, at((arm.cut + dc) / 2), cl),
    pointOff(c, at(dc), cl),
    pointOff(c, at(dc), ch),
    pointOff(c, at((arm.cut + dc) / 2), ch),
    pointOff(c, at(arm.cut - 0.2), ch),
  ];
  const lanes = c.lanes.filter((l) => laneBand(c, l, sMid)).length;
  // Правый бордюр, если смотреть от перекрёстка: у конца a — сторона hi (вправо по a→b), у конца b — lo.
  const side = end === 'a' ? 1 : -1;
  const edge = side > 0 ? hi + margin : lo - margin;
  const edgeL = side > 0 ? lo - margin : hi + margin;
  const t = c.lut.tangentAt(sMid);
  // Вдоль улицы остаётся непрерывный тротуар. Лестница начинается за ним, с метровым отступом.
  const near = WALK_EDGE + 1;
  const far = near + 3.4;
  const stairsEnd = at(d0 + 6.5);
  const curbPoint = (s: number, side: number, setback: number) => {
    const edges = asphaltEdgesAt(c, s) ?? [lo - margin, hi + margin];
    return pointOff(c, s, edges[side < 0 ? 0 : 1] + side * setback);
  };
  const portals = arm.underground ? [-1, 1].map(side => [
    curbPoint(at(d0), side, near), curbPoint(stairsEnd, side, near),
    curbPoint(stairsEnd, side, far), curbPoint(at(d0), side, far),
  ]) : undefined;
  const approaches = portals && [-1, 1].map(side => curbPoint(stairsEnd, side, SIDEWALK.paved.from + SIDEWALK.paved.w / 2));
  return {
    corridor: c.id,
    end,
    s: sMid,
    lo,
    hi,
    width: hi - lo + 2 * margin,
    cover: portals ? [] : cover,
    stripes: portals ? [] : stripes,
    portals,
    approaches,
    ends: portals ? [lerp(portals[0][1], portals[0][2], 0.5), lerp(portals[1][1], portals[1][2], 0.5)]
      : [pointOff(c, sMid, lo - margin - 1.2), pointOff(c, sMid, hi + margin + 1.2)],
    curb: pointOff(c, sMid, edge),
    out: scale(rightNormal(t), side),
    curbL: pointOff(c, sMid, edgeL),
    outL: scale(rightNormal(t), -side),
    lanes,
  };
}

/** Сколько секунд пешеходы идут по переходу шириной width. */
export const walkTime = (width: number) => width / XWALK.speed + XWALK.start;

/** Цена разметки перехода: по полосам, которые он пересекает. */
export const walkCost = (geo: Pick<WalkGeo, 'lanes'>) => Math.max(1, geo.lanes) * XWALK.laneCost;

export const underpassCost = (geo: Pick<WalkGeo, 'lanes'>) => XWALK.underpassBase + Math.max(1, geo.lanes) * XWALK.underpassLane;
