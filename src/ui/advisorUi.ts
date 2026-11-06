/**
 * Панель советника: карточки советов (значок вида и важности, что случилось, где, кнопки «Показать» и быстрое
 * действие), значок с числом на кнопке «Советы». Подсказки — свои (data-tip), не системные.
 */
import { STATION, STORAGE } from '../config';
import type { Advice, AdviceFix, AdviceKind, AdviceLevel } from '../game/advisor';
import type { Game } from '../game/game';
import { MODELS } from '../game/transport';
import { cargoIcon } from './cargoIcons';
import { lineKindSvg } from './icons';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const money = (n: number) => `${Math.round(n) < 0 ? '−' : ''}$${fmt(Math.abs(n))}`;

/** Значок вида совета (кроме тех, где значок — груз). */
const KIND_GLYPH: Record<AdviceKind, string> = {
  debt: '💸',
  noMoney: '💸',
  noRoute: '⛔',
  stuck: '🚧',
  queue: '⏳',
  waiting: '📦',
  storage: '🏚',
  wrongStop: '⚠',
  noVehicles: '🚚',
  unsold: '📤',
  missingInput: '📥',
  empty: '🪫',
};

const LEVEL_TIP: Record<AdviceLevel, string> = {
  alert: 'Срочно: что-то стоит',
  warn: 'Теряете деньги или рост',
  tip: 'Можно лучше',
};

/** Значок совета: груз (если он про груз) или пиктограмма вида, в кружке цвета важности; число — в уголке. */
export function adviceIcon(a: Advice, size = 28): string {
  const inner =
    a.kind === 'storage'
      ? depotSvg(size - 10)
      : a.cargo && (a.kind === 'waiting' || a.kind === 'unsold' || a.kind === 'missingInput')
        ? cargoIcon(a.cargo, size - 8, false)
        : `<span class="adv-glyph">${KIND_GLYPH[a.kind]}</span>`;
  const count = a.count && a.count > 1 ? `<i class="adv-count">${a.count >= 1000 ? `${Math.round(a.count / 100) / 10}k` : fmt(a.count)}</i>` : '';
  return `<span class="adv-ic ${a.level}" style="width:${size}px;height:${size}px" data-tip="${LEVEL_TIP[a.level]}">${inner}${count}</span>`;
}

/** Лампочка советника — кнопка в панели денег. */
export function bulbSvg(size = 22): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M12 2.5a6.5 6.5 0 0 0-3.9 11.7c.6.5 1 1.2 1.1 2V17h5.6v-.8c.1-.8.5-1.5 1.1-2A6.5 6.5 0 0 0 12 2.5z" fill="#ffd34d" stroke="#c99400" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M10 10.5l2 2 2-2M12 12.5V17" fill="none" stroke="#c99400" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="9.2" y="17.6" width="5.6" height="1.8" rx="0.6" fill="#8a96a3"/>
    <rect x="9.8" y="19.9" width="4.4" height="1.6" rx="0.6" fill="#8a96a3"/>
  </svg>`;
}

/** Склад станции: ангар с двускатной крышей и ящиком у ворот. */
export function depotSvg(size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M3 10l9-6 9 6v10H3z" fill="#b9895a" stroke="#7d5a39" stroke-width="1.3" stroke-linejoin="round"/>
    <rect x="7" y="13" width="10" height="7" fill="#5c4632"/>
    <rect x="9" y="15.5" width="4.5" height="4.5" fill="#e2b866" stroke="#a3793a" stroke-width="0.8"/>
  </svg>`;
}

/** Подпись кнопки быстрого действия (с ценой, если она есть). */
export function fixLabel(g: Game, fix: AdviceFix): string {
  switch (fix.kind) {
    case 'buy': {
      const line = g.lines.get(fix.line);
      const model = line ? MODELS[g.autoModel(line)] : null;
      return `+1 машина${model ? ` · $${fmt(model.price)}` : ''}`;
    }
    case 'autoMax':
      return 'Максимум авто-парка +2';
    case 'sell':
      return '−1 машина';
    case 'bay':
      return `+1 пост · $${fmt(STATION.bayCost)}`;
    case 'depot':
      return `+ склад · $${fmt(STORAGE.cost)}`;
    case 'route':
      return '+ Маршрут отсюда';
    case 'loan':
      return 'Взять кредит';
  }
}

/** Деньги совета: на счёте — полоска до нужной суммы — сколько нужно. */
export function fundsHtml(f: { have: number; need: number }): string {
  const part = f.need > 0 ? Math.max(0, Math.min(1, f.have / f.need)) : 1;
  return `<div class="adv-funds" data-tip="На счёте ${money(f.have)}, нужно ${money(f.need)}"><span>💰</span><b class="${f.have < 0 ? 'neg' : ''}">${money(f.have)}</b><span class="adv-meter"><i style="width:${Math.round(part * 100)}%"></i></span><b>${money(f.need)}</b></div>`;
}

/** Карточка совета. */
function cardHtml(g: Game, a: Advice): string {
  const line = a.line !== undefined ? g.lines.get(a.line) : undefined;
  const chip = line
    ? `<button class="adv-line" data-action="select-line" data-id="${line.id}" data-tip="Открыть маршрут">${lineKindSvg(g.lineVehicleKind(line), line.color, 16)}<span>${esc(line.name)}</span></button>`
    : '';
  const show = a.at ? `<button class="small" data-action="advice-show" data-key="${esc(a.key)}" data-tip="Показать на карте">📍 Показать</button>` : '';
  const fix = a.fix ? `<button class="small primary" data-action="advice-fix" data-key="${esc(a.key)}">${esc(fixLabel(g, a.fix))}</button>` : '';
  const hide = a.level === 'tip' ? `<button class="icon adv-hide" data-action="advice-hide" data-key="${esc(a.key)}" data-tip="Скрыть этот совет" data-tip-end>✕</button>` : '';
  return `<div class="adv-card ${a.level}">${adviceIcon(a)}
    <div class="adv-body"><div class="adv-title"><b>${esc(a.title)}</b>${hide}</div>
      <small>${esc(a.detail)}</small>${a.funds ? fundsHtml(a.funds) : ''}
      ${chip || show || fix ? `<div class="adv-actions">${chip}${show}${fix}</div>` : ''}
    </div></div>`;
}

/** Панель советника: советы по важности; пусто — «всё работает». */
export function advisorHtml(g: Game, list: Advice[]): string {
  const counts = (['alert', 'warn', 'tip'] as AdviceLevel[])
    .map((l) => [l, list.filter((a) => a.level === l).length] as const)
    .filter(([, n]) => n)
    .map(([l, n]) => `<span class="adv-sum ${l}" data-tip="${LEVEL_TIP[l]}">${n}</span>`)
    .join('');
  const body = list.length
    ? list.map((a) => cardHtml(g, a)).join('')
    : '<div class="adv-empty"><span>✓</span>Всё работает — советов нет. Советник следит за маршрутами, станциями, заводами и деньгами.</div>';
  return `<header><h3>Советник</h3>${counts}<button class="icon" data-action="advisor">✕</button></header>${body}`;
}

/** Число на лампочке: все советы; цвет — по самому важному (красный — срочный, жёлтый — важный, синий — подсказки). */
export function adviceBadge(list: Advice[]): { n: number; level: AdviceLevel | null } {
  const level = list.some((a) => a.level === 'alert') ? 'alert' : list.some((a) => a.level === 'warn') ? 'warn' : list.length ? 'tip' : null;
  return { n: list.length, level };
}
