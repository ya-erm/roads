/**
 * Стройка полотна — чистые расчёты, без игры (их берут и строитель дорог, и стройка): сколько секунд метр этого
 * полотна, сколько уже заплачено за готовое, перенос готового из одной копии сети в другую.
 */
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import type { Corridor, LaneNet } from '../lanes/model';

/** Во сколько раз метр сооружения на высоте h (уровень) дольше метра на земле; water — под ним вода. */
export function structureWork(h: number, water: boolean): number {
  const K = CONSTRUCTION;
  if (h < -0.25) return 1 + (K.tunnel - 1) * Math.min(-h, 1);
  const up = h > 0.25 ? 1 + (K.bridge - 1) * Math.min(h, 1) + (K.overpass - K.bridge) * Math.max(0, Math.min(1, h - 1)) : 1;
  return water ? Math.max(up, K.water) : up;
}

/**
 * Во сколько раз метр полотна строится дольше метра обычной дороги (улица 1+1 на земле): класс, полосы сверх двух,
 * мосты, эстакады и тоннели — по высоте вдоль оси (пандус — по промежуточной).
 */
export function workFactor(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  const K = CONSTRUCTION;
  const n = Math.max(2, Math.ceil(c.length / 24));
  let struct = 0;
  for (let i = 0; i < n; i++) {
    const s = (c.length * (i + 0.5)) / n;
    const h = net.heightAt(c, s);
    // Вода важна только для моста над ней: на земле дорога через воду не идёт.
    struct += structureWork(h, h > 0.25 && isWater(c.lut.pointAt(s), 2));
  }
  struct /= n;
  return K.cls[c.cls] * (1 + K.lane * Math.max(0, c.lanes.length - 2)) * struct;
}

/** Метров в секунду игры на скорости ×1 для этого полотна. */
export function buildRate(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  return CONSTRUCTION.speed / workFactor(net, c, isWater);
}

/** На сколько метров этап колонны отстаёт от предыдущего на участке длиной L. */
export function convoyGap(L: number): number {
  return Math.min(CONSTRUCTION.convoyGap, L / 4);
}

/**
 * Этапы участка (CONSTRUCTION.stages) идут колонной: впереди земляные работы, за ними на convoyGap — покрытие, за ним
 * так же — разметка и знаки; этап, которому впереди уже некого ждать (предыдущий дошёл до конца), догоняет до конца.
 * Голова колонны x: этап k — на x − k·gap (в пределах участка), работа — сумма долей этапов по пройденному ими.
 * done — сколько работы готово «в метрах» (0…L, как платится); ответ — докуда (метров от начала заполнения) дошёл
 * каждый этап.
 */
export function stageSpans(done: number, L: number): [number, number, number] {
  if (!(L > 0) || done <= 0) return [0, 0, 0];
  // Конец этапа — ровно L (без хвоста от деления дробей).
  if (done >= L) return [L, L, L];
  const w = CONSTRUCTION.stages;
  const g = convoyGap(L);
  const at = (x: number): [number, number, number] => [0, 1, 2].map((k) => Math.max(0, Math.min(L, x - k * g))) as [number, number, number];
  const work = (x: number) => at(x).reduce((sum, s, k) => sum + w[k] * s, 0);
  // Работа от головы колонны — ломаная: изломы там, где этап начинается или доходит до конца.
  const knots = [0, g, 2 * g, L, L + g, L + 2 * g].sort((p, q) => p - q);
  for (let i = 0; i + 1 < knots.length; i++) {
    const [x0, x1] = [knots[i], knots[i + 1]];
    const [d0, d1] = [work(x0), work(x1)];
    if (done <= d1 && d1 > d0) return at(x0 + ((done - d0) / (d1 - d0)) * (x1 - x0));
  }
  return [L, L, L];
}

/**
 * Край работ на участке — голова колонны: метров от начала заполнения и её этап (0 — земля, 1 — покрытие, 2 — разметка;
 * этап, дошедший до конца, головой уже не считается).
 */
export function frontOf(done: number, L: number): { s: number; stage: 0 | 1 | 2 } {
  const [earth, pave, marks] = stageSpans(done, L);
  if (earth < L - 1e-6) return { s: earth, stage: 0 };
  if (pave < L - 1e-6) return { s: pave, stage: 1 };
  return { s: marks, stage: 2 };
}

/** Сколько заплачено за done готовых метров полотна длиной L ценой full: целые доллары, сумма тактов — та же. */
export function paidFor(full: number, done: number, L: number): number {
  return L > 0 ? Math.round(full * Math.max(0, Math.min(1, done / L))) : 0;
}

/**
 * Готовое — из сети from (живой) в сеть to (план, снимок для отмены): у тех же полотен (по номеру) берётся больше
 * готового; построенное там целиком — построено и тут. Нужна там, где сеть заменяют копией, сделанной раньше:
 * стройка за это время ушла вперёд. Поменянные полотна получают новую ревизию (отрисовка и граф их обновят).
 */
export function carryBuild(from: LaneNet, to: LaneNet): void {
  for (const c of to.corridors.values()) {
    if (!c.build) continue;
    const o = from.corridors.get(c.id);
    // То же полотно: копии, разошедшиеся давно, могли дать один номер разным полотнам — сверяем и концы.
    const same = (u: Vec, v: Vec) => Math.abs(u.x - v.x) < 0.01 && Math.abs(u.y - v.y) < 0.01;
    if (!o || !same(o.curve.p0, c.curve.p0) || !same(o.curve.p3, c.curve.p3)) continue;
    if (!o.build) {
      delete c.build;
      to.touch(c);
    } else if (o.build.project === c.build.project && o.build.done > c.build.done) {
      c.build = { ...o.build, done: Math.min(c.length, o.build.done) };
    }
  }
}
