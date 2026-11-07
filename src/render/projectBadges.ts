/**
 * Плашки проектов стройки на карте («🏗 45%», на паузе — «⏸», без денег — «💸», бригада не на месте — «🚚», к проекту
 * не доехать по дорогам — «🚚 нет подъезда»;
 * приоритетный — со «⬆»): где они и что на них — одним расчётом для отрисовки (renderer.drawConstruction) и для клика
 * по плашке (controller: клик выбирает проект и открывает его карточку).
 */
import type { Vec } from '../core/vec';
import type { Game } from '../game/game';
import { workFront } from './constructionArt';

export interface ProjectBadge {
  id: number;
  text: string;
  /** Центр плашки (мировые координаты) и половины ширины и высоты (по оценке ширины текста). */
  x: number;
  y: number;
  hw: number;
  hh: number;
  /** Цвет подложки: стройка идёт — оранжевый, пауза — серый, нет денег — красный. */
  fill: string;
}

/** Ширина текста плашки в пикселях экрана (шрифт 12 px): значки шире цифр — без холста, чтобы клик знал её заранее. */
export function badgeTextPx(text: string): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += code === 0xfe0f ? 0 : code > 0x2000 ? 15 : ch === ' ' ? 3.5 : 7;
  }
  return w;
}

/** Плашки проектов при масштабе zoom, по порядку закладки (верхняя — последняя). */
export function projectBadges(game: Game, zoom: number): ProjectBadge[] {
  const z = zoom;
  const out: ProjectBadge[] = [];
  const crews = game.construction.crews;
  for (const info of game.construction.list()) {
    const p = info.project;
    const cs = game.construction.corridorsOf(p.id);
    const front = cs.map(workFront).find((f) => f) ?? null;
    const at: Vec = front?.pos ?? info.at;
    const pct = Math.min(99, Math.floor(info.done * 100));
    const crew = crews.working(p.id).length;
    // Нет подъезда (бригадам не доехать по дорогам ни с одной базы) — так и написано: иначе непонятно, почему стоит.
    const blocked = !p.paused && !info.access && crews.bases.size > 0;
    const mark = p.paused ? '⏸' : p.stalled !== undefined ? '💸' : crew ? '🏗' : '🚚';
    const text = blocked ? `${p.priority ? '⬆ ' : ''}🚚 нет подъезда` : `${p.priority ? '⬆ ' : ''}${mark} ${pct}%`;
    const fill =
      (p.stalled !== undefined || blocked) && !p.paused ? 'rgba(232, 72, 63, 0.92)' : p.paused ? 'rgba(110, 118, 128, 0.92)' : 'rgba(240, 138, 60, 0.95)';
    // Над краем работ — выше техники, чтобы её не закрывать; при любом зуме одного размера на экране.
    out.push({ id: p.id, text, x: at.x, y: at.y - 26 / z - 14, hw: (badgeTextPx(text) + 12) / z / 2, hh: 9 / z, fill });
  }
  return out;
}

/** Плашка под точкой p (с запасом в пару пикселей): верхняя — последняя нарисованная. */
export function badgeAt(list: ProjectBadge[], p: Vec, zoom: number): ProjectBadge | null {
  const pad = 3 / zoom;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (Math.abs(p.x - b.x) <= b.hw + pad && Math.abs(p.y - b.y) <= b.hh + pad) return b;
  }
  return null;
}
