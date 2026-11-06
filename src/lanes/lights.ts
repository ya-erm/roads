/**
 * Светофор перекрёстка: фазы (кому зелёный), кто кому уступает внутри фазы и какие потоки в одной фазе быть не могут,
 * секции светофора на карте и правка фаз игроком. Чистая логика — без графа и движения: манёвры приходят снаружи.
 */
import { LIGHTS } from '../config';
import { angleDiff, angleOf, dot, type Vec } from '../core/vec';
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
 * — своя короткая фаза только для них, без встречных. Уже есть такая перед ней — не добавляется.
 */
export function withLeftArrows(spec: PhaseSpec[], lefts: string[][], green = ARROW_GREEN): PhaseSpec[] {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((t) => b.includes(t));
  const res: PhaseSpec[] = [];
  spec.forEach((p, i) => {
    const l = lefts[i] ?? [];
    if (l.length && !(res.length && same(res[res.length - 1].go, l))) res.push({ go: [...l], green });
    res.push(p);
  });
  return res;
}
