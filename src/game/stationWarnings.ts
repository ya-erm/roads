/**
 * Предупреждения станции — один источник для значков на карте, подсказки при наведении и строк в карточке станции:
 * что случилось (условие — советник и очередь «нет мест»), одной строкой, подробно и что сделать (быстрое действие).
 * Клик по значку открывает карточку станции и подсвечивает эти строки.
 */
import { STATION } from '../config';
import type { Vec } from '../core/vec';
import { CARGO } from '../world/cargo';
import type { Station } from '../world/entities';
import { footprintRadius, type Footprint } from '../world/spatial';
import { adviceOf, type Advice, type AdviceFix } from './advisor';
import type { Game } from './game';

export interface StationWarning {
  key: string;
  level: 'alert' | 'warn';
  /** Совет советника, из которого предупреждение; нет — очередь «нет мест» (stationJam). */
  advice?: Advice;
  title: string;
  /** Одной строкой — подсказка у значка на карте. */
  tip: string;
  /** Подробно и что сделать — в карточке станции. */
  detail: string;
  fix?: AdviceFix;
  count?: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');

/** Причина одной строкой — по виду совета (подробности — в карточке). */
export function adviceTip(a: Advice): string {
  if (a.reason) return a.reason;
  const what = a.cargo === 'passengers' ? 'пассажиров' : a.cargo ? `ед. «${CARGO[a.cargo].name}»` : '';
  switch (a.kind) {
    case 'waiting':
      return `${a.title}: ждут отправки ${fmt(a.count ?? 0)} ${what} — машин на маршруте мало`;
    case 'queue':
      return `${a.title}: ${a.count ?? 0} ждут свободный пост`;
    case 'stuck':
      return `${a.title}: ${a.count ?? 0} погрузились и ждут выезда`;
    case 'wrongStop':
      return `${a.title} — машины маршрута заезжают впустую`;
    case 'noRoute':
      return a.detail.replace(/^«[^»]*»:\s*/, `${a.title}: `);
    default:
      return a.title;
  }
}

/** Все предупреждения станции (советы «можно лучше» — только в панели советника): сначала срочные. */
export function stationWarnings(game: Game, st: Station): StationWarning[] {
  const out: StationWarning[] = [];
  const n = game.stationJam(st);
  if (n) {
    const rail = st.kind === 'rail';
    const more = st.kind === 'road' && st.bays < STATION.maxBays;
    out.push({
      key: `jam:${st.id}`,
      level: 'warn',
      title: `Все ${rail ? 'платформы' : 'посты'} заняты`,
      tip: `Нет мест: все ${rail ? 'платформы' : 'посты'} заняты, ждут въезда ${n}`,
      detail: rail
        ? `Ждут въезда: ${n}. Добавьте путь, уберите лишний поезд с маршрута или разведите маршруты по разным вокзалам.`
        : `Ждут въезда: ${n} — стоят у въезда и теряют время. ${more ? 'Добавьте пост, у' : 'У'}берите лишние машины с маршрута или разведите маршруты по разным станциям.`,
      fix: more ? { kind: 'bay', station: st.id } : undefined,
      count: n,
    });
  }
  for (const a of adviceOf(game)) {
    if (a.station !== st.id || a.level === 'tip') continue;
    out.push({ key: a.key, level: a.level, advice: a, title: a.title, tip: adviceTip(a), detail: a.detail, fix: a.fix, count: a.count });
  }
  return out.sort((a, b) => Number(b.level === 'alert') - Number(a.level === 'alert'));
}

/** Значок предупреждения на карте: где (мир) и что сказать при наведении; размер постоянный на экране. */
export interface WarningMark {
  /** Кружок «!» в правом верхнем углу или плашка «нет мест» с числом — в левом. */
  shape: 'dot' | 'jam';
  station?: number;
  industry?: number;
  level: 'alert' | 'warn';
  tip: string;
  /** Центр и половины ширины и высоты (у кружка — радиус в обе стороны). */
  x: number;
  y: number;
  hw: number;
  hh: number;
  /** Число на плашке «нет мест». */
  count?: number;
}

/** Ширина плашки «нет мест» в пикселях экрана: знак, число, поля. */
export const jamPillPx = (n: number) => 26 + 7.5 * String(n).length;

/**
 * Значки предупреждений при масштабе zoom: у станции — «!» (красный — стоит, жёлтый — теряете деньги или рост)
 * и плашка «нет мест»; у предприятия — «!». Советы «можно лучше» значков не дают.
 */
export function warningMarks(game: Game, zoom: number): WarningMark[] {
  const z = zoom;
  const out: WarningMark[] = [];
  const corner = (fp: Footprint | undefined, at: Vec, side: 1 | -1) => {
    const r = fp ? footprintRadius(fp) : 0;
    const c = fp?.center ?? at;
    return { x: c.x + side * (r * 0.7 + 4 / z), y: c.y - r * 0.7 - 4 / z };
  };
  const seen = new Set<string>();
  for (const st of game.stations.values()) {
    const list = stationWarnings(game, st);
    const jam = list.find((w) => !w.advice);
    if (jam) {
      const w = jamPillPx(jam.count ?? 0) / z;
      const c = corner(st.fp, st.fp.center, -1);
      out.push({ shape: 'jam', station: st.id, level: 'warn', tip: jam.tip, x: c.x - w / 2, y: c.y, hw: w / 2, hh: 10 / z, count: jam.count });
    }
    const advice = list.filter((w) => w.advice);
    if (advice.length) {
      seen.add(`s${st.id}`);
      const c = corner(st.fp, st.fp.center, 1);
      const more = advice.length > 1 ? ` (и ещё ${advice.length - 1} — в карточке)` : '';
      out.push({ shape: 'dot', station: st.id, level: advice[0].level, tip: advice[0].tip + more, x: c.x, y: c.y, hw: 9 / z, hh: 9 / z });
    }
  }
  // Советы не про станцию: у предприятия (или в точке).
  for (const a of adviceOf(game)) {
    if (a.level === 'tip' || !a.at || a.station !== undefined) continue;
    const ind = a.industry !== undefined ? game.industries.find((i) => i.id === a.industry) : undefined;
    const key = ind ? `i${ind.id}` : `${Math.round(a.at.x)}:${Math.round(a.at.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = corner(ind?.fp, a.at, 1);
    out.push({ shape: 'dot', industry: ind?.id, level: a.level, tip: adviceTip(a), x: c.x, y: c.y, hw: 9 / z, hh: 9 / z });
  }
  return out;
}

/** Значок под точкой p (с запасом в пару пикселей); верхний — последний нарисованный. */
export function markAt(marks: WarningMark[], p: Vec, zoom: number): WarningMark | null {
  const pad = 3 / zoom;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (Math.abs(p.x - m.x) <= m.hw + pad && Math.abs(p.y - m.y) <= m.hh + pad) return m;
  }
  return null;
}
