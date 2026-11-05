import { chartIndexAt, type SpeedChart } from '../game/speedChart';
import { KMH_PER_UNIT } from '../world/roadTypes';

/** Метров в единице пути — по тому же масштабу, что и км/ч. */
const M_PER_UNIT = KMH_PER_UNIT / 3.6;

/** Не больше стольких точек на линии графика (остановки и минимумы — всегда). */
const MAX_POINTS = 400;

/** Подписи скорости слева: шагом 20, 25, 50 или 100 км/ч — чтобы их было 2–4. */
export function speedTicks(maxKmh: number): number[] {
  const step = maxKmh > 200 ? 100 : maxKmh > 100 ? 50 : maxKmh > 50 ? 25 : 20;
  const ticks: number[] = [];
  for (let v = step; v <= maxKmh; v += step) ticks.push(v);
  return ticks;
}

/** Расстояние подписью: «850 м», «2,4 км». */
export function distLabel(units: number): string {
  const m = units * M_PER_UNIT;
  return m < 1000 ? `${Math.round(m / 10) * 10} м` : `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}

/** Индексы точек для линии: каждая stride-я, а ещё остановки и места, где скорость падает сильнее соседей. */
export function thinOut(v: ArrayLike<number>, max = MAX_POINTS): number[] {
  const n = v.length;
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const stride = Math.ceil(n / max);
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const dip = i > 0 && i < n - 1 && v[i] < v[i - 1] && v[i] <= v[i + 1];
    if (i % stride === 0 || i === n - 1 || v[i] < 0.5 || dip) keep.push(i);
  }
  return keep;
}

/**
 * График скорости круга линии: залитая линия — скорость транспорта, пунктир — предел (знаки, изгибы,
 * перекрёстки), серый рельеф внизу — подъёмы и спуски, вертикали с номерами — остановки маршрута
 * (как в списке остановок), точечная черта — средняя скорость. Наведение — вертикальная черта
 * (.speed-cursor) и точка на линии скорости (.speed-dot), их и свою подсказку двигает панель — см.
 * chartHoverAt; системных подсказок (title) нет — те появляются с задержкой. stopNames — уже
 * экранированные названия остановок.
 */
export function speedChartSvg(chart: SpeedChart, color: string, stopNames: string[], W = CHART_W, H = CHART_H): string {
  const top = TOP;
  const base = H - BOTTOM;
  const vTop = chartTopKmh(chart);
  const x = (d: number) => chartX(chart, d, W);
  const y = (v: number) => chartY(v, vTop, H);
  const f = (n: number) => n.toFixed(1);
  const idx = thinOut(chart.v);
  // Рельеф — внизу, в нижней трети, если перепад заметен (больше пары метров).
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of chart.z) {
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }
  const relief =
    zMax - zMin > 3
      ? (() => {
          const band = (base - top) * 0.32;
          const zy = (z: number) => base - ((z - zMin) / (zMax - zMin)) * band;
          const pts = idx.map((i) => `${f(x(chart.d[i]))},${f(zy(chart.z[i]))}`).join(' ');
          return `<polygon points="${f(L)},${base} ${pts} ${f(W - R)},${base}" fill="#e3e8ee"/>`;
        })()
      : '';
  const grid = speedTicks(vTop)
    .map((t) => {
      const ty = base - (t / vTop) * (base - top);
      return `<line x1="${L}" x2="${W - R}" y1="${f(ty)}" y2="${f(ty)}" stroke="#eef1f4"/><text x="${L - 3}" y="${f(ty + 3)}" text-anchor="end" font-size="8" fill="#7b8794">${t}</text>`;
    })
    .join('');
  // Предел — ступеньками: на изгибе и перекрёстке он падает сразу.
  const capPts = idx.map((i) => `${f(x(chart.d[i]))},${f(y(chart.cap[i]))}`).join(' ');
  const vPts = idx.map((i) => `${f(x(chart.d[i]))},${f(y(chart.v[i]))}`).join(' ');
  const avgY = y(chart.avg);
  const avg = `<line x1="${L}" x2="${W - R}" y1="${f(avgY)}" y2="${f(avgY)}" stroke="#1f2933" stroke-width="1" stroke-dasharray="1 2.5"/>`;
  // Остановки: вертикаль и номер в кружке цвета линии; последняя — снова первая (круг замкнулся).
  const stops = chart.stops
    .map((d, i) => {
      const k = i % stopNames.length;
      const sx = x(d);
      const tx = stopBadgeX(chart, i, W);
      return `<line x1="${f(sx)}" x2="${f(sx)}" y1="${top}" y2="${base}" stroke="#c4ccd5" stroke-dasharray="2 2"/>
        <circle cx="${f(tx)}" cy="${base + 9}" r="${STOP_R}" fill="${color}"/><text x="${f(tx)}" y="${base + 12}" text-anchor="middle" font-size="8.5" font-weight="700" fill="#fff" stroke="#00000055" stroke-width="0.6" paint-order="stroke">${k + 1}</text>`;
    })
    .join('');
  return `<svg class="speed-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    ${grid}${relief}
    <polygon points="${f(L)},${base} ${vPts} ${f(W - R)},${base}" fill="${color}" fill-opacity="0.22"/>
    <polyline points="${vPts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <polyline points="${capPts}" fill="none" stroke="#52606d" stroke-width="1" stroke-dasharray="3 2"/>
    <line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" stroke="#c4ccd5"/>
    ${avg}${stops}<line class="speed-cursor" x1="0" x2="0" y1="${top}" y2="${base}" stroke="#1f2933" stroke-width="1.2" visibility="hidden"/>
    <circle class="speed-dot" cx="0" cy="0" r="3.5" fill="${color}" stroke="#fff" stroke-width="1.5" visibility="hidden"/></svg>`;
}

/** Ширина и высота рисунка (единицы viewBox) и поля: слева — под подписи скорости, снизу — под номера остановок. */
const CHART_W = 360;
const CHART_H = 140;
const L = 24;
const R = 4;
const TOP = 8;
const BOTTOM = 18;
/** Радиус кружка с номером остановки. */
const STOP_R = 6.5;

/** Где на рисунке точка на расстоянии d от первой остановки (по ширине viewBox). */
export function chartX(chart: SpeedChart, d: number, W = CHART_W): number {
  return L + (d / chart.length) * (W - L - R);
}

/** Расстояние от первой остановки под курсором: fx — доля ширины рисунка слева (0…1). */
export function chartDistAt(chart: SpeedChart, fx: number, W = CHART_W): number {
  return Math.max(0, Math.min(1, (fx * W - L) / (W - L - R))) * chart.length;
}

/** Верх шкалы скорости, км/ч: чуть выше наибольших скорости и предела (предел — не выше 200), не ниже 40. */
function chartTopKmh(chart: SpeedChart): number {
  let maxV = 0;
  for (let i = 0; i < chart.v.length; i++) maxV = Math.max(maxV, chart.v[i] * KMH_PER_UNIT, Math.min(chart.cap[i] * KMH_PER_UNIT, 200));
  return Math.max(40, maxV * 1.08);
}

/** Высота на рисунке скорости v (единицы пути в секунду); vTop — верх шкалы, км/ч. */
function chartY(v: number, vTop: number, H: number): number {
  const base = H - BOTTOM;
  return base - (Math.min(v * KMH_PER_UNIT, vTop) / vTop) * (base - TOP);
}

/** Где кружок с номером остановки i (индекс в chart.stops): под её вертикалью, у краёв — не за полем рисунка. */
function stopBadgeX(chart: SpeedChart, i: number, W: number): number {
  return Math.max(L + 6, Math.min(W - R - 6, chartX(chart, chart.stops[i], W)));
}

/**
 * Точка графика под курсором: i — её индекс, x/y — где она на рисунке (единицы viewBox), d — расстояние
 * от первой остановки, скорость и предел в ней (км/ч); stop — индекс в chart.stops остановки, чей
 * кружок с номером под курсором, иначе -1.
 */
export interface ChartHover {
  i: number;
  x: number;
  y: number;
  d: number;
  kmh: number;
  capKmh: number;
  stop: number;
}

/** Что под курсором на графике: fx — доля ширины рисунка слева (0…1). */
export function chartHoverAt(chart: SpeedChart, fx: number, W = CHART_W, H = CHART_H): ChartHover {
  const i = chartIndexAt(chart, chartDistAt(chart, fx, W));
  // Курсор на полях — как у края графика: там кружки первой и последней остановок.
  const cx = Math.max(L, Math.min(W - R, fx * W));
  let stop = -1;
  let near = STOP_R;
  for (let k = 0; k < chart.stops.length; k++) {
    const dx = Math.abs(stopBadgeX(chart, k, W) - cx);
    if (dx <= near) {
      near = dx;
      stop = k;
    }
  }
  return {
    i,
    x: chartX(chart, chart.d[i], W),
    y: chartY(chart.v[i], chartTopKmh(chart), H),
    d: chart.d[i],
    kmh: Math.round(chart.v[i] * KMH_PER_UNIT),
    capKmh: Math.round(chart.cap[i] * KMH_PER_UNIT),
    stop,
  };
}

/**
 * Своя подсказка к точке графика (браузерная title появляется с задержкой): скорость крупно, под ней —
 * предел и расстояние от первой остановки, у кружка остановки — её номер и название. stopNames — уже
 * экранированные названия остановок, color — цвет линии (кружок номера, как на графике).
 */
export function speedTipHtml(h: ChartHover, stopNames: string[], color: string): string {
  const cap = h.capKmh > 0 && h.capKmh <= 300 ? `предел ${h.capKmh} · ` : '';
  const k = h.stop >= 0 && stopNames.length ? h.stop % stopNames.length : -1;
  const stop = k >= 0 ? `<span class="st"><i style="background:${color}">${k + 1}</i>${stopNames[k]}</span>` : '';
  return `<b>${h.kmh} км/ч</b><span>${cap}${distLabel(h.d)}</span>${stop}`;
}
