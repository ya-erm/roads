/**
 * Светофор перекрёстка: фазы (кому зелёный), кто кому уступает внутри фазы и какие потоки в одной фазе быть не могут,
 * секции светофора на карте и правка фаз игроком. Чистая логика — без графа и движения: манёвры приходят снаружи.
 */
import { LIGHTS } from '../config';
import { angleDiff, angleOf, dist, dot, type Vec } from '../core/vec';
import type { ConflictKind } from './graph';

/**
 * Фаза светофора, заданная игроком (настройка узла `phases`): повороты с зелёным — `${полотно въезда}>${полотно выезда}`,
 * как запреты поворотов, — и сколько секунд горит зелёный.
 */
export interface PhaseSpec {
  go: string[];
  green: number;
}

/** Фаза, по которой работает светофор: заданная игроком или «Авто». extra — повороты, которых нет ни в одной фазе игрока. */
export interface ResolvedPhase {
  go: string[];
  green: number;
  extra?: boolean;
}

export type TurnKind = 'left' | 'straight' | 'right';

/** Подъезд перекрёстка для фаз: полотно, курс въезда (к узлу) и повороты с него. */
export interface PhaseApproach {
  corridor: number;
  dir: Vec;
  turns: string[];
}

/** Манёвр перекрёстка — то, что нужно фазам: откуда (связь въезда), курс на въезде и выезде, с кем конфликтует. */
export interface PhaseMove {
  key: string;
  inLink: number;
  dirIn: Vec;
  dirOut: Vec;
  conflicts: Map<string, ConflictKind>;
}

export const turnKey = (from: number, to: number) => `${from}>${to}`;

/** Подъезды встречные — почти навстречу друг другу (косинус курсов меньше этого). Как в фазах «Авто». */
export const OPPOSITE = -0.7;
/** Насколько левее (рад) поворот встречного, чтобы уступал он: налево — прямо и направо, прямо — направо. */
const LEFTER = 0.35;

export const GREEN_MIN = 4;
export const GREEN_MAX = 40;
export const GREEN_STEP = 2;
/** Зелёный новой фазы со стрелкой, с. */
export const ARROW_GREEN = 6;

/** Поворот по курсу въезда и выезда (экран: y вниз, правый поворот — по часовой). */
export function turnKind(dirIn: Vec, dirOut: Vec): TurnKind {
  const a = angleDiff(angleOf(dirIn), angleOf(dirOut));
  return Math.abs(a) < 0.5 ? 'straight' : a > 0 ? 'right' : 'left';
}

/** Насколько манёвр уходит влево (рад): налево — больше нуля, направо — меньше. */
const leftness = (m: PhaseMove) => -angleDiff(angleOf(m.dirIn), angleOf(m.dirOut));

/** Фазы «Авто»: каждый подъезд — со встречным (если есть), остальные — по одному. dirs — курсы въезда; ответ — номера подъездов. */
export function autoGroups(dirs: Vec[]): number[][] {
  const left = dirs.map((_, i) => i);
  const groups: number[][] = [];
  while (left.length) {
    const first = left.shift()!;
    let bestIdx = -1;
    let bestDot = OPPOSITE;
    left.forEach((i, k) => {
      const d = dot(dirs[first], dirs[i]);
      if (d < bestDot) {
        bestDot = d;
        bestIdx = k;
      }
    });
    const group = [first];
    if (bestIdx >= 0) group.push(left.splice(bestIdx, 1)[0]);
    groups.push(group);
  }
  return groups;
}

/**
 * Фазы светофора по настройке узла. Не задано — «Авто» (встречные подъезды вместе, зелёный — greens или по умолчанию).
 * Задано игроком — его фазы (повороты, которых больше нет, — прочь; пустая фаза — «все стоят»), а повороты, что не
 * попали ни в одну, — своими фазами «Авто» в конце: новая дорога к перекрёстку не стоит вечно на красном.
 */
export function resolvePhases(spec: PhaseSpec[] | undefined, approaches: PhaseApproach[], greens?: number[]): ResolvedPhase[] {
  const auto = (list: PhaseApproach[]) => autoGroups(list.map((a) => a.dir)).map((g) => g.flatMap((k) => list[k].turns));
  if (!spec?.length) return auto(approaches).map((go, i) => ({ go, green: greens?.[i] ?? LIGHTS.green }));
  const all = new Set(approaches.flatMap((a) => a.turns));
  const phases: ResolvedPhase[] = spec.map((p) => ({ go: p.go.filter((t) => all.has(t)), green: p.green }));
  const covered = new Set(phases.flatMap((p) => p.go));
  const rest = approaches.map((a) => ({ ...a, turns: a.turns.filter((t) => !covered.has(t)) })).filter((a) => a.turns.length);
  for (const go of auto(rest)) phases.push({ go, green: LIGHTS.green, extra: true });
  return phases;
}

/**
 * Кто кому уступает среди манёвров с зелёным в одной фазе. Конфликтуют встречные — уступает тот, что левее
 * (налево на общий зелёный — встречным прямо и направо, как в ПДД); одинаково — кто раньше подъехал. Конфликтуют
 * не встречные (поперечные потоки) — так фаза быть не может: clashes (в игре едут по очереди, карточка подсвечивает).
 * Манёвры одного подъезда друг другу не помеха для фаз.
 */
export function phaseRelations(moves: PhaseMove[]): { yields: Map<string, Set<string>>; clashes: [string, string][] } {
  const yields = new Map<string, Set<string>>();
  const clashes: [string, string][] = [];
  const add = (who: string, to: string) => {
    const set = yields.get(who);
    if (set) set.add(to);
    else yields.set(who, new Set([to]));
  };
  for (let i = 0; i < moves.length; i++) {
    for (let j = i + 1; j < moves.length; j++) {
      const a = moves[i];
      const b = moves[j];
      if (a.inLink === b.inLink) continue;
      const kind = a.conflicts.get(b.key);
      if (!kind || kind === 'diverge') continue;
      if (dot(a.dirIn, b.dirIn) < OPPOSITE) {
        const d = leftness(a) - leftness(b);
        if (d > LEFTER) add(a.key, b.key);
        else if (d < -LEFTER) add(b.key, a.key);
      } else clashes.push([a.key, b.key]);
    }
  }
  return { yields, clashes };
}

/** Фаза для секций светофора: манёвры с зелёным и кто из них уступает. */
export interface HeadPhase {
  moves: Set<string>;
  yields: Map<string, Set<string>>;
}

/**
 * Светофор у въезда: основная секция и дополнительные со стрелкой. Основная — по прямому (нет прямого — по правому,
 * нет и его — по левому); стрелка — у поворота, которому зелёный загорается и без основной (поворотная фаза).
 * Стрелка горит, когда поворот зелёный, а основная — нет, или вместе с основной, если поворот никому не уступает.
 */
export interface SignalHead {
  link: number;
  /** Основная секция зелёная — по фазам. */
  main: boolean[];
  arrows: { kind: Exclude<TurnKind, 'straight'>; dir: Vec; on: boolean[] }[];
}

export function signalHeads(approaches: { link: number; moves: { key: string; dirIn: Vec; dirOut: Vec }[] }[], phases: HeadPhase[]): SignalHead[] {
  return approaches.map(({ link, moves }) => {
    const byKind = new Map<TurnKind, typeof moves>();
    for (const m of moves) {
      const k = turnKind(m.dirIn, m.dirOut);
      byKind.set(k, [...(byKind.get(k) ?? []), m]);
    }
    const mainKind: TurnKind = byKind.has('straight') ? 'straight' : byKind.has('right') ? 'right' : 'left';
    const green = (list: typeof moves) => phases.map((p) => list.some((m) => p.moves.has(m.key)));
    const main = green(byKind.get(mainKind) ?? []);
    const arrows: SignalHead['arrows'] = [];
    for (const kind of ['left', 'right'] as const) {
      const list = byKind.get(kind);
      if (!list || kind === mainKind) continue;
      const g = green(list);
      if (!g.some((x, i) => x && !main[i])) continue;
      const protectedIn = phases.map((p) => list.every((m) => !p.moves.has(m.key) || !p.yields.get(m.key)?.size));
      arrows.push({ kind, dir: list[0].dirOut, on: g.map((x, i) => x && (!main[i] || protectedIn[i])) });
    }
    return { link, main, arrows };
  });
}

// ---------- Правка фаз игроком (настройка узла) ----------

/** Фазы, которые сейчас работают, — как настройка игрока (с них начинается правка). */
export const specOf = (phases: ResolvedPhase[]): PhaseSpec[] => phases.map((p) => ({ go: [...p.go], green: p.green }));

/** Поворот в фазе i: был — убрать, не было — добавить. */
export function toggleTurn(spec: PhaseSpec[], i: number, turn: string): PhaseSpec[] {
  return spec.map((p, k) => (k !== i ? p : { ...p, go: p.go.includes(turn) ? p.go.filter((t) => t !== turn) : [...p.go, turn] }));
}

/** Новая пустая фаза в конце (повороты в неё добавляют кликом). */
export const addPhase = (spec: PhaseSpec[], green: number = LIGHTS.green): PhaseSpec[] => [...spec, { go: [], green }];

/** Убрать фазу i; последнюю не убрать. */
export const removePhase = (spec: PhaseSpec[], i: number): PhaseSpec[] => (spec.length > 1 ? spec.filter((_, k) => k !== i) : spec);

/** Переставить фазу i на d мест (−1 — раньше, 1 — позже); за край — без изменений. */
export function movePhase(spec: PhaseSpec[], i: number, d: number): PhaseSpec[] {
  const j = i + d;
  if (j < 0 || j >= spec.length || i < 0 || i >= spec.length) return spec;
  const res = [...spec];
  [res[i], res[j]] = [res[j], res[i]];
  return res;
}

/** Зелёный фазы i на d секунд дольше (в пределах GREEN_MIN…GREEN_MAX). */
export const stepGreen = (spec: PhaseSpec[], i: number, d: number): PhaseSpec[] =>
  spec.map((p, k) => (k !== i ? p : { ...p, green: Math.max(GREEN_MIN, Math.min(GREEN_MAX, p.green + d)) }));

/**
 * Стрелки налево: перед каждой фазой, где кто-то поворачивает налево, уступая встречным (lefts[i] — эти повороты),
 * — своя короткая фаза только для них, без встречных. Перед ней уже есть фаза, где они все едут, никому не уступая
 * (стрелка, может быть, вместе с правыми поворотами), — не добавляется.
 */
export function withLeftArrows(spec: PhaseSpec[], lefts: string[][], green = ARROW_GREEN): PhaseSpec[] {
  const res: PhaseSpec[] = [];
  // Кто уступает в предыдущей фазе: у вставленной стрелки — никто.
  let prevYields: string[] = [];
  spec.forEach((p, i) => {
    const l = lefts[i] ?? [];
    const prev = res[res.length - 1];
    const covered = !!prev && l.every((t) => prev.go.includes(t) && !prevYields.includes(t));
    if (l.length && !covered) res.push({ go: [...l], green });
    res.push(p);
    prevYields = l;
  });
  return res;
}

/**
 * Какую фазу править дальше, если фазу i переставили на d мест (d = null — убрали), а правили фазу edited:
 * номер едет вместе со своей фазой; убрали её саму — null. count — сколько фаз было (за край не переставить).
 */
export function editedAfter(edited: number, i: number, d: number | null, count: number): number | null {
  if (d === null) {
    if (count <= 1) return edited;
    return edited === i ? null : edited > i ? edited - 1 : edited;
  }
  const j = i + d;
  if (j < 0 || j >= count) return edited;
  return edited === i ? j : edited === j ? i : edited;
}

// ---------- Правка фазы на карте: проезды перекрёстка ----------

/**
 * Поворот в фазе: едет; едет, уступая встречным; конфликт — зелёный, но пересекает другой зелёный (старая настройка);
 * нельзя — красный, и зелёный ему не дать: пересечёт зелёный фазы; можно — красный, зелёный дать можно.
 */
export type TurnLook = 'go' | 'yield' | 'clash' | 'blocked' | 'free';

export interface TurnState {
  look: TurnLook;
  /** Зелёные повороты фазы, которые этот пересекает, а уступать некому (у clash и blocked). */
  with: string[];
}

/**
 * Повороты перекрёстка в фазе с зелёным go: кто едет, кто уступает встречным и с какими зелёными пересечётся каждый
 * (поперечные потоки — так фаза быть не может). moves — манёвры перекрёстка, turnOf — их поворот. Пары судит
 * phaseRelations, а он смотрит на каждую пару отдельно — поэтому достаточно одного прохода по всем манёврам.
 */
export function phaseTurnStates<M extends PhaseMove>(moves: M[], turnOf: (m: M) => string, go: string[]): Map<string, TurnState> {
  const on = new Set(go);
  const turn = new Map(moves.map((m) => [m.key, turnOf(m)]));
  const { yields, clashes } = phaseRelations(moves);
  const clashWith = new Map<string, Set<string>>();
  const note = (t: string, other: string) => {
    if (t === other || !on.has(other)) return;
    const set = clashWith.get(t);
    if (set) set.add(other);
    else clashWith.set(t, new Set([other]));
  };
  for (const [a, b] of clashes) {
    note(turn.get(a)!, turn.get(b)!);
    note(turn.get(b)!, turn.get(a)!);
  }
  // Уступает, если в фазе есть тот, кому уступать.
  const yielding = new Set<string>();
  for (const [who, to] of yields) {
    const t = turn.get(who)!;
    if (on.has(t) && [...to].some((k) => on.has(turn.get(k)!))) yielding.add(t);
  }
  const res = new Map<string, TurnState>();
  for (const t of new Set(turn.values())) {
    const w = [...(clashWith.get(t) ?? [])];
    if (on.has(t)) res.set(t, { look: w.length ? 'clash' : yielding.has(t) ? 'yield' : 'go', with: w });
    else res.set(t, { look: w.length ? 'blocked' : 'free', with: w });
  }
  return res;
}

/** С какими зелёными из go пересечётся поворот turn, если дать зелёный и ему (уступать некому). Пусто — можно. */
export function turnClashes<M extends PhaseMove>(moves: M[], turnOf: (m: M) => string, go: string[], turn: string): string[] {
  return phaseTurnStates(
    moves,
    turnOf,
    go.filter((t) => t !== turn),
  ).get(turn)?.with ?? [];
}

/**
 * Клик по проезду в фазе i: зелёный был — снять; не было — дать, если не пересечёт зелёные фазы (states — её повороты,
 * phaseTurnStates). Иначе отказ: фазы как были, clash — с какими зелёными пересёкся бы.
 */
export function phaseToggle(spec: PhaseSpec[], i: number, turn: string, states: Map<string, TurnState>): { spec: PhaseSpec[]; clash: string[] } {
  if (!spec[i]) return { spec, clash: [] };
  const clash = spec[i].go.includes(turn) ? [] : (states.get(turn)?.with ?? []);
  return clash.length ? { spec, clash } : { spec: toggleTurn(spec, i, turn), clash };
}

/** Какую долю длины пути манёвра с каждого конца не считать при выборе проезда: там сходятся пути соседних поворотов. */
const PATH_ENDS = 0.15;

/** Расстояние от p до части ломаной pts от from до to (по длине). */
function distToPart(pts: Vec[], p: Vec, from: number, to: number): number {
  let best = Infinity;
  let s = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const l = dist(a, b);
    const s0 = s;
    s += l;
    if (l < 1e-9) continue;
    const t0 = Math.max(0, (from - s0) / l);
    const t1 = Math.min(1, (to - s0) / l);
    if (t1 < t0) continue;
    const t = Math.max(t0, Math.min(t1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l)));
    best = Math.min(best, Math.hypot(p.x - a.x - (b.x - a.x) * t, p.y - a.y - (b.y - a.y) * t));
  }
  return best;
}

/**
 * Проезд под точкой p: поворот, путь манёвра которого ближе всех к ней и не дальше r. Концы путей (у стоп-линии
 * из одной полосы выходят и налево, и прямо; на выезде сходятся) — не в счёт, по PATH_ENDS длины с каждой стороны.
 */
export function turnAt(paths: { turn: string; points: Vec[] }[], p: Vec, r: number): string | null {
  let best: string | null = null;
  let bestD = r;
  for (const path of paths) {
    const pts = path.points;
    let total = 0;
    for (let k = 1; k < pts.length; k++) total += dist(pts[k - 1], pts[k]);
    const d = distToPart(pts, p, total * PATH_ENDS, total * (1 - PATH_ENDS));
    if (d <= bestD) {
      bestD = d;
      best = path.turn;
    }
  }
  return best;
}
