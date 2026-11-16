/**
 * Улицы, снесённые игроком: город здесь больше не прокладывает улиц (Town.streetBans, Game.growStreet).
 *
 * Город растёт по правилам (game.ts, growStreet): перемычка между улицами, переулок в просвете, продолжение улицы
 * через перекрёсток. Снесённая улица оставляет то же место и те же концы — и город на следующий же месяц кладёт её
 * снова. Поэтому снос игроком запоминается осью снесённого куска, и новую улицу вдоль неё город не строит.
 *
 * Запрет — навсегда, а не на N лет: снос — решение игрока, и улица, вернувшаяся через годы, — та же ошибка, только
 * позже и неожиданнее. Мешает запрет одной линии: улицы поперёк и рядом город прокладывает как обычно, а место
 * между улицами застраивает домами. Снимают запрет Ctrl+Z сноса и дорога игрока на том же месте (её потом снесут —
 * запрет встанет снова).
 */
import { closestOnSegment, dist, type Vec } from '../core/vec';
import type { Corridor } from '../lanes/model';

export const STREET_BAN = {
  /** Шаг точек оси запрета, м. */
  step: 8,
  /** Ближе этого к оси — то же место, м: полуширина улицы с запасом. */
  near: 8,
  /** Кусок снесённой улицы короче этого не запоминаем (огрызки у перекрёстков, кольцо на месте перекрёстка), м. */
  minRun: 30,
  /** Запретов у города не больше: самые старые забываются. */
  max: 64,
};

/** Значок «город здесь больше не строит» — в подписи сноса городской улицы (controller.ts) и в подсказке инструмента. */
export const STREET_BAN_MARK = '🏘✕';
export const STREET_BAN_TIP = 'Город здесь больше не проложит улицу. Снимут запрет Ctrl+Z или ваша дорога на этом месте';

const round =(p: Vec): Vec => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });

/** Длина ломаной. */
function polyLength(pts: Vec[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** От точки до ломаной. */
function polyDist(p: Vec, pts: Vec[]): number {
  if (pts.length === 1) return dist(p, pts[0]);
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, closestOnSegment(p, pts[i - 1], pts[i]).d);
  return d;
}

/**
 * Куски оси полотна c, которых нет под дорогами (covered — точка под дорогой), не короче STREET_BAN.minRun: что
 * снос убрал на самом деле. Слияние полотен, перенос на пару метров, смена полос — всё это под дорогой.
 */
export function uncoveredRuns(c: Corridor, covered: (p: Vec) => boolean): Vec[][] {
  const S = STREET_BAN;
  const n = Math.max(1, Math.round(c.length / S.step));
  const runs: Vec[][] = [];
  let run: Vec[] = [];
  const close = () => {
    if (run.length > 1 && polyLength(run) >= S.minRun) runs.push(run.map(round));
    run = [];
  };
  for (let i = 0; i <= n; i++) {
    const p = c.lut.pointAt((c.length * i) / n);
    if (covered(p)) close();
    else run.push(p);
  }
  close();
  return runs;
}

/** Запрет лежит под дорогой (её построил игрок): больше 70 % его точек — под ней. */
export function banCovered(ban: Vec[], covered: (p: Vec) => boolean): boolean {
  return ban.filter(covered).length > ban.length * 0.7;
}

/**
 * Полотно c идёт вдоль запрета ban: вдоль его оси (ближе STREET_BAN.near) — не меньше половины короткого из двух
 * и не меньше 20 м. Улица поперёк запрета или от его конца в сторону — не вдоль.
 */
export function alongBan(c: Corridor, ban: Vec[]): boolean {
  const S = STREET_BAN;
  const { p0, p1, p2, p3 } = c.curve;
  const r = S.near;
  const xs = ban.map((p) => p.x);
  const ys = ban.map((p) => p.y);
  if (Math.max(p0.x, p1.x, p2.x, p3.x) < Math.min(...xs) - r || Math.min(p0.x, p1.x, p2.x, p3.x) > Math.max(...xs) + r) return false;
  if (Math.max(p0.y, p1.y, p2.y, p3.y) < Math.min(...ys) - r || Math.min(p0.y, p1.y, p2.y, p3.y) > Math.max(...ys) + r) return false;
  const step = 4;
  const n = Math.max(1, Math.round(c.length / step));
  let hits = 0;
  for (let i = 0; i <= n; i++) if (polyDist(c.lut.pointAt((c.length * i) / n), ban) < r) hits++;
  const overlap = (hits / (n + 1)) * c.length;
  return overlap >= 20 && overlap >= 0.5 * Math.min(c.length, polyLength(ban));
}
