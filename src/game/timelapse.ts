/**
 * Таймлапс партии: в конце каждого месяца — компактный кадр сети игрока (дороги, пути, станции, маршруты)
 * и счётчики (деньги, транспорт, жители городов). Кадр хранит только изменения с прошлого: что появилось
 * или поменялось — целиком, что снесли — номером. Первый кадр (начало партии или начало записи) — целиком.
 *
 * Геометрия — кривые Безье полотен с координатами, округлёнными до TL_STEP единиц карты, почти прямые — двумя
 * точками. Запись — не больше TL_FRAMES кадров, а история сверх самой сети — не больше TL_CHARS символов: сверх
 * предела кадры старшей половины партии склеиваются попарно (сначала через месяц, потом через два…), начало и
 * конец остаются.
 *
 * Здесь только данные: запись, склейка, раскладка кадров во время жизни каждого объекта (для проигрывателя)
 * и грубые кадры по журналу для старых сохранений без записи. Проигрыватель — src/ui/timelapse.ts.
 */

import { MONTH_LENGTH } from '../config';
import type { Cubic } from '../core/bezier';
import type { Game } from './game';
import { r2, type JournalEntry } from './journal';

/** Шаг округления координат, ед. карты: на карте целиком это меньше пикселя. */
export const TL_STEP = 4;
/** Предел записи, символов JSON. */
export const TL_CHARS = 200_000;
/** Предел числа кадров: 40 лет помесячно. */
export const TL_FRAMES = 480;
/** Меньше стольких кадров запись не прореживается. */
const TL_MIN_FRAMES = 8;

/** Слои кадра: r — дороги, t — ж/д пути, s — станции, l — маршруты. */
export type TlLayer = 'r' | 't' | 's' | 'l';
export const TL_LAYERS: readonly TlLayer[] = ['r', 't', 's', 'l'];
type DelKey = `${TlLayer}d`;

/**
 * Запись объекта, первым — id:
 * - дорога: [id, класс (0 улица … 3 магистраль), x0, y0, dx1, dy1, dx2, dy2, dx3, dy3] — точки от начала;
 *   почти прямая — [id, класс, x0, y0, dx, dy];
 * - путь: [id, платформа (1/0), …те же точки];
 * - станция: [id, вид (0 автостанция, 1 остановка, 2 вокзал), x, y, грузовой двор (1/0)];
 * - маршрут: [id, цвет, вид (0 авто, 1 поезд), …id станций по порядку].
 * Координаты — в шагах TL_STEP.
 */
export type TlRec = (number | string)[];

export interface TimelapseFrame {
  /** Время кадра, месяцев от начала партии (1 — конец первого месяца). */
  m: number;
  /** Кадр целиком: чего в нём нет, того к этому времени уже нет. */
  full?: 1;
  /** Деньги. */
  $: number;
  /** Транспорт компании. */
  n: number;
  /** Жители городов — по порядку tw. */
  p: number[];
  /** id городов, если список поменялся (в первом кадре — всегда). */
  tw?: number[];
  /** Этап сценария (0 — A); в песочнице нет. */
  ph?: number;
  r?: TlRec[];
  rd?: number[];
  t?: TlRec[];
  td?: number[];
  s?: TlRec[];
  sd?: number[];
  l?: TlRec[];
  ld?: number[];
}

export interface TimelapseSave {
  v: 1;
  frames: TimelapseFrame[];
}

const ROAD_CLASSES = ['street', 'avenue', 'highway', 'motorway'];
const STATION_KINDS = ['road', 'stop', 'rail'];

const q = (n: number) => Math.round(n / TL_STEP);

/** Расстояние от точки до отрезка. */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Кривая — запись [id, вид, точки…]: почти прямая (ручки у хорды) — двумя точками. */
export function curveRec(id: number, kind: number, c: Cubic): TlRec {
  const x0 = q(c.p0.x);
  const y0 = q(c.p0.y);
  const end = [q(c.p3.x) - x0, q(c.p3.y) - y0];
  const off = Math.max(toSegment(c.p1.x, c.p1.y, c.p0.x, c.p0.y, c.p3.x, c.p3.y), toSegment(c.p2.x, c.p2.y, c.p0.x, c.p0.y, c.p3.x, c.p3.y));
  if (off < TL_STEP / 2) return [id, kind, x0, y0, ...end];
  return [id, kind, x0, y0, q(c.p1.x) - x0, q(c.p1.y) - y0, q(c.p2.x) - x0, q(c.p2.y) - y0, ...end];
}

/** Кривая из записи — в координатах карты. */
export function recCurve(rec: TlRec): Cubic {
  const n = rec as number[];
  const x0 = n[2] * TL_STEP;
  const y0 = n[3] * TL_STEP;
  const at = (i: number) => ({ x: x0 + n[i] * TL_STEP, y: y0 + n[i + 1] * TL_STEP });
  const p0 = { x: x0, y: y0 };
  if (n.length < 10) {
    const p3 = at(4);
    return { p0, p1: { x: x0 + (p3.x - x0) / 3, y: y0 + (p3.y - y0) / 3 }, p2: { x: x0 + ((p3.x - x0) * 2) / 3, y: y0 + ((p3.y - y0) * 2) / 3 }, p3 };
  }
  return { p0, p1: at(4), p2: at(6), p3: at(8) };
}

/** Сеть игры сейчас — записями по слоям. */
function snapshot(game: Game): Record<TlLayer, Map<number, TlRec>> {
  const r = new Map<number, TlRec>();
  // Строящееся («Со строительством») — ещё не дорога: в таймлапс попадёт, когда участок откроют.
  for (const c of game.roads.net.corridors.values()) if (!c.build) r.set(c.id, curveRec(c.id, Math.max(0, ROAD_CLASSES.indexOf(c.cls)), c.curve));
  const t = new Map<number, TlRec>();
  for (const s of game.net.segments.values()) t.set(s.id, curveRec(s.id, s.platform !== undefined ? 1 : 0, s.curve));
  const s = new Map<number, TlRec>();
  for (const st of game.stations.values()) {
    s.set(st.id, [st.id, Math.max(0, STATION_KINDS.indexOf(st.kind)), q(st.fp.center.x), q(st.fp.center.y), st.industryId !== null ? 1 : 0]);
  }
  const l = new Map<number, TlRec>();
  for (const line of game.lines.values()) l.set(line.id, [line.id, line.color, line.mode === 'rail' ? 1 : 0, ...line.stops]);
  return { r, t, s, l };
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Запись таймлапса: кадры партии и то, что было в последнем, — чтобы следующий хранил только изменения. */
export class TimelapseRecorder {
  readonly frames: TimelapseFrame[];
  /** Последнее записанное состояние: id → запись строкой; null — ещё не восстановлено из кадров. */
  private last: Record<TlLayer, Map<number, string>> | null = null;
  private towns: number[] = [];
  private chars = 0;

  constructor(saved?: TimelapseSave) {
    this.frames = saved?.v === 1 && Array.isArray(saved.frames) ? saved.frames.slice() : [];
    this.chars = this.frames.reduce((sum, f) => sum + JSON.stringify(f).length, 0);
  }

  /** Записывает кадр на сейчас: изменения с прошлого кадра (первый — целиком). */
  capture(game: Game): TimelapseFrame {
    const { frame, state } = this.diff(game);
    this.frames.push(frame);
    this.last = state;
    if (frame.tw) this.towns = frame.tw;
    this.chars += JSON.stringify(frame).length;
    this.limit();
    return frame;
  }

  /** Кадр «как сейчас», не записывая его: финал проигрывателя — сеть на момент просмотра. */
  peek(game: Game): TimelapseFrame {
    return this.diff(game).frame;
  }

  /** Размер записи, символов JSON. */
  get size(): number {
    return this.chars;
  }

  toSave(): TimelapseSave {
    return { v: 1, frames: this.frames };
  }

  private diff(game: Game): { frame: TimelapseFrame; state: Record<TlLayer, Map<number, string>> } {
    const prev = this.frames.length ? this.restored() : null;
    const now = snapshot(game);
    const towns = game.towns.map((t) => t.id);
    const frame: TimelapseFrame = {
      m: r2(game.time / MONTH_LENGTH),
      $: Math.round(game.money),
      n: game.fleet.size,
      p: game.towns.map((t) => Math.round(t.population)),
    };
    if (!prev) frame.full = 1;
    if (!prev || !sameList(towns, this.towns)) frame.tw = towns;
    if (game.scenario) frame.ph = game.scenario.state.phase;
    const state = {} as Record<TlLayer, Map<number, string>>;
    for (const L of TL_LAYERS) {
      const keys = new Map<number, string>();
      const adds: TlRec[] = [];
      for (const [id, rec] of now[L]) {
        const key = JSON.stringify(rec);
        keys.set(id, key);
        if (prev?.[L].get(id) !== key) adds.push(rec);
      }
      state[L] = keys;
      if (adds.length) frame[L] = adds;
      if (!prev) continue;
      const dels = [...prev[L].keys()].filter((id) => !keys.has(id));
      if (dels.length) frame[`${L}d` as DelKey] = dels;
    }
    return { frame, state };
  }

  /** Последнее записанное состояние; после загрузки — по кадрам из сохранения. */
  private restored(): Record<TlLayer, Map<number, string>> {
    if (this.last) return this.last;
    const state = { r: new Map(), t: new Map(), s: new Map(), l: new Map() } as Record<TlLayer, Map<number, string>>;
    for (const f of this.frames) {
      if (f.tw) this.towns = f.tw;
      for (const L of TL_LAYERS) {
        if (f.full) state[L].clear();
        for (const id of f[`${L}d` as DelKey] ?? []) state[L].delete(id);
        for (const rec of f[L] ?? []) state[L].set(rec[0] as number, JSON.stringify(rec));
      }
    }
    this.last = state;
    return state;
  }

  /**
   * Сколько символов занимает сама сеть последнего кадра. Её в записи не урезать никак (она нужна для финала),
   * поэтому предел TL_CHARS — на историю сверх неё: огромная сеть не схлопывает партию до пары кадров.
   */
  private networkChars(): number {
    if (!this.frames.length) return 0;
    let sum = 0;
    for (const L of TL_LAYERS) for (const key of this.restored()[L].values()) sum += key.length + 1;
    return sum;
  }

  /** Держит запись в пределах: склеивает кадры старшей половины, пока не влезет (или склеивать нечего). */
  private limit(): void {
    const budget = () => TL_CHARS + this.networkChars();
    while ((this.frames.length > TL_FRAMES || (this.chars > TL_CHARS && this.chars > budget())) && this.frames.length > TL_MIN_FRAMES) {
      const before = this.frames.length;
      const half = Math.floor(before / 2);
      const out = [this.frames[0]];
      let i = 1;
      for (; i + 1 <= half; i += 2) out.push(mergeFrames(this.frames[i], this.frames[i + 1]));
      out.push(...this.frames.slice(i));
      this.frames.length = 0;
      this.frames.push(...out);
      this.chars = this.frames.reduce((sum, f) => sum + JSON.stringify(f).length, 0);
      if (this.frames.length >= before) break;
    }
  }
}

/** Два соседних кадра — одним: изменения обоих, счётчики — позднего. */
export function mergeFrames(a: TimelapseFrame, b: TimelapseFrame): TimelapseFrame {
  if (b.full) return b;
  const out: TimelapseFrame = { m: b.m, $: b.$, n: b.n, p: b.p };
  if (a.full) out.full = 1;
  const tw = b.tw ?? a.tw;
  if (tw) out.tw = tw;
  if (b.ph !== undefined) out.ph = b.ph;
  for (const L of TL_LAYERS) {
    const D = `${L}d` as DelKey;
    const adds = new Map<number, TlRec>();
    for (const rec of a[L] ?? []) adds.set(rec[0] as number, rec);
    const dels = new Set<number>(a[D] ?? []);
    for (const id of b[D] ?? []) {
      adds.delete(id);
      dels.add(id);
    }
    for (const rec of b[L] ?? []) {
      adds.set(rec[0] as number, rec);
      dels.delete(rec[0] as number);
    }
    if (adds.size) out[L] = [...adds.values()];
    // В кадре целиком снос не нужен: чего нет в кадре, того и нет.
    if (dels.size && !out.full) out[D] = [...dels];
  }
  return out;
}

// ---------- Раскладка для проигрывателя ----------

/** Объект на шкале времени: виден с кадра from по кадр to (не включая; Infinity — до конца). */
export interface TlItem {
  id: number;
  rec: TlRec;
  from: number;
  to: number;
}

export interface TlFrameInfo {
  m: number;
  money: number;
  vehicles: number;
  /** Жители по id города. */
  pops: Map<number, number>;
  phase?: number;
}

export interface Timeline {
  frames: TlFrameInfo[];
  layers: Record<TlLayer, TlItem[]>;
}

/**
 * Кадры — в время жизни каждого объекта: когда появился и когда снесли или поменяли (поменянный — это старый
 * объект, который исчез, и новый, который появился). Так проигрыватель за один проход знает, что рисовать
 * в любом месте шкалы и что в нём появляется или исчезает.
 */
export function buildTimeline(frames: TimelapseFrame[]): Timeline {
  const layers = { r: [], t: [], s: [], l: [] } as Record<TlLayer, TlItem[]>;
  const alive = { r: new Map(), t: new Map(), s: new Map(), l: new Map() } as Record<TlLayer, Map<number, { key: string; item: TlItem }>>;
  const info: TlFrameInfo[] = [];
  let tw: number[] = [];
  frames.forEach((f, i) => {
    if (f.tw) tw = f.tw;
    info.push({ m: f.m, money: f.$, vehicles: f.n, pops: new Map(tw.map((id, k) => [id, f.p[k] ?? 0])), phase: f.ph });
    for (const L of TL_LAYERS) {
      const map = alive[L];
      const adds = f[L] ?? [];
      const added = new Set(adds.map((rec) => rec[0] as number));
      const gone = f.full ? [...map.keys()].filter((id) => !added.has(id)) : (f[`${L}d` as DelKey] ?? []).filter((id) => !added.has(id));
      for (const id of gone) {
        const a = map.get(id);
        if (!a) continue;
        a.item.to = i;
        map.delete(id);
      }
      for (const rec of adds) {
        const id = rec[0] as number;
        const key = JSON.stringify(rec);
        const a = map.get(id);
        if (a?.key === key) continue;
        if (a) a.item.to = i;
        const item: TlItem = { id, rec, from: i, to: Infinity };
        layers[L].push(item);
        map.set(id, { key, item });
      }
    }
  });
  return { frames: info, layers };
}

// ---------- Грубый таймлапс по журналу ----------

/**
 * Кадры по журналу — для сохранений без записи таймлапса: станции по координатам из записей `station`, маршруты
 * из `line` и `route`, деньги, транспорт и жители из месячных сводок. Дорог в журнале нет (только длины), поэтому
 * их в этих кадрах нет. Каждый кадр — целиком (они не сохраняются, размер не важен). until — только раньше этого
 * времени (месяцев).
 */
export function journalFrames(entries: readonly JournalEntry[], color: (line: number) => string, until = Infinity): TimelapseFrame[] {
  const frames: TimelapseFrame[] = [];
  const stations = new Map<number, TlRec>();
  const lines = new Map<number, TlRec>();
  let money = 0;
  let vehicles = 0;
  let tw: number[] = [];
  let pops: number[] = [];
  const emit = (m: number) =>
    frames.push({ m, full: 1, $: money, n: vehicles, p: pops, tw, s: [...stations.values()], l: [...lines.values()] });
  for (const e of entries) {
    if (e.m >= until) break;
    const id = Number(e.id);
    switch (e.k) {
      case 'game':
        money = Number(e.money) || 0;
        emit(e.m);
        break;
      case 'station': {
        const pos = e.pos as number[] | undefined;
        if (!pos) break;
        stations.set(id, [id, Math.max(0, STATION_KINDS.indexOf(String(e.kind))), q(pos[0]), q(pos[1]), 0]);
        break;
      }
      case 'station-':
        stations.delete(id);
        break;
      case 'line':
      case 'route': {
        const stops = (e.stops as number[] | undefined) ?? [];
        const was = lines.get(id);
        const mode = e.k === 'line' ? (e.mode === 'rail' ? 1 : 0) : ((was?.[2] as number | undefined) ?? 0);
        lines.set(id, [id, color(id), mode, ...stops]);
        break;
      }
      case 'line-':
        lines.delete(id);
        break;
      case 'month': {
        money = Number(e.money) || 0;
        const ls = (e.lines as number[][] | undefined) ?? [];
        vehicles = ls.reduce((sum, l) => sum + (Number(l[5]) || 0), 0);
        const towns = (e.towns as number[][] | undefined) ?? [];
        tw = towns.map((t) => t[0]);
        pops = towns.map((t) => Math.round(t[1]));
        emit(e.m);
        break;
      }
    }
  }
  return frames;
}

/** Что показать в проигрывателе: кадры и откуда они. */
export interface TimelapseSource {
  frames: TimelapseFrame[];
  /** Часть партии (с начала до recordFrom) восстановлена по журналу: без дорог. */
  rough: boolean;
  /** С какого месяца идут настоящие кадры (до него — по журналу). */
  recordFrom: number;
}

/**
 * Кадры для проигрывателя: записанные и в конце — сеть на сейчас. Запись началась не с начала партии
 * (сохранение до таймлапса) — начало добирается по журналу.
 */
export function timelapseOf(game: Game): TimelapseSource {
  const rec = game.timelapse.frames;
  const live = game.timelapse.peek(game);
  const recordFrom = rec[0]?.m ?? live.m;
  const color = (id: number) => game.lines.get(id)?.color ?? '#7a8794';
  // Сохранение до таймлапса: запись идёт с загрузки. Раньше — по журналу (если в нём есть что показать).
  const head = recordFrom > 0.5 ? journalFrames(game.journal.entries, color, recordFrom - 0.01) : [];
  const useful = head.length > 1 || head.some((f) => (f.s?.length ?? 0) > 0);
  const frames = [...(useful ? head : []), ...rec];
  if (!frames.length || live.m - frames[frames.length - 1].m > 0.01 || hasChanges(live)) frames.push(live);
  return { frames, rough: useful, recordFrom };
}

function hasChanges(f: TimelapseFrame): boolean {
  return TL_LAYERS.some((L) => (f[L]?.length ?? 0) > 0 || (f[`${L}d` as DelKey]?.length ?? 0) > 0);
}

/** Сколько месяцев партии покрывает таймлапс; меньше месяца — показывать пока нечего. */
export function timelapseSpan(src: TimelapseSource): number {
  const f = src.frames;
  return f.length > 1 ? f[f.length - 1].m - f[0].m : 0;
}
