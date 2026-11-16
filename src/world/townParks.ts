import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import { angleDiff, dist, type Vec } from '../core/vec';
import type { ParkKind, Town, TownPark } from './entities';
import { footprintRadius, footprintsOverlap, type Footprint } from './spatial';
import { edgeOf, townTier } from './townForms';

/**
 * Зелень города: парки, скверы, сквер с памятником в селе, бульвар на набережной (см. docs/DESIGN.md, «Парки и
 * скверы»). Только вид — жителей и рабочих мест не даёт и не отнимает: место берётся только из пустого (не на домах,
 * не на дорогах, не в воде), уже после того, как город застроен. Раскладка — без генератора случайных чисел партии:
 * по месту, размеру города и хешу от id города, поэтому мир по seed тот же, а старые сохранения получают парки при
 * загрузке по своим же данным.
 *
 * Рост города обходит парки: новый дом и новая улица на парк не встают (fillStreet, growStreet). Дорога игрока
 * может пройти через парк — полотно ложится поверх, парк остаётся вокруг. Парк, сквер, площадь и сквер с памятником
 * игрок может перенести (Game.movePark), площадь у ратуши едет и вместе с ратушей (hallPlaza).
 */

/** Что знает о месте расстановка: дома, дороги, вода (worldgen.parkSite — по миру партии). */
export interface ParkSite {
  /**
   * Участок свободен: не на домах, предприятиях и станциях (с запасом), не на дорогах и узлах, не на путях, в пределах
   * карты. shore — у самой воды можно (набережная): в воде не должно быть только самого участка; иначе — и запаса вокруг.
   */
  fits(fp: Footprint, shore?: boolean): boolean;
  /** Перекрёстки и стыки улиц около точки: где узел, куда уходят его улицы (углы) и полуширина самой широкой из них. */
  corners(center: Vec, r: number): { pos: Vec; dirs: number[]; half: number }[];
  /** Места у бордюра городских улиц около точки через step м: точка на оси, касательная и полуширина полотна. */
  curbs(center: Vec, r: number, step: number): { p: Vec; t: Vec; half: number }[];
  /** Направление ближайшей улицы. */
  angle(p: Vec): number;
  /** Расстояние до воды, м (не дальше cap: дальше — cap). */
  shore(p: Vec, cap: number): number;
  /** Сколько домов ближе r к точке: набережная — только у застроенного берега. */
  houses(p: Vec, r: number): number;
}

/** Сколько зелени нужно городу его размера. */
export function parkQuota(town: Pick<Town, 'population' | 'style' | 'tier'>): Record<ParkKind, number> {
  const tier = townTier(town);
  const pop = town.population;
  // Население — по жильцам домов: село — 300–800, город — 1500–5000, большой город — от ~6500.
  if (tier === 'village') return { park: 0, square: pop >= 500 ? 1 : 0, plaza: 0, memorial: 1, embankment: 0 };
  if (tier === 'town') return { park: 1, square: Math.min(4, 2 + Math.floor(pop / 2500)), plaza: 1, memorial: 0, embankment: 8 };
  return { park: pop >= 12000 ? 2 : 1, square: Math.min(8, 3 + Math.floor(pop / 3500)), plaza: 1, memorial: 0, embankment: 14 };
}

/** Масштаб застройки (config.TOWN_SCALE): кварталы крупнее — и парки, скверы, расстояния между ними тоже. */
const S = TOWN_SCALE;
const scaled = (list: [number, number][]): [number, number][] => list.map(([w, h]) => [w * S, h * S]);

/** Размеры большого парка, крупные — первыми: большой город, город. */
const PARK_SIZES: Record<'town' | 'city', [number, number][]> = {
  city: scaled([
    [120, 84],
    [100, 72],
    [84, 62],
    [70, 52],
    [58, 46],
  ]),
  town: scaled([
    [86, 62],
    [72, 54],
    [60, 46],
    [50, 40],
  ]),
};
const SQUARE_SIZES = scaled([
  [32, 24],
  [26, 20],
  [20, 16],
]);
const MEMORIAL_SIZES = scaled([
  [26, 20],
  [22, 17],
  [18, 15],
]);
/** Набережная: отрезок бульвара вдоль берега — длина и ширина (ширина — прогулочная, в масштабе дорог). */
const EMBANK = { w: 34 * S, h: 13 };
/** Ратуша и храм: площадь вокруг них шире участка (houseArt) — парк не ближе. */
const LANDMARK_PAD = 9;

const rect = (center: Vec, w: number, h: number, angle: number): Footprint => ({ center, w, h, angle });

/** Участок в осях угла a: точка center + u·(cos a, sin a) + v·(−sin a, cos a). */
function at(o: Vec, a: number, u: number, v: number): Vec {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: o.x + u * c - v * s, y: o.y + u * s + v * c };
}

/** Парк встаёт рядом с уже поставленными: не на них и не на площади у ратуши; minGap — между серединами (сверх радиусов). */
function clashes(marks: readonly Footprint[], list: readonly TownPark[], fp: Footprint, minGap: number): boolean {
  for (const p of list) {
    if (footprintsOverlap(fp, p.fp, 3)) return true;
    if (dist(fp.center, p.fp.center) < minGap + (footprintRadius(fp) + footprintRadius(p.fp)) / 2) return true;
  }
  for (const m of marks) if (footprintsOverlap(fp, m, LANDMARK_PAD)) return true;
  return false;
}

/** Большой парк: на свободном месте как можно ближе к центру, крупный — лучше чуть дальше, чем мелкий у самого центра. */
function bigPark(town: Town, site: ParkSite, list: TownPark[], marks: readonly Footprint[], tier: 'town' | 'city'): Footprint | null {
  const R = town.radius;
  const sizes = PARK_SIZES[tier];
  const turn = hash(town.id, 31) * Math.PI * 2;
  // Второй парк большого города — подальше от первого.
  const gap = list.some((p) => p.kind === 'park') ? R * 0.35 : 30 * S;
  const last = sizes.length - 1;
  // Шаг поиска и надбавка за размер мельче — в масштабе застройки.
  const step = 28 * S;
  const worse = 30 * S;
  let best: { fp: Footprint; score: number } | null = null;
  for (let r = 0; r <= R * 0.7; r += step) {
    // Дальше лучшего найденного (с поправкой на его размер) искать нет смысла.
    if (best && r >= best.score) break;
    const n = r === 0 ? 1 : Math.max(8, Math.round((Math.PI * 2 * r) / (34 * S)));
    for (let k = 0; k < n; k++) {
      const a = turn + (k / n) * Math.PI * 2;
      const c = { x: town.center.x + Math.cos(a) * r, y: town.center.y + Math.sin(a) * r };
      const angle = site.angle(c);
      for (const turned of [false, true]) {
        const make = (i: number) => (turned ? rect(c, sizes[i][1], sizes[i][0], angle) : rect(c, sizes[i][0], sizes[i][1], angle));
        const ok = (i: number) => !clashes(marks, list, make(i), gap) && site.fits(make(i));
        // Размеры вложены друг в друга: не встал самый маленький — не встанет и крупнее.
        if ((best && r >= best.score) || !ok(last)) continue;
        let i = 0;
        while (i < last && !(best && r + i * worse >= best.score) && !ok(i)) i++;
        if (best && r + i * worse >= best.score) continue;
        best = { fp: make(i), score: r + i * worse };
      }
    }
  }
  return best?.fp ?? null;
}

interface Spot {
  fp: Footprint;
  /** Меньше — лучше. */
  score: number;
  /** Место (угол или точка у бордюра): на одном месте — один сквер, крупный размер — первым. */
  place: number;
}

/**
 * Места под сквер около точки — ещё без проверки, что там пусто (её делает take, по порядку, пока не наберётся
 * нужное): пустые углы у перекрёстков (сквер — по одной из улиц, в углу между ними) и клочки вдоль улиц.
 * near — меньше, чем ближе к нужному; углу — бонус, крупному размеру — тоже; хеш — чтобы скверы не шли строем.
 */
function squareSpots(site: ParkSite, center: Vec, r: number, sizes: [number, number][], near: (p: Vec) => number, seed: number): Spot[] {
  const out: Spot[] = [];
  let place = 0;
  const score = (fp: Footprint, s: number, bonus: number) => near(fp.center) - bonus - (sizes.length - 1 - s) * 0.06 + hash(seed, place) * 0.08;
  for (const n of site.corners(center, r)) {
    const dirs = [...n.dirs].sort((x, y) => x - y);
    if (dirs.length < 2) continue;
    for (let i = 0; i < dirs.length; i++) {
      const a = dirs[i];
      const b = i + 1 < dirs.length ? dirs[i + 1] : dirs[0] + Math.PI * 2;
      const gap = b - a;
      if (gap < 1.1 || gap > 3.4) continue;
      place++;
      // Вдоль улицы a и поперёк неё — в сторону улицы b; дальше от угла — с шагом, если у самого угла тесно.
      for (let k = 0; k < 3; k++) {
        for (let s = 0; s < sizes.length; s++) {
          const [w, h] = sizes[s];
          const off = n.half + 3 + k * 5 * S;
          const c = at(n.pos, a, off + w / 2, off + h / 2);
          if (Math.abs(angleDiff(Math.atan2(c.y - n.pos.y, c.x - n.pos.x), a + gap / 2)) > gap / 2) continue;
          const fp = rect(c, w, h, a);
          out.push({ fp, score: score(fp, s, 0.2 - k * 0.03), place });
        }
      }
    }
  }
  for (const q of site.curbs(center, r, 14 * S)) {
    for (const side of [1, -1]) {
      place++;
      for (let s = 0; s < sizes.length; s++) {
        const [w, h] = sizes[s];
        const off = q.half + 3 + h / 2;
        const fp = rect({ x: q.p.x - q.t.y * side * off, y: q.p.y + q.t.x * side * off }, w, h, Math.atan2(q.t.y, q.t.x));
        out.push({ fp, score: score(fp, s, 0), place });
      }
    }
  }
  return out.sort((x, y) => x.score - y.score);
}

/** Лучшие места по порядку, где и правда пусто и не тесно к другим паркам (ok), — не больше want, по одному на место. */
function take(spots: Spot[], site: ParkSite, want: number, ok: (fp: Footprint) => boolean, put: (fp: Footprint) => void): void {
  const used = new Set<number>();
  for (const s of spots) {
    if (used.size >= want) break;
    if (used.has(s.place) || !ok(s.fp) || !site.fits(s.fp)) continue;
    used.add(s.place);
    put(s.fp);
  }
}

/**
 * Площадь у ратуши: мощёный прямоугольник вплотную к одной из сторон её участка — перед фасадом, по бокам или за
 * ней, где шире всего (на участке ратуши своя площадь в 7 м — houseArt, они сливаются).
 */
export function plazaBy(hall: Footprint, site: ParkSite, list: readonly TownPark[]): Footprint | null {
  let best: { fp: Footprint; area: number } | null = null;
  const sides: [number, number][] = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  for (const [ux, uy] of sides) {
    const along = uy !== 0;
    const half = along ? hall.h / 2 : hall.w / 2;
    const side = along ? hall.w : hall.h;
    for (const width of [side + 16, side, side * 0.7]) {
      // Узкая площадь — посередине стороны или ближе к одному из углов.
      for (const shift of width < side ? [0, -(side - width) / 2, (side - width) / 2] : [0]) {
        for (const depth of [36 * S, 28 * S, 20 * S, 14 * S]) {
          const u = along ? shift : ux * (half + 3.5 + depth / 2);
          const v = along ? uy * (half + 3.5 + depth / 2) : shift;
          const c = at(hall.center, hall.angle, u, v);
          const fp = along ? rect(c, width, depth, hall.angle) : rect(c, depth, width, hall.angle);
          // Площадь больше прежней найденной — только если крупнее; мельче — дальше не пробуем.
          const area = width * depth * (along ? 1.1 : 1);
          if (best && area <= best.area) break;
          if (clashes([], list, fp, 0) || !site.fits(fp)) continue;
          best = { fp, area };
          break;
        }
      }
    }
  }
  return best?.fp ?? null;
}

/** Набережная: отрезки бульвара вдоль берега в черте города — у воды, не на домах и не на дорогах. */
function embankments(town: Town, site: ParkSite, list: TownPark[], marks: readonly Footprint[], want: number): Footprint[] {
  const R = town.radius * 0.95;
  if (site.shore(town.center, R + 20) >= R + 20) return [];
  const step = 16;
  // Крупная сетка: клетка 5×5 мелких шагов без воды поблизости — мимо целиком.
  const big = step * 5;
  const pts: { p: Vec; d: number }[] = [];
  for (let by = -R; by <= R; by += big) {
    for (let bx = -R; bx <= R; bx += big) {
      const mid = { x: town.center.x + bx + big / 2, y: town.center.y + by + big / 2 };
      if (site.shore(mid, big * 0.75 + 16) >= big * 0.75 + 16) continue;
      for (let y = by; y < by + big && y <= R; y += step) {
        for (let x = bx; x < bx + big && x <= R; x += step) {
          if (x * x + y * y > R * R) continue;
          const p = { x: town.center.x + x, y: town.center.y + y };
          const d = site.shore(p, 24);
          if (d >= 7 && d <= 14) pts.push({ p, d });
        }
      }
    }
  }
  // От центра к краю: ближние к центру набережные — первыми.
  pts.sort((a, b) => dist(a.p, town.center) - dist(b.p, town.center));
  const out: Footprint[] = [];
  /** Отрезок у воды около точки p: длинной стороной вдоль берега, вода — со стороны +y, край у воды — в 1,5 м от неё. */
  const segment = (p: Vec): Footprint | null => {
    const d = site.shore(p, 40);
    if (d < 4 || d > 22) return null;
    // К воде — против роста расстояния до неё.
    const e = 5;
    const gx = site.shore({ x: p.x + e, y: p.y }, 40) - site.shore({ x: p.x - e, y: p.y }, 40);
    const gy = site.shore({ x: p.x, y: p.y + e }, 40) - site.shore({ x: p.x, y: p.y - e }, 40);
    const gl = Math.hypot(gx, gy);
    if (gl < 0.5) return null;
    const tx = -gx / gl;
    const ty = -gy / gl;
    const shift = d - EMBANK.h / 2 - 1.5;
    // Ось +y участка — к воде: угол оси x — на четверть оборота меньше.
    return rect({ x: p.x + tx * shift, y: p.y + ty * shift }, EMBANK.w, EMBANK.h, Math.atan2(ty, tx) - Math.PI / 2);
  };
  // Соседние отрезки цепочки заходят друг на друга на полметра — набережная без щелей.
  const ok = (fp: Footprint, houses: number) =>
    !out.some((f) => footprintsOverlap(f, fp, -1.2)) && !clashes(marks, list, fp, -60) && site.houses(fp.center, 90 * S) >= houses && site.fits(fp, true);
  for (const { p } of pts) {
    if (out.length >= want) break;
    if (out.some((f) => dist(f.center, p) < EMBANK.w)) continue;
    const first = segment(p);
    if (!first || !ok(first, 3)) continue;
    out.push(first);
    // Набережная — цепочкой: от отрезка в обе стороны вдоль берега, пока есть место и не кончилась квота.
    for (const dir of [1, -1]) {
      let cur = first;
      while (out.length < want) {
        const ux = Math.cos(cur.angle) * dir;
        const uy = Math.sin(cur.angle) * dir;
        const next = segment({ x: cur.center.x + ux * (EMBANK.w - 0.5), y: cur.center.y + uy * (EMBANK.w - 0.5) });
        if (!next || Math.abs(angleDiff(next.angle, cur.angle)) > 0.7 || !ok(next, 1)) break;
        out.push(next);
        cur = next;
      }
    }
  }
  return out;
}

/**
 * Зелень городу — сколько не хватает до parkQuota: большой парк, скверы, сквер с памятником в селе, набережная.
 * Уже стоящие — в счёт и не трогаются (город вырос — добавятся новые). Возвращает число новых.
 */
export function placeParks(town: Town, site: ParkSite): number {
  const list = town.parks ?? [];
  const quota = parkQuota(town);
  const have = (k: ParkKind) => list.filter((p) => p.kind === k).length;
  let next = list.reduce((m, p) => Math.max(m, p.id - town.id * 100 + 1), 0);
  const before = list.length;
  const push = (kind: ParkKind, fp: Footprint) => list.push({ id: town.id * 100 + next++, kind, fp });
  const tier = townTier(town);
  const R = town.radius;
  const landmark = town.buildings.find((b) => b.kind === 'landmark');
  const marks = landmark ? [landmark.fp] : [];

  if (landmark && have('plaza') < quota.plaza) {
    const fp = plazaBy(landmark.fp, site, list);
    if (fp) push('plaza', fp);
  }
  if (tier !== 'village') {
    for (let k = have('park'); k < quota.park; k++) {
      const fp = bigPark(town, site, list, marks, tier);
      if (!fp) break;
      push('park', fp);
    }
  }
  if (have('memorial') < quota.memorial) {
    const c = landmark?.fp.center ?? town.center;
    const spots = squareSpots(site, c, 170 * S, MEMORIAL_SIZES, (p) => dist(p, c) / (170 * S), town.id);
    take(spots, site, 1, (fp) => !clashes(marks, list, fp, 20), (fp) => push('memorial', fp));
  }
  const left = quota.square - have('square');
  if (left > 0) {
    // Скверы — по всему городу, кроме самого края; не теснее друг к другу, чем на ~0,3 радиуса.
    const spots = squareSpots(site, town.center, R * 0.9, SQUARE_SIZES, (p) => edgeOf(town, p) * 0.8, town.id + 7);
    const gap = Math.max(70 * S, R * 0.3);
    // Каждый новый сквер сразу в списке: следующий проверяется и против него.
    take(spots, site, left, (fp) => !clashes(marks, list, fp, gap), (fp) => push('square', fp));
  }
  const banks = quota.embankment - have('embankment');
  if (banks > 0) for (const fp of embankments(town, site, list, marks, banks)) push('embankment', fp);
  town.parks = list;
  return list.length - before;
}

/** Что можно перенести «Перенести» в карточке (Game.movePark): всё, кроме набережной — она у воды по своей природе. */
export const movablePark = (p: Pick<TownPark, 'kind'>) => p.kind !== 'embankment';

/** Перенос парка: $0,6 за м² участка (пересадить деревья, переложить дорожки), не меньше $1 000 — сквер ~$1 200, парк ~$8 000. */
export const parkMoveCost = (p: Pick<TownPark, 'fp'>) => Math.max(1000, Math.round((p.fp.w * p.fp.h * 0.6) / 10) * 10);

/**
 * Площадь у ратуши, которая едет вместе с ней (Game.movePlan): площадь города (она у него одна, plazaBy), если она
 * примыкает к участку ратуши (plazaBy ставит её в 3,5 м от него) или игрок её не переносил сам (её оставил на старом
 * месте прежний перенос ратуши — вернётся к ней).
 */
export function hallPlaza(town: Pick<Town, 'parks'>, hall: Footprint): TownPark | null {
  const plaza = town.parks?.find((p) => p.kind === 'plaza');
  if (!plaza) return null;
  return plazaAttached(hall, plaza.fp) || !plaza.moved ? plaza : null;
}

/** Площадь примыкает к участку ратуши: между ними не больше 6 м. */
export const plazaAttached = (hall: Footprint, plaza: Footprint) => footprintsOverlap(hall, plaza, 6);

/**
 * Участок fp, что был при from, — при to (from и to — участки с поворотом их рисунка fromAngle и toAngle): сдвиг и
 * поворот те же, что у них, — площадь у ратуши с той же стороны фасада и в том же месте вдоль него.
 */
export function carryFootprint(fp: Footprint, from: Footprint, fromAngle: number, to: Footprint, toAngle: number): Footprint {
  const dx = fp.center.x - from.center.x;
  const dy = fp.center.y - from.center.y;
  const u = dx * Math.cos(fromAngle) + dy * Math.sin(fromAngle);
  const v = -dx * Math.sin(fromAngle) + dy * Math.cos(fromAngle);
  return { center: at(to.center, toAngle, u, v), w: fp.w, h: fp.h, angle: fp.angle + toAngle - fromAngle };
}

/** Участок задевает парк города (с запасом margin): рост города сюда дом не ставит. */
export function onPark(town: Pick<Town, 'parks'>, fp: Footprint, margin = 2): boolean {
  return !!town.parks?.some((p) => footprintsOverlap(fp, p.fp, margin));
}

/** Точка ближе r к парку какого-нибудь города: новая улица города через парк не идёт. */
export function nearPark(towns: readonly Pick<Town, 'parks'>[], p: Vec, r: number): boolean {
  for (const t of towns) {
    for (const k of t.parks ?? []) {
      if (dist(p, k.fp.center) > footprintRadius(k.fp) + r) continue;
      const c = Math.cos(k.fp.angle);
      const s = Math.sin(k.fp.angle);
      const dx = p.x - k.fp.center.x;
      const dy = p.y - k.fp.center.y;
      if (Math.abs(dx * c + dy * s) <= k.fp.w / 2 + r && Math.abs(-dx * s + dy * c) <= k.fp.h / 2 + r) return true;
    }
  }
  return false;
}
