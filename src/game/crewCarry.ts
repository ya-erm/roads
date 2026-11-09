/**
 * Перенос техники вместе с подвинутой дорогой (режим «Со строительством»): игрок изогнул или перенёс полотно, пока его
 * строят («Двигать», проект перемещения, Ctrl+Z такой правки), — сеть дорог заменили новой, где у полотна тот же номер,
 * а форма другая. Машины бригад вне потока стоят и едут по заранее посчитанным точкам (полоса бригады CrewLane, путь
 * вдоль стройки SiteTrip, места spots, доехавшие машины колонны): без переноса они остались бы там, где полотно было.
 *
 * Каждая такая точка у подвинутого полотна (ближайшее к ней полотно прежней сети — оно) переезжает на то же место
 * относительно его оси: на той же стороне и на том же расстоянии от оси, а вдоль — у строящегося полотна готовое и
 * край работ остаются на тех же метрах от начала заполнения (стройка их не теряет: CorridorBuild — в метрах), дальняя,
 * не начатая часть растягивается или сжимается до нового конца; у готового — по доле длины. Точки у других дорог
 * остаются на месте: машины на готовых дорогах никуда не прыгают, а с подвинутым полотном едут те, что на нём.
 *
 * Полоса бригады после переноса — та же полоса (те же участки, ряды, порядок машин), только по новой оси: машины —
 * на соответствующих местах (CrewLane.from — с того места, где каждая сейчас, и с этой секунды), дальше едут к своим
 * местам этапов как обычно. Детерминированно: только геометрия старой и новой сети, без случайности; формат
 * сохранения тот же.
 */
import { smoothstep } from '../core/math';
import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { Corridor, LaneNet } from '../lanes/model';
import { spansOf } from './constructionWork';
import { laneArcs, laneCars, polyLength, ROW_RAMP } from './crewLane';
import type { Brigade } from './crews';

/** Насколько далеко от оси подвинутого полотна точка ещё считается на нём, м (ряды техники, съезд к нему). */
const REACH = 25;

/** Одна и та же точка (с точностью до сантиметра). */
const same = (u: Vec, v: Vec) => Math.abs(u.x - v.x) < 0.01 && Math.abs(u.y - v.y) < 0.01;

/** Подвинутое полотно: какое было (o) и какое стало (k) — тот же номер, другая форма. */
interface Moved {
  o: Corridor;
  k: Corridor;
}

/**
 * Перенос точек со старой сети from на новую to: точки у подвинутых полотен — на то же место относительно новой оси,
 * остальные — как были. Подвинутых нет — empty.
 */
export class CrewCarry {
  private readonly moved = new Map<number, Moved>();
  /** Рамка подвинутых полотен (с запасом REACH) — точки вне неё не проверяются. */
  private box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  constructor(
    private readonly from: LaneNet,
    to: LaneNet,
  ) {
    for (const o of from.corridors.values()) {
      const k = to.corridors.get(o.id);
      if (!k) continue;
      const a = o.curve;
      const b = k.curve;
      if (same(a.p0, b.p0) && same(a.p1, b.p1) && same(a.p2, b.p2) && same(a.p3, b.p3)) continue;
      this.moved.set(o.id, { o, k });
      for (const p of o.lut.points) {
        this.box.x0 = Math.min(this.box.x0, p.x - REACH);
        this.box.y0 = Math.min(this.box.y0, p.y - REACH);
        this.box.x1 = Math.max(this.box.x1, p.x + REACH);
        this.box.y1 = Math.max(this.box.y1, p.y + REACH);
      }
    }
  }

  /** Ни одно полотно не подвинуто — переносить нечего. */
  get empty(): boolean {
    return this.moved.size === 0;
  }

  /** Подвинутое полотно, у которого точка p (ближайшее к ней в прежней сети); нет — null. */
  private at(p: Vec): Moved | null {
    const { x0, y0, x1, y1 } = this.box;
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) return null;
    const c = this.from.corridorNear(p, REACH);
    return (c && this.moved.get(c.id)) ?? null;
  }

  /**
   * Где на новой оси место s старой (м от конца a): у строящегося — те же метры от начала заполнения до края работ
   * (отсыпки), дальше — растянуто до нового конца; у готового — по доле длины.
   */
  private station(m: Moved, s: number): number {
    const Lo = m.o.length;
    const Ln = m.k.length;
    const b = m.o.build ?? m.k.build;
    if (!b) return Lo > 1e-9 ? (s * Ln) / Lo : 0;
    const fromB = !!b.fromB;
    const u = fromB ? Lo - s : s;
    const F = Math.max(0, Math.min(spansOf(b, Lo)[0], Lo, Ln));
    const f = u <= F ? u : Lo - F > 1e-6 ? F + ((u - F) * (Ln - F)) / (Lo - F) : Ln;
    const v = Math.max(0, Math.min(Ln, f));
    return fromB ? Ln - v : v;
  }

  /** Точка p (и курс dir) — на новое место; не у подвинутого полотна — как была. */
  pose(p: Vec, dir?: Vec): { pos: Vec; dir?: Vec } {
    const m = this.at(p);
    if (!m) return { pos: { ...p }, ...(dir ? { dir: { ...dir } } : {}) };
    const hit = m.o.lut.closest(p);
    const t = m.o.lut.tangentAt(hit.s);
    const n = rightNormal(t);
    const v = sub(p, hit.point);
    const s2 = this.station(m, hit.s);
    const t2 = m.k.lut.tangentAt(s2);
    const n2 = rightNormal(t2);
    const pos = add(add(m.k.lut.pointAt(s2), scale(n2, dot(v, n))), scale(t2, dot(v, t)));
    // Курс — повёрнут так же, как ось полотна в этом месте.
    return { pos, ...(dir ? { dir: add(scale(t2, dot(dir, t)), scale(n2, dot(dir, n))) } : {}) };
  }

  /** Точка — на новое место. */
  point(p: Vec): Vec {
    return this.pose(p).pos;
  }

  /** Перенести всё, по чему машины бригады b стоят и едут вне потока; time — время игры; slots — места на полосе. */
  brigade(b: Brigade, time: number, slots: readonly number[] | null): void {
    if (b.pos) b.pos = this.point(b.pos);
    if (b.spots) b.spots = b.spots.map((m) => {
      const q = this.pose(m.pos, m.dir);
      return { pos: q.pos, dir: q.dir ?? m.dir };
    });
    b.convoy?.cars.forEach((c, i, list) => {
      if (!('at' in c)) return;
      const q = this.pose(c.at, c.dir);
      list[i] = { ...c, at: q.pos, dir: q.dir ?? c.dir };
    });
    if (b.trip) b.trip = { ...b.trip, path: b.trip.path.map((p) => this.point(p)) };
    if (b.lane) this.lane(b, time, slots);
  }

  /**
   * Полоса бригады — по новой оси: точки переносятся, места на ней (начала участков, перестроения в ряды, где машины)
   * — на соответствующие места новой полосы; машины трогаются к своим местам оттуда, где они теперь.
   */
  private lane(b: Brigade, time: number, slots: readonly number[] | null): void {
    const lane = b.lane!;
    const old = lane.path;
    const path = old.map((p) => this.point(p));
    if (path.every((p, i) => same(p, old[i]))) return;
    const arc = arcMap(old, path);
    // Где машины на полосе сейчас (по прежней) — до того, как полоса поменяется.
    const n = laneCars(lane);
    const now = lane.from && slots ? laneArcs(lane, slots, time).slice(0, n) : (lane.from?.slice(0, n) ?? null);
    lane.path = path;
    // Разворот (CrewLane.turn) — его точки тоже переезжают; места на нём — на столько же метров до его конца.
    const turn = lane.turn;
    const end = turn?.end;
    const shift = end !== undefined ? arc(end) - end : 0;
    if (turn) {
      turn.path = turn.path.map((p) => this.point(p));
      turn.end += shift;
      turn.lead += shift;
      if (turn.back) turn.back = [turn.back[0] + shift, turn.back[1] + shift];
    }
    const along = (s: number) => (end !== undefined && s < end ? s + shift : arc(s));
    let prev: { at: number; corridor: number } | null = null;
    for (const g of lane.legs) {
      // Начало следующего участка — ровно за концом предыдущего (как строит полосу Construction.crewLane).
      const was: Moved | undefined = prev ? this.moved.get(prev.corridor) : undefined;
      g.at = prev && was ? prev.at + was.k.length : arc(g.at);
      prev = g;
    }
    if (lane.shifts) lane.shifts = lane.shifts.map((sh) => ({ ...sh, at: arc(sh.at) }));
    if (!now || !lane.from) return;
    // Сошедшая вбок от полосы машина ещё выходит на неё — остаток сдвига, дальше выходит с нового места.
    const side = now.map((s, k) => {
      const off = lane.side?.[k] ?? 0;
      const s0 = lane.from?.[k];
      if (Math.abs(off) < 1e-6 || s0 === undefined) return 0;
      const u = (s - s0) / ROW_RAMP;
      return u >= 1 ? 0 : off * (1 - smoothstep(Math.max(0, u)));
    });
    lane.from = now.map((s) => along(s));
    // Колонна ждёт разворота — ждёт и дальше; уже едет — все с одной скоростью, на тех же расстояниях друг от друга.
    if (turn?.wait) return;
    lane.t0 = time;
    lane.t = lane.from.map(() => time);
    if (side.some((x) => Math.abs(x) > 0.05)) lane.side = side.map((x) => (Math.abs(x) > 0.05 ? x : 0));
    else delete lane.side;
  }
}

/**
 * Место на прежней ломаной old (м от начала) — место на новой path с теми же вершинами (точки перенесены по одной):
 * та же доля того же отрезка. Позади начала и за концом — на столько же метров.
 */
function arcMap(old: readonly Vec[], path: readonly Vec[]): (s: number) => number {
  const cumOld = [0];
  const cumNew = [0];
  for (let i = 1; i < old.length; i++) {
    cumOld.push(cumOld[i - 1] + Math.hypot(old[i].x - old[i - 1].x, old[i].y - old[i - 1].y));
    cumNew.push(cumNew[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const totalOld = cumOld[cumOld.length - 1];
  const totalNew = polyLength(path);
  return (s) => {
    if (s <= 0 || old.length < 2) return s;
    if (s >= totalOld) return totalNew + (s - totalOld);
    let lo = 0;
    let hi = cumOld.length - 1;
    // Последняя вершина не дальше s.
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumOld[mid] <= s) lo = mid;
      else hi = mid;
    }
    const len = cumOld[lo + 1] - cumOld[lo];
    const f = len > 1e-9 ? (s - cumOld[lo]) / len : 0;
    return cumNew[lo] + f * (cumNew[lo + 1] - cumNew[lo]);
  };
}
