/**
 * Фазы светофора в карточке перекрёстка: каждая фаза — плитка со схемой перекрёстка, где стрелки с подъездов
 * показывают, кому зелёный (сплошная — едет, пунктир — уступает встречным, красная — конфликт, серая — красный).
 * Клик по стрелке даёт или снимает зелёный; у плитки — длительность (−/+), переставить (◀ ▶) и убрать (✕);
 * под плитками — новая фаза, стрелки налево и «Авто».
 */
import { LIGHTS } from '../config';
import type { Vec } from '../core/vec';
import type { Compass, JunctionInfo, TurnKind } from '../game/game';
import { GREEN_MAX, GREEN_MIN, GREEN_STEP } from '../lanes/lights';

/** Отказ дать зелёный: поворот turn фазы i пересёкся бы с clash — они мигают красным. */
export interface PhaseFlash {
  node: number;
  i: number;
  turns: string[];
}

/** Поворот на схеме: с какого подъезда (курс «от узла»), куда, вид и подписи. */
export interface PicTurn {
  key: string;
  from: number;
  away: Vec;
  to: Vec;
  kind: TurnKind;
  name: string;
}

type Look = 'go' | 'yield' | 'clash' | 'off';

const NAME: Record<TurnKind, string> = { left: 'налево', straight: 'прямо', right: 'направо' };
const ICON: Record<TurnKind, string> = { left: '↰', straight: '↑', right: '↱' };
const COLOR: Record<Look, string> = { go: '#27a552', yield: '#27a552', clash: '#e0453c', off: '#c3cad3' };
const STATE: Record<Look, string> = {
  go: 'зелёный',
  yield: 'зелёный, уступает встречным',
  clash: 'конфликт: пересекается с другим зелёным',
  off: 'красный — клик даёт зелёный',
};

const f = (x: number) => (Math.round(x * 10) / 10).toString();
const pt = (p: Vec) => `${f(p.x)} ${f(p.y)}`;
const at = (...parts: [Vec, number][]) => parts.reduce((s, [v, k]) => ({ x: s.x + v.x * k, y: s.y + v.y * k }), { x: 0, y: 0 });

/** Повороты перекрёстка, по которым можно проехать (запрещённые — нет): откуда, куда и подпись «З налево на С». */
export function phaseTurns(info: JunctionInfo): PicTurn[] {
  const live = new Set(info.liveTurns);
  const dir = (seg: number) => info.approaches.find((a) => a.seg === seg)?.dir ?? { x: 1, y: 0 };
  const name = (c: Compass) => c.name;
  return info.turns.flatMap((t) =>
    t.exits
      .filter((e) => !e.banned && live.has(`${t.from}>${e.out}`))
      .map((e) => ({
        key: `${t.from}>${e.out}`,
        from: t.from,
        away: dir(t.from),
        to: dir(e.out),
        kind: e.kind,
        name: `${name(t.label)} ${NAME[e.kind]} на ${name(info.label(e.out))}`,
      })),
  );
}

/** Значок поворота «с подъезда»: стрелка подъезда и вид поворота (↓↰). */
export const turnLabel = (info: JunctionInfo, key: string) => {
  const t = phaseTurns(info).find((x) => x.key === key);
  return t ? `${info.label(t.from).arrow}${ICON[t.kind]}` : '?';
};

/**
 * Схема перекрёстка 76×76 со стрелками поворотов: дороги — серые полосы от центра по направлениям подъездов,
 * у каждого подъезда справа — стебель, от него стрелки прямо и в повороты (по курсу выезда). attrs — атрибуты
 * клика по стрелке (нет — схема только для показа).
 */
export function phasePictogram(
  ways: Vec[],
  turns: PicTurn[],
  look: (key: string) => Look,
  attrs?: (key: string) => string,
  flash: string[] = [],
): string {
  const roads = ways.map((w) => `<path d="M0 0L${pt(at([w, 37]))}" stroke="#dfe4ea" stroke-width="15"/>`).join('');
  const stems: string[] = [];
  const arrows: string[] = [];
  const top: string[] = [];
  const froms = new Map<number, Vec>();
  for (const t of turns) froms.set(t.from, t.away);
  for (const [from, away] of froms) {
    const mine = turns.filter((t) => t.from === from);
    const d = { x: -away.x, y: -away.y };
    const r = { x: -d.y, y: d.x };
    // Стебель — от края схемы по своей (правой) стороне дороги, стрелки — от его конца, не доходя до центра.
    const s = at([away, 35], [r, 4]);
    const p = at([away, 21], [r, 4]);
    const lit = mine.some((t) => look(t.key) !== 'off');
    stems.push(`<path d="M${pt(s)}L${pt(p)}" stroke="${lit ? COLOR.go : COLOR.off}" stroke-width="${lit ? 2.6 : 1.8}" stroke-linecap="round"/>`);
    for (const t of mine) {
      const u = t.kind === 'straight' ? d : t.to;
      const q = at([p, 1], [d, 6.5]);
      const end = t.kind === 'straight' ? at([p, 1], [d, 13]) : at([q, 1], [t.to, 9]);
      const path = t.kind === 'straight' ? `M${pt(p)}L${pt(end)}` : `M${pt(p)}Q${pt(q)} ${pt(end)}`;
      const n = { x: -u.y, y: u.x };
      const lk = flash.includes(t.key) ? 'clash' : look(t.key);
      const w = lk === 'off' ? 2.2 : 2.7;
      const head = `M${pt(at([end, 1], [u, 3.2]))}L${pt(at([end, 1], [u, -0.6], [n, w]))}L${pt(at([end, 1], [u, -0.6], [n, -w]))}Z`;
      const c = COLOR[lk];
      // Пунктир — с плоскими концами чёрточек: круглые залили бы промежутки.
      const dash = lk === 'yield' ? ' stroke-dasharray="2.2 1.9" stroke-linecap="butt"' : ' stroke-linecap="round"';
      const cls = `ph-turn${flash.includes(t.key) ? ' ph-flash' : ''}`;
      const hit = attrs ? `<path d="${path}" stroke="transparent" stroke-width="8" fill="none"/>` : '';
      // Красные — снизу, зелёные и конфликтные — поверх.
      (lk === 'off' ? arrows : top).push(
        `<g class="${cls}" ${attrs ? attrs(t.key) : ''}><title>${t.name}: ${STATE[lk]}</title>${hit}<path class="ph-vis" d="${path}" stroke="${c}" stroke-width="${lk === 'off' ? 1.8 : 2.6}" fill="none"${dash}/><path class="ph-vis" d="${head}" fill="${c}"/></g>`,
      );
    }
  }
  return `<svg class="ph-pic" width="76" height="76" viewBox="-38 -38 76 76" aria-hidden="true"><circle r="9" fill="#dfe4ea"/>${roads}${stems.join('')}${arrows.join('')}${top.join('')}</svg>`;
}

/** Мини-значок для легенды и кнопок: стрелка прямо или налево, сплошная или пунктиром, нужного цвета. */
function miniArrow(kind: 'straight' | 'left', color: string, dashed = false): string {
  const path = kind === 'straight' ? 'M7 13V4' : 'M9 13V8Q9 5 6 5H4';
  const head = kind === 'straight' ? 'M7 1.5L10 5.5H4Z' : 'M1.5 5L5 2V8Z';
  return `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${path}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"${dashed ? ' stroke-dasharray="2.4 1.8"' : ''}/><path d="${head}" fill="${color}"/></svg>`;
}

/** Блок «Фазы» карточки перекрёстка со светофором. */
export function phasesHtml(info: JunctionInfo, id: number, flash: PhaseFlash | null): string {
  const turns = phaseTurns(info);
  const attrs = `data-id="${id}"`;
  const count = info.phases.length;
  const tiles = info.phases
    .map((ph, i) => {
      const look = (key: string): Look => (ph.clashes.includes(key) ? 'clash' : !ph.go.includes(key) ? 'off' : ph.yields.includes(key) ? 'yield' : 'go');
      const pic = phasePictogram(
        info.approaches.map((a) => a.dir),
        turns,
        look,
        (key) => `data-action="jn-ph-turn" ${attrs} data-i="${i}" data-turn="${key}"`,
        flash && flash.node === id && flash.i === i ? flash.turns : [],
      );
      const state = ph.clearing ? 'clearing' : ph.active ? 'active' : '';
      const tip = ph.extra ? ' title="Повороты, которых нет в ваших фазах, — своя фаза «Авто»"' : '';
      return `<div class="ph-tile ${state} ${ph.extra ? 'extra' : ''}"${tip}>
        <div class="ph-head"><b class="ph-n">${i + 1}</b>${ph.extra ? '<span class="ph-auto">А</span>' : ''}<span class="ph-sp"></span>
          <button class="ph-btn" data-action="jn-ph-move" ${attrs} data-i="${i}" data-d="-1" ${i > 0 ? '' : 'disabled'} title="Раньше">◀</button>
          <button class="ph-btn" data-action="jn-ph-move" ${attrs} data-i="${i}" data-d="1" ${i < count - 1 ? '' : 'disabled'} title="Позже">▶</button>
          <button class="ph-btn" data-action="jn-ph-del" ${attrs} data-i="${i}" ${count > 1 ? '' : 'disabled'} title="Убрать фазу">✕</button></div>
        ${pic}
        <span class="stepper"><button data-action="jn-green" ${attrs} data-i="${i}" data-d="-${GREEN_STEP}" ${ph.green > GREEN_MIN ? '' : 'disabled'} title="Зелёный короче">−</button><b title="Зелёный, с">${ph.green} с</b><button data-action="jn-green" ${attrs} data-i="${i}" data-d="${GREEN_STEP}" ${ph.green < GREEN_MAX ? '' : 'disabled'} title="Зелёный дольше">+</button></span>
      </div>`;
    })
    .join('');
  // «Стрелки налево» что-то добавят: есть фаза, где налево уступают встречным, а перед ней нет фазы только для этих левых.
  const lefts = new Set(turns.filter((t) => t.kind === 'left').map((t) => t.key));
  const permissiveLefts = info.phases.some((ph, i) => {
    const l = ph.yields.filter((k) => lefts.has(k));
    const prev = info.phases[i - 1]?.go ?? [];
    return l.length && !(prev.length === l.length && l.every((k) => prev.includes(k)));
  });
  const clash = info.phases.some((ph) => ph.clashes.length);
  const legend = `<div class="ph-legend"><span>${miniArrow('straight', COLOR.go)} едет</span><span>${miniArrow('left', COLOR.yield, true)} уступает встречным</span><span>${miniArrow('straight', COLOR.off)} красный</span>${
    clash ? `<span class="ph-bad">${miniArrow('straight', COLOR.clash)} конфликт</span>` : ''
  }</div>`;
  return `<div class="rule-row"><span class="lbl2">Фазы ${info.phasesCustom ? '· свои' : '· авто'} — клик по стрелке: зелёный или нет</span>
    <div class="ph-tiles">${tiles}</div>
    ${legend}
    <div class="ph-actions">
      <button class="small" data-action="jn-ph-add" ${attrs} title="Новая фаза: кликами по стрелкам выберите, кому в ней зелёный">＋ Фаза</button>
      <button class="small" data-action="jn-ph-arrows" ${attrs} ${permissiveLefts ? '' : 'disabled'} title="Стрелки налево: перед общим зелёным — короткая фаза только для левых поворотов, без встречных">${miniArrow('left', COLOR.go)} Стрелки налево</button>
      <button class="small" data-action="jn-ph-auto" ${attrs} ${info.phasesCustom || info.node.greens ? '' : 'disabled'} title="Сбросить к авто: встречные подъезды вместе, зелёный по ${LIGHTS.green} с">↺ Авто</button>
    </div></div>`;
}
