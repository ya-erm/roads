import { GRADE } from '../config';
import { CurveLUT } from '../core/bezier';
import type { Vec } from '../core/vec';

/**
 * Продольный профиль дороги или пути по рельефу. Важен уклон вдоль оси, а не крутизна склона: дорога
 * поперёк изолиний поднимается круто, вдоль них — почти ровно. Полотно повторяет рельеф, а где вдоль оси
 * круче допустимого — выравнивается: на подъёме срезается выемкой, в низине поднимается насыпью.
 * Концы — на земле (узлы стыкуются с соседними дорогами).
 */

export interface GroundProfile {
  /** Отметка полотна в точках выборки. */
  z: Float64Array;
  /** Отметка земли (NaN — вода: там мост, земли нет). */
  h: Float64Array;
  /** Наибольшая глубина выемки и высота насыпи, м. */
  cut: number;
  fill: number;
  /** Наибольший уклон полотна, м/м. */
  grade: number;
  /** Подъём между концами круче допустимого: выровнять нельзя, нужна дорога длиннее. */
  steep: boolean;
}

/**
 * Выравнивание полотна, как при проектировании дороги: от конца до конца — прямой уклон, если земля отходит
 * от него не больше чем на smooth м (бугры срезаются, ложбинки засыпаются); иначе полотно ложится на землю
 * в самой отстоящей точке, и так же — по обе стороны от неё. Выходит ломаная из ровных участков.
 */
function levelOut(z: Float64Array, h: ArrayLike<number>, smooth: number): void {
  const stack: [number, number][] = [[0, z.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let worst = -1;
    let far = smooth;
    for (let k = a + 1; k < b; k++) {
      if (Number.isNaN(h[k])) continue;
      const d = Math.abs(h[k] - (z[a] + ((z[b] - z[a]) * (k - a)) / (b - a)));
      if (d > far) {
        far = d;
        worst = k;
      }
    }
    if (worst < 0) {
      for (let k = a + 1; k < b; k++) z[k] = z[a] + ((z[b] - z[a]) * (k - a)) / (b - a);
      continue;
    }
    z[worst] = h[worst];
    stack.push([a, worst], [worst, b]);
  }
}

/**
 * Профиль по отметкам земли h (шаг ds) с уклоном не круче maxGrade: полотно выровнено — неровности до smooth м
 * срезаются и засыпаются (см. levelOut), а где вдоль оси круче maxGrade — срезается выемкой и поднимается
 * насыпью ровно настолько, насколько нужно; концы — на земле или на заданной высоте (pins).
 */
export function designProfile(
  h: ArrayLike<number>,
  ds: number,
  maxGrade: number,
  pins?: { start: number; end: number },
  smooth = 0,
): GroundProfile {
  const n = h.length;
  const g = maxGrade * ds;
  // Концы — на земле или, если заданы, на своей высоте (мост, тоннель, «конец на 6 м выше начала»).
  const h0 = pins?.start ?? (Number.isNaN(h[0]) ? 0 : h[0]);
  const h1 = pins?.end ?? (Number.isNaN(h[n - 1]) ? h0 : h[n - 1]);
  const steep = Math.abs(h1 - h0) > g * (n - 1) + 1e-6;
  // Начинаем с земли (над водой — по прямой между берегами), концы — на своих отметках.
  const z = new Float64Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(h[i])) continue;
    for (let k = last + 1; k < i; k++) z[k] = z[last] + ((z[i] = h[i]) - z[last]) * ((k - last) / (i - last));
    z[i] = h[i];
    last = i;
  }
  for (let k = last + 1; k < n; k++) z[k] = z[last];
  z[0] = h0;
  z[n - 1] = h1;
  if (smooth > 0) levelOut(z, h, smooth);
  // Где соседние точки расходятся круче maxGrade — сдвигаем обе навстречу поровну (концы стоят): выемка
  // на гребне, насыпь в лощине, ровно столько, сколько нужно, и только рядом с крутым местом.
  let converged = steep;
  if (!steep) {
    for (let sweep = 0; sweep < Math.min(50 * n, Math.max(200, 600000 / n)); sweep++) {
      let worst = 0;
      const fix = (i: number) => {
        const d = z[i + 1] - z[i];
        const ex = Math.abs(d) - g;
        if (ex <= 1e-9) return;
        worst = Math.max(worst, ex);
        const sgn = Math.sign(d);
        const a = i > 0;
        const b = i + 1 < n - 1;
        if (a && b) {
          z[i] += (sgn * ex) / 2;
          z[i + 1] -= (sgn * ex) / 2;
        } else if (a) z[i] += sgn * ex;
        else if (b) z[i + 1] -= sgn * ex;
      };
      if (sweep % 2 === 0) for (let i = 0; i < n - 1; i++) fix(i);
      else for (let i = n - 2; i >= 0; i--) fix(i);
      if (worst < 1e-4) {
        converged = true;
        break;
      }
    }
  }
  // Долгий крутой подъём попарно не выровнять быстро — берём середину между огибающими «только срезать» и
  // «только насыпать» (уклон в пределах всегда), прижатую к концам.
  if (!converged) {
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      lo[i] = Number.isNaN(h[i]) ? Infinity : h[i];
      hi[i] = Number.isNaN(h[i]) ? -Infinity : h[i];
    }
    for (let i = 1; i < n; i++) {
      lo[i] = Math.min(lo[i], lo[i - 1] + g);
      hi[i] = Math.max(hi[i], hi[i - 1] - g);
    }
    for (let i = n - 2; i >= 0; i--) {
      lo[i] = Math.min(lo[i], lo[i + 1] + g);
      hi[i] = Math.max(hi[i], hi[i + 1] - g);
    }
    for (let i = 0; i < n; i++) {
      let v = Number.isFinite(lo[i]) && Number.isFinite(hi[i]) ? (lo[i] + hi[i]) / 2 : 0;
      v = Math.max(h0 - g * i, Math.min(h0 + g * i, v));
      z[i] = Math.max(h1 - g * (n - 1 - i), Math.min(h1 + g * (n - 1 - i), v));
    }
  }
  let cut = 0;
  let fill = 0;
  let grade = 0;
  for (let i = 0; i < n; i++) {
    const ground = h[i];
    if (!Number.isNaN(ground)) {
      cut = Math.max(cut, ground - z[i]);
      fill = Math.max(fill, z[i] - ground);
    }
    if (i > 0) grade = Math.max(grade, Math.abs(z[i] - z[i - 1]) / ds);
  }
  return { z, h: Float64Array.from(h), cut, fill, grade, steep };
}

/** Шаг выборки профиля вдоль оси, м. */
export const PROFILE_STEP = 8;

/** Профиль по кривой lut: отметки земли ground (вода — NaN) с шагом ~PROFILE_STEP, выровненный (GRADE.smooth). */
export function curveProfile(lut: CurveLUT, ground: (p: Vec) => number, maxGrade: number): GroundProfile & { ds: number } {
  const n = Math.max(2, Math.ceil(lut.length / PROFILE_STEP) + 1);
  const ds = lut.length / (n - 1);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = ground(lut.pointAt(ds * i));
  return { ...designProfile(h, ds, maxGrade, undefined, GRADE.smooth), ds };
}

/** Насыпь или выемка, при которой полотну нужна уже не земля, а мост или тоннель. */
export function earthworkProblem(p: GroundProfile & { ds?: number }, maxGrade: number, maxDepth: number): string | undefined {
  const pct = Math.round(maxGrade * 100);
  if (p.steep) {
    // Уклон от конца до конца (ds известен — с числом, как у моста): «Слишком крутой подъём: 47% (можно до 10%)».
    const n = p.z.length;
    const rise = p.z[n - 1] - p.z[0];
    if (p.ds && n > 1 && Number.isFinite(rise)) return steepText(rise / (p.ds * (n - 1)), maxGrade, 'ведите длиннее, наискось по склону');
    return `Подъём круче ${pct}% — ведите длиннее, наискось по склону`;
  }
  if (p.cut > maxDepth && p.cut >= p.fill) return `Выемка ${Math.round(p.cut)} м: круче ${pct}% — нужен тоннель или путь наискось`;
  if (p.fill > maxDepth) return `Насыпь ${Math.round(p.fill)} м: круче ${pct}% — нужен мост или путь наискось`;
  return undefined;
}

/**
 * «Слишком крутой подъём: 44% (можно до 10%) — удлините дорогу»: уклон grade и предел max (м/м). Чуть круче
 * допустимого — с десятыми, а не «10% (можно до 10%)».
 */
export function steepText(grade: number, max: number, hint = 'удлините дорогу'): string {
  const lim = Math.floor(max * 1000 + 1e-6) / 10;
  const pct = Math.abs(grade) * 100;
  const comma = (v: number) => `${v}`.replace('.', ',');
  const text = pct - lim >= 1 ? `${Math.round(pct)}` : comma(Math.ceil(pct * 10) / 10);
  return `Слишком крутой подъём: ${text}% (можно до ${comma(lim)}%) — ${hint}`;
}

/**
 * Уклон моста, эстакады, тоннеля или пандуса между узлами: za и zb — отметки полотна в узлах (земля под узлом
 * и высота полотна над ней), length — длина полотна. Не круче maxGrade — как у дороги того же рода на земле
 * (иначе мост «по склону» поднимает дорогу на любую гору). У пандуса (смена уровня) — ещё запас slack, м: его
 * подножие на земле, а дорога к нему сама может идти до стольких метров выше или ниже земли (насыпь, выемка).
 * Допуск 0,5 м — на округление высот. Ответ — причина отказа или undefined.
 */
export function structureGradeProblem(za: number, zb: number, length: number, maxGrade: number, slack = 0): string | undefined {
  if (!Number.isFinite(za) || !Number.isFinite(zb) || length <= 0) return undefined;
  const allowed = maxGrade * length + slack;
  const rise = Math.abs(zb - za);
  if (rise <= allowed + 0.5) return undefined;
  return steepText(rise / length, allowed / length);
}

/** Во сколько раз дороже стройка в точке, где полотно на depth м выше или ниже земли. */
export function earthFactor(depth: number, unit: number): number {
  return 1 + Math.abs(depth) / unit;
}

/** Профиль стройки для подсказки: наибольший уклон, выемка и насыпь, м; slope — уклон от начала к концу (± — вверх, вниз). */
export interface ProfileSummary {
  grade: number;
  cut: number;
  fill: number;
  slope?: number;
}

/**
 * Подпись профиля для подсказки стройки: «↗ 4% · местами 9% · насыпь 2 м». Главное — уклон между концами
 * (стрелка — вверх или вниз по ходу стройки); наибольший уклон на коротком участке (бугор, ложбина) — только
 * если он заметно круче. Без концов (правка части дороги) — «↗ до 6%».
 */
export function profileText(p: ProfileSummary): string {
  const pct = (v: number) => Math.round(Math.abs(v) * 100);
  const parts: string[] = [];
  if (p.slope === undefined) parts.push(`↗ до ${pct(p.grade)}%`);
  else {
    const s = pct(p.slope);
    parts.push(`${s === 0 ? '→' : p.slope > 0 ? '↗' : '↘'} ${s}%`);
    if (pct(p.grade) >= s + 2) parts.push(`местами ${pct(p.grade)}%`);
  }
  if (p.fill >= 0.5) parts.push(`насыпь ${Math.round(p.fill)} м`);
  if (p.cut >= 0.5) parts.push(`выемка ${Math.round(p.cut)} м`);
  return parts.join(' · ');
}

/** Точка смены уровня дороги: на каком расстоянии от начала и какой уровень там (−1 тоннель, 0 земля, 1 мост). */
export interface LevelPoint {
  s: number;
  level: number;
}

/**
 * Режим «Авто»: где полотну по профилю z нужна насыпь выше maxDepth — мост, выемка глубже — тоннель;
 * перед ними и после — пандусы длиной ramp. Ответ — точки смены уровня от начала (s = 0) до конца;
 * участки, чьи пандусы сходятся, сливаются в один мост или тоннель. ends — уровни концов, если заданы
 * (узел старой дороги свой уровень не меняет).
 */
export function autoLevels(
  z: ArrayLike<number>,
  h: ArrayLike<number>,
  ds: number,
  maxDepth: number,
  ramp: number,
  ends: { start?: number; end?: number } = {},
): LevelPoint[] {
  const n = z.length;
  const L = (n - 1) * ds;
  const lv = (i: number) => (Number.isNaN(h[i]) ? 0 : z[i] - h[i] > maxDepth ? 1 : z[i] - h[i] < -maxDepth ? -1 : 0);
  const runs: { a: number; b: number; level: number }[] = [];
  for (let i = 0; i < n; i++) {
    const l = lv(i);
    if (!l) continue;
    const last = runs[runs.length - 1];
    if (last && last.level === l && last.b >= (i - 1) * ds - 1e-6) last.b = i * ds;
    else runs.push({ a: i * ds, b: i * ds, level: l });
  }
  // Пандусы соседних участков сходятся — один длинный мост (или тоннель), без спуска на землю посередине.
  const merged: typeof runs = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && r.a - ramp <= prev.b + ramp + 10) {
      if (r.b - r.a > prev.b - prev.a) prev.level = r.level;
      prev.b = r.b;
    } else merged.push({ ...r });
  }
  const pts: LevelPoint[] = [];
  const near = 12;
  const first = merged[0];
  const startLevel = ends.start ?? (first && first.a - ramp <= near ? first.level : 0);
  pts.push({ s: 0, level: startLevel });
  for (const r of merged) {
    if (r.a - ramp > near) pts.push({ s: r.a - ramp, level: 0 });
    if (r.a > near) pts.push({ s: r.a, level: r.level });
    if (r.b < L - near) pts.push({ s: Math.max(r.b, r.a + near), level: r.level });
    if (r.b + ramp < L - near) pts.push({ s: r.b + ramp, level: 0 });
  }
  const last = merged[merged.length - 1];
  const endLevel = ends.end ?? (last && last.b + ramp >= L - near ? last.level : 0);
  pts.push({ s: L, level: endLevel });
  // Точки ближе друг к другу, чем near, и подряд одинаковые уровни на земле — лишние.
  const out: LevelPoint[] = [pts[0]];
  for (const p of pts.slice(1)) {
    const prev = out[out.length - 1];
    if (p.s - prev.s < near && p !== pts[pts.length - 1]) continue;
    if (p.s - prev.s < near) out.pop();
    out.push(p);
  }
  return out;
}
