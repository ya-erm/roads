/**
 * Окно «События» — история уведомлений за последние месяцы (src/game/news.ts): колокольчик с числом непрочитанного
 * в панели денег, окно с записями по месяцам, значки видов (они же фильтры) и кнопки-места: предприятие, город,
 * станция, маршрут, стройка — клик ведёт к ним на карте и открывает карточку. Подсказки — свои (data-tip).
 */
import type { Vec } from '../core/vec';
import { projectName } from '../game/construction';
import type { Game, Notice } from '../game/game';
import { NEWS_KINDS, NEWS_MONTHS, NOTICE_FADE, NOTICE_LIFE, type NewsEntry, type NewsKind, type NewsRef } from '../game/news';
import { footprintRadius } from '../world/spatial';
import { cargoIcon, townIcon } from './cargoIcons';
import { baseSvg, buildSvg } from './constructionUi';
import { lineKindSvg, stationSvg } from './icons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Вид записи: пиктограмма, цвет кружка, подпись (в подсказке). */
export const NEWS_KIND_INFO: Record<NewsKind, { glyph: string; color: string; name: string }> = {
  goal: { glyph: '🎯', color: '#7a5cc4', name: 'Задания и этапы' },
  event: { glyph: '📰', color: '#c4662f', name: 'События экономики' },
  industry: { glyph: '🏭', color: '#2e9d57', name: 'Предприятия' },
  town: { glyph: '🏘', color: '#55606e', name: 'Города' },
  build: { glyph: '🚧', color: '#e0a100', name: 'Стройка' },
  fleet: { glyph: '🚌', color: '#4a8fe7', name: 'Транспорт' },
  money: { glyph: '💸', color: '#e5534b', name: 'Деньги' },
};

/** Значок вида в цветном кружке. */
export function newsKindIcon(kind: NewsKind, size = 26): string {
  const k = NEWS_KIND_INFO[kind];
  return `<span class="news-ic" style="width:${size}px;height:${size}px;background:${k.color};font-size:${Math.round(size * 0.55)}px" data-tip="${k.name}">${k.glyph}</span>`;
}

/** Колокольчик — кнопка окна «События» в панели денег. */
export function bellSvg(size = 22): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M12 3.2a1.4 1.4 0 0 1 1.4 1.4v.5a6 6 0 0 1 4.6 5.8v3.6l1.8 2.6c.3.5 0 1.1-.6 1.1H4.8c-.6 0-.9-.6-.6-1.1L6 14.5v-3.6a6 6 0 0 1 4.6-5.8v-.5A1.4 1.4 0 0 1 12 3.2z" fill="#ffc94a" stroke="#b98a00" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M9.6 19.4a2.4 2.4 0 0 0 4.8 0" fill="#b98a00" stroke="#b98a00" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M8.6 9.8a3.6 3.6 0 0 1 2.2-2.6" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity="0.8"/>
  </svg>`;
}

/** Число на колокольчике: до 99, дальше «99+». */
export function newsBadge(unread: number): string {
  return unread <= 0 ? '' : unread > 99 ? '99+' : String(unread);
}

/** Куда ведёт ссылка записи: название, значок, место и радиус обзора; объекта уже нет — null. */
export interface NewsTarget {
  name: string;
  icon: string;
  pos: Vec;
  r: number;
}

export function newsTarget(g: Game, ref: NewsRef): NewsTarget | null {
  switch (ref.type) {
    case 'industry': {
      const ind = g.industries.find((i) => i.id === ref.id);
      return ind ? { name: ind.name, icon: cargoIcon(ind.info.produces, 18, false), pos: ind.fp.center, r: footprintRadius(ind.fp) + 40 } : null;
    }
    case 'town': {
      const t = g.towns.find((x) => x.id === ref.id);
      return t ? { name: t.name, icon: townIcon(18, false), pos: t.center, r: 260 } : null;
    }
    case 'station': {
      const st = g.stations.get(ref.id);
      if (!st) return null;
      const kind = st.kind === 'rail' ? 'rail' : st.serves?.cargo && !st.serves?.pax ? 'cargo' : 'pax';
      return { name: st.name, icon: stationSvg(kind, 18), pos: st.fp.center, r: footprintRadius(st.fp) + 40 };
    }
    case 'line': {
      const line = g.lines.get(ref.id);
      const first = line && g.stations.get(line.stops[0]);
      return line ? { name: line.name, icon: lineKindSvg(g.lineVehicleKind(line), line.color, 20), pos: first?.fp.center ?? { x: 0, y: 0 }, r: 300 } : null;
    }
    case 'project': {
      const info = g.construction.info(ref.id);
      return info
        ? { name: projectName(info.project), icon: buildSvg(22, 17), pos: info.front ?? info.at, r: Math.max(60, Math.min(400, info.length / 3)) }
        : null;
    }
    case 'base': {
      const b = g.construction.crews.bases.get(ref.id);
      return b ? { name: g.baseName(b.id), icon: baseSvg(22, 17), pos: b.fp.center, r: 120 } : null;
    }
  }
}

/** Прозрачность всплывающего уведомления: последние NOTICE_FADE секунд жизни гаснет. */
export function noticeOpacity(n: Notice): number {
  return Math.max(0, Math.min(1, (NOTICE_LIFE - n.age) / NOTICE_FADE));
}

/**
 * Всплывающее уведомление вверху экрана. О месте или объекте (достроенная улица, предприятие, город, маршрут) —
 * кнопка: клик ведёт туда (подсказка «Показать на карте», подсветка под курсором). Клик по любому — прочитано
 * (с колокольчика уходит). Справа — крестик: убрать с экрана, в истории оно остаётся.
 */
export function noticeHtml(g: Game, n: Notice): string {
  const go = !!n.at || !!n.refs?.some((r) => newsTarget(g, r));
  const attrs = go ? `class="notice go" data-action="notice-go" data-tip="Показать на карте"` : `class="notice" data-action="notice-read"`;
  const border = n.color ? `;border-left-color:${n.color}` : '';
  const tip = n.news !== undefined ? 'Скрыть — останется в истории 🔔' : 'Скрыть';
  return `<div ${attrs} data-id="${n.id}" style="opacity:${noticeOpacity(n)}${border}"><span class="notice-text">${esc(n.text)}</span><button class="notice-x" data-action="notice-close" data-id="${n.id}" data-tip="${tip}">×</button></div>`;
}

/** Кнопки-места записи: объекты, что ещё есть на карте; нет ни одного, а место известно — «📍 на карте». */
function placeButtons(g: Game, e: NewsEntry): string {
  const out: string[] = [];
  (e.refs ?? []).forEach((r, i) => {
    const t = newsTarget(g, r);
    if (t) out.push(`<button class="news-go" data-action="news-go" data-n="${e.n}" data-i="${i}" data-tip="Показать на карте">${t.icon}<span>${esc(t.name)}</span></button>`);
  });
  if (!out.length && e.at) out.push(`<button class="news-go pin" data-action="news-go" data-n="${e.n}" data-tip="Показать на карте">📍</button>`);
  return out.join('');
}

export interface NewsView {
  /** Включённые фильтры по видам; пусто — все. */
  kinds: ReadonlySet<NewsKind>;
  /** Номера записей, непрочитанных на момент открытия окна (News.unreadSet): они подсвечены. */
  unread: ReadonlySet<number>;
}

/** Окно «События»: фильтры-значки, записи по месяцам (свежие сверху), кнопки-места. */
export function newsHtml(g: Game, view: NewsView): string {
  const counts = g.news.counts();
  const total = g.news.entries.length;
  const chip = (kind: NewsKind | null, n: number) => {
    const on = kind ? view.kinds.has(kind) : !view.kinds.size;
    const icon = kind ? newsKindIcon(kind, 22) : `<span class="news-all">Все</span>`;
    const tip = kind ? NEWS_KIND_INFO[kind].name : 'Все события';
    return `<button class="news-filter ${on ? 'active' : ''}" data-action="news-filter" data-kind="${kind ?? ''}" data-tip="${tip}">${icon}<b>${n}</b></button>`;
  };
  const filters = total
    ? `<div class="news-filters">${chip(null, total)}${NEWS_KINDS.filter((k) => counts.get(k))
        .map((k) => chip(k, counts.get(k)!))
        .join('')}</div>`
    : '';
  const groups = g.news.byMonth(view.kinds);
  const body = groups.length
    ? groups
        .map(
          (m) => `<section class="news-month">
        <h4><span>${g.dateAt(m.month)}</span><small>${m.entries.length}</small></h4>
        ${m.entries
          .map(
            (e) => `<div class="news-row ${view.unread.has(e.n) ? 'unread' : ''}" style="border-left-color:${e.color ?? NEWS_KIND_INFO[e.kind].color}">
          ${newsKindIcon(e.kind)}
          <div class="news-main"><div class="news-text">${esc(e.text)}</div>${(() => {
            const places = placeButtons(g, e);
            return places ? `<div class="news-places">${places}</div>` : '';
          })()}</div>
        </div>`,
          )
          .join('')}
      </section>`,
        )
        .join('')
    : `<div class="news-empty">${bellSvg(48)}<span>Пока тихо</span></div>`;
  return `<button class="icon modal-close" data-action="news-close" data-tip="Закрыть (Esc)">✕</button>
    <h2 class="news-head">${bellSvg(26)}Уведомления<span class="news-keep" data-tip="Хранятся уведомления за последние ${NEWS_MONTHS} месяцев">🕑 ${NEWS_MONTHS} мес.</span></h2>
    ${filters}
    <div class="news-list">${body}</div>`;
}
