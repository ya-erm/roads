/**
 * Баг-репорт: кнопка слева от миникарты — поверх всего, и открытых окон тоже. Нажатие снимает экран игры
 * (карта и панели), открывает редактор пометок (прямоугольник, овал, линия, стрелка, текст, кадр; цвет,
 * толщина, размер текста; пометки выбираются, двигаются и правятся), а «Отправить» собирает отчёт: картинку
 * с пометками, журнал партии и сохранение — на момент снимка.
 *
 * Снимок можно не прикладывать (текстовая идея) — тогда редактор пометок гаснет. Имя запоминается в браузере.
 * Значок скачивания рядом с «Отмена» собирает всё одним ZIP-архивом (bugreport/archive.ts, zip.ts).
 *
 * Модель пометок и отрисовка — src/bugreport (без DOM, с тестами), загрузка и текст отчёта — bugreport/report.ts.
 * Токенов доски здесь нет и быть не может: сайт публичный. «Отправить»: файлы — в публичный загрузчик доски
 * (ссылки войдут в карточку), затем карточка — публичной отправкой доски (POST tasks без авторизации).
 * Дошло — экран благодарности с номером задачи; нет — текст в буфер и архив для ручной передачи.
 */

import './bugReport.css';
import { archiveEntries, archiveName } from '../bugreport/archive';
import { loadAuthor, saveAuthor } from '../bugreport/author';
import { captureScreen, type Shot } from '../bugreport/capture';
import { canvasMeasure, drawMarks, haloFor, markFont, outputSize, renderSketch } from '../bugreport/draw';
import { BUG_BUTTON, bugButtonSpot } from '../bugreport/layout';
import {
  addMark,
  constrain,
  cropHandles,
  dragCrop,
  dragHandle,
  emptySketch,
  findMark,
  fitView,
  handles,
  hitCrop,
  hitTest,
  isShape,
  LINE_HEIGHT,
  markBox,
  moveCrop,
  moveMark,
  normBox,
  outputBox,
  removeMark,
  replaceMark,
  restyle,
  setCrop,
  textBox,
  Timeline,
  toModel,
  toScreen,
  tooSmall,
  type Box,
  type Handle,
  type Mark,
  type Measure,
  type Pt,
  type ShapeKind,
  type ShapeMark,
  type Sketch,
  type Style,
  type TextMark,
  type Tool,
  type View,
} from '../bugreport/marks';
import {
  attachmentNames,
  boardUrl,
  buildLabel,
  reportMarkdown,
  sizeLabel,
  boardReport,
  newReportKey,
  submitReport,
  uploadAttachments,
  UploadError,
  type Receipt,
  type Attachment,
  type AttachKind,
  type ReportInfo,
  type Uploaded,
} from '../bugreport/report';
import { zip } from '../bugreport/zip';
import { SAVE_VERSION, type Game } from '../game/game';

/** Сборка игры — хеш файла сборки (на локальном сервере — dev): в отчёт и сведения архива. */
const BUILD = buildLabel(import.meta.url);

/** Хранилище браузера для имени; закрыто (приватный режим, запрет) — без памяти. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface BugReportDeps {
  /** Холст карты. */
  canvas: HTMLCanvasElement;
  game: () => Game;
  /** Партия файлом — как «Сохранить в файл». */
  saveText: () => string;
  /** Журнал партии (JSON Lines). */
  journalText: () => string;
}

const svg = (body: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Жук в квадрате 24×24 — для кнопки, заголовка и экрана благодарности. */
const BUG_PATHS = `<g stroke="#1f2933" stroke-width="1.6" stroke-linecap="round" fill="none"><path d="M9.6 5.4L7.6 2.8M14.4 5.4L16.4 2.8"/><path d="M6 10.5L3 9.2M5.6 14.5H2.6M6.4 18.2L3.8 20.6M18 10.5L21 9.2M18.4 14.5H21.4M17.6 18.2L20.2 20.6"/></g>
    <path d="M8.3 8.2a3.7 3.4 0 0 1 7.4 0z" fill="#1f2933"/>
    <ellipse cx="12" cy="14.6" rx="6.2" ry="7" fill="#e8483f" stroke="#1f2933" stroke-width="1.6"/>
    <path d="M12 8.2V21.4" stroke="#1f2933" stroke-width="1.4"/>
    <circle cx="9.3" cy="13" r="1.15" fill="#1f2933"/><circle cx="14.7" cy="16.6" r="1.15" fill="#1f2933"/><circle cx="9.6" cy="17.8" r="0.9" fill="#1f2933"/>`;

/** Жук: кнопка и заголовок окна. */
export function bugSvg(size = 24): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${BUG_PATHS}</svg>`;
}

/** Экран благодарности: зелёная галочка в круге, жук на ней и конфетти цветами игры. */
function thanksSvg(): string {
  return `<svg viewBox="0 0 140 112" width="175" height="140" aria-hidden="true">
    <rect x="16" y="22" width="9" height="4" rx="2" fill="#f2c94c" transform="rotate(-25 20 24)"/>
    <rect x="114" y="74" width="10" height="4" rx="2" fill="#2f80ed" transform="rotate(30 119 76)"/>
    <rect x="98" y="98" width="8" height="3.6" rx="1.8" fill="#f2994a" transform="rotate(-15 102 100)"/>
    <rect x="22" y="94" width="8" height="3.6" rx="1.8" fill="#7a5cc4" transform="rotate(20 26 96)"/>
    <circle cx="30" cy="80" r="3.5" fill="#e8483f"/><circle cx="124" cy="34" r="3" fill="#7a5cc4"/><circle cx="12" cy="56" r="2.6" fill="#2e9d57"/><circle cx="46" cy="12" r="2.4" fill="#2f80ed"/>
    <circle cx="70" cy="60" r="40" fill="#e9f6ee"/>
    <circle cx="70" cy="60" r="29" fill="#2e9d57"/>
    <path d="M56 60.5L66 70.5L85 50.5" stroke="#fff" stroke-width="7.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <g transform="translate(86 4) scale(1.55) rotate(18 12 12)">${BUG_PATHS}</g></svg>`;
}

const TOOLS: { id: Tool; key: string; code: string; tip: string; icon: string }[] = [
  { id: 'select', key: 'V', code: 'KeyV', tip: 'Выбрать и двигать', icon: svg('<path d="M6 3.5L18.5 12L12.6 13.4L9.6 19z" fill="currentColor" fill-opacity=".12"/>') },
  { id: 'crop', key: 'C', code: 'KeyC', tip: 'Кадрировать: оставить часть снимка', icon: svg('<path d="M6.5 2.5V17.5H21.5"/><path d="M2.5 6.5H17.5V21.5"/>') },
  { id: 'rect', key: 'R', code: 'KeyR', tip: 'Прямоугольник', icon: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/>') },
  { id: 'ellipse', key: 'O', code: 'KeyO', tip: 'Овал', icon: svg('<ellipse cx="12" cy="12" rx="9" ry="6.8"/>') },
  { id: 'line', key: 'L', code: 'KeyL', tip: 'Линия', icon: svg('<path d="M4.5 19.5L19.5 4.5"/>') },
  { id: 'arrow', key: 'A', code: 'KeyA', tip: 'Стрелка', icon: svg('<path d="M4.5 19.5L18.5 5.5"/><path d="M10 5H19V14"/>') },
  { id: 'text', key: 'T', code: 'KeyT', tip: 'Текст: щёлкните, где написать', icon: svg('<path d="M5 7V4.5H19V7"/><path d="M12 4.5V19.5"/><path d="M9 19.5H15"/>') },
];

const COLORS = ['#e8483f', '#f2994a', '#f2c94c', '#2e9d57', '#2f80ed', '#7a5cc4', '#1f2933', '#ffffff'];
const WIDTHS = [2, 4, 6, 10];
const SIZES = [16, 24, 32, 48];

const HINTS: Record<Tool, string> = {
  select: 'Щёлкните пометку — выбрать; тяните её или узелки. Delete — удалить',
  crop: 'Обведите рамкой то, что оставить; узелки и сама рамка тянутся',
  rect: 'Протяните по снимку. Shift — квадрат',
  ellipse: 'Протяните по снимку. Shift — круг',
  line: 'Протяните по снимку. Shift — шаг 45°',
  arrow: 'Протяните от начала к острию. Shift — шаг 45°',
  text: 'Щёлкните, где написать. Текст тянется за рамку, двойной щелчок — править',
};

const ICON = {
  trash: svg('<path d="M4 7H20"/><path d="M6.5 7L7.5 20H16.5L17.5 7"/><path d="M9.5 7V4H14.5V7"/><path d="M10 11V16.5M14 11V16.5"/>', 19),
  undo: svg('<path d="M9 14L4 9L9 4"/><path d="M4 9H14.5A5.5 5.5 0 0 1 14.5 20H11"/>', 19),
  redo: svg('<path d="M15 14L20 9L15 4"/><path d="M20 9H9.5A5.5 5.5 0 0 0 9.5 20H13"/>', 19),
  full: svg('<path d="M4 9V4H9M15 4H20V9M20 15V20H15M9 20H4V15"/>', 19),
  shot: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 15.5L8.5 11L13 15L16 12.5L21 16.5"/><circle cx="16" cy="9" r="1.4"/>', 18),
  journal: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8H15.5M8.5 12H15.5M8.5 16H12.5"/>', 18),
  save: svg('<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 4V9H15V4"/><rect x="7.5" y="13" width="9" height="5" rx="1"/>', 18),
  link: svg('<path d="M14 4H20V10"/><path d="M20 4L11 13"/><path d="M18 14V19A1 1 0 0 1 17 20H5A1 1 0 0 1 4 19V7A1 1 0 0 1 5 6H10"/>', 16),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5A1 1 0 0 0 15 4H5A1 1 0 0 0 4 5V15A1 1 0 0 0 5 16H8"/>', 16),
  download: svg('<path d="M12 4V15M7.5 10.5L12 15L16.5 10.5"/><path d="M4.5 16V19.5H19.5V16"/>', 16),
  archive: svg('<path d="M12 3.5V14.5M7.5 10L12 14.5L16.5 10"/><path d="M4 15.5V20H20V15.5"/>', 21),
  noShot: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 15.5L8.5 11L13 15L16 12.5L21 16.5"/><path d="M3.5 3.5L20.5 20.5"/>', 40),
  person: svg('<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20C5.6 16.2 8.4 14 12 14S18.4 16.2 19 20"/>', 18),
  ok: svg('<path d="M5 12.5L10 17.5L19 7"/>', 18),
  warn: svg('<path d="M12 3.5L21.5 20H2.5Z"/><path d="M12 10V14"/><path d="M12 17H12.01"/>', 18),
};

type Drag =
  | { type: 'create'; id: number; base: Sketch }
  | { type: 'move'; id: number; start: Pt; orig: Mark; base: Sketch; moved: boolean }
  | { type: 'handle'; id: number; handle: Handle; orig: ShapeMark; base: Sketch }
  | { type: 'crop-new'; start: Pt; base: Sketch }
  | { type: 'crop-move'; start: Pt; orig: Box; base: Sketch }
  | { type: 'crop-handle'; handle: Handle; orig: Box; base: Sketch };

/** Партия на момент снимка: журнал и сохранение — те же, что на картинке. */
interface Moment {
  at: Date;
  journal: string;
  journalEntries: number;
  save: string;
}

interface Sent {
  /** Текст отчёта для буфера и ручной отправки (файлы — «приложены»). */
  text: string;
  /** Карточка на доске; null — отчёт не отправился (error — почему), тогда буфер и архив. */
  receipt: Receipt | null;
  error: string;
  /** Файлы на доске; null — загрузчик их не принял (uploadError), [] — прикладывать было нечего. */
  uploaded: Uploaded[] | null;
  uploadError: string;
  copied: boolean;
}

/** Ставит кнопку баг-репорта. Вызывать раньше панелей игры: клавиши открытого редактора не должны доходить до карты. */
export function installBugReport(deps: BugReportDeps): void {
  new BugReport(deps);
}

class BugReport {
  private readonly button: HTMLButtonElement;
  private readonly screen: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly textEdit: HTMLTextAreaElement;
  private readonly desc: HTMLTextAreaElement;
  private readonly nameInput: HTMLInputElement;
  private readonly thanks: HTMLElement;
  private readonly measure: Measure;

  private isOpen = false;
  private busy = false;
  private shot: Shot | null = null;
  private moment: Moment | null = null;
  private tl = new Timeline<Sketch>(emptySketch());
  private tool: Tool = 'ellipse';
  private style: Style = { color: COLORS[0], width: WIDTHS[1], size: SIZES[1] };
  private selected: number | null = null;
  private editing: number | null = null;
  /** Снимок пометок до начала правки текста: вся правка — один шаг отмены. */
  private editBase: Sketch | null = null;
  private drag: Drag | null = null;
  private colorBase: Sketch | null = null;
  private view: View = { zoom: 1, ox: 0, oy: 0 };
  private hoverText: number | null = null;
  /** Что приложить к отчёту; снимок снят — редактор пометок гаснет, пометки ждут, пока его вернут. */
  private readonly include: Record<AttachKind, boolean> = { shot: true, journal: true, save: true };
  private sending = false;
  private archiving = false;
  private sent: Sent | null = null;
  /** Ключ этого отчёта: повторная отправка после сбоя не создаст на доске вторую карточку. */
  private reportKey = newReportKey();
  private speedBefore = 0;

  constructor(private readonly deps: BugReportDeps) {
    this.button = document.createElement('button');
    this.button.className = 'bug-btn';
    this.button.setAttribute('data-shot-skip', '');
    this.button.dataset.tip = 'Сообщить об ошибке: снимок экрана с пометками, журнал и сохранение партии';
    this.button.dataset.tipEnd = '';
    this.button.setAttribute('aria-label', 'Сообщить об ошибке');
    this.button.innerHTML = bugSvg(26);
    // Фокус кнопке не нужен: иначе пробел (пауза в игре) после закрытия окна снова открыл бы отчёт.
    this.button.addEventListener('mousedown', (e) => e.preventDefault());
    this.button.addEventListener('click', () => {
      this.button.blur();
      void this.open();
    });
    document.body.appendChild(this.button);

    this.screen = document.createElement('div');
    this.screen.className = 'bug-screen hidden';
    this.screen.setAttribute('data-shot-skip', '');
    this.screen.innerHTML = this.markup();
    document.body.appendChild(this.screen);
    const q = <T extends Element>(sel: string) => this.screen.querySelector(sel) as T;
    this.stage = q('[data-bug-stage]');
    this.canvas = q('[data-bug-canvas]');
    this.ctx = this.canvas.getContext('2d')!;
    this.textEdit = q('[data-bug-text]');
    this.desc = q('[data-bug-desc]');
    this.nameInput = q('[data-bug-name]');
    this.thanks = q('[data-bug-thanks]');
    this.measure = canvasMeasure(document.createElement('canvas').getContext('2d')!);

    this.screen.addEventListener('click', (e) => this.onClick(e));
    this.screen.addEventListener('change', (e) => this.onChange(e));
    this.screen.addEventListener('input', (e) => this.onInput(e));
    // Мышь в редакторе — только его: карта под окном не должна ни подсвечивать, ни тянуть.
    for (const t of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu'] as const) {
      this.screen.addEventListener(t, (e) => e.stopPropagation());
    }
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    // Пока правится текст, фокус остаётся в поле: нажатие на снимок (тянуть рамку) или на кнопку цвета и размера
    // правку не заканчивает — её заканчивают щелчок мимо текста, Esc и смена инструмента.
    this.canvas.addEventListener('mousedown', (e) => this.editing !== null && e.preventDefault());
    q('.bug-tools').addEventListener('mousedown', (e) => (e.target as Element).closest('button') && e.preventDefault());
    this.textEdit.addEventListener('blur', () => this.commitEdit());
    new ResizeObserver(() => this.isOpen && this.render()).observe(this.stage);
    // Клавиши — раньше игры (слушатель на window в фазе захвата, поставлен до панелей): пока окно открыто,
    // до карты и панелей не доходит ни одна.
    window.addEventListener('keydown', (e) => this.onKey(e), { capture: true });

    const place = () => this.place();
    window.addEventListener('resize', place);
    const watch = new ResizeObserver(place);
    // Миникарта и панель инструментов появляются, когда панели игры построены, — ищем их до первого успеха.
    const find = () => {
      const mm = document.querySelector('.minimap-wrap');
      const tb = document.querySelector('.toolbar');
      if (mm) watch.observe(mm);
      if (tb) watch.observe(tb);
      place();
      if (!mm || !tb) requestAnimationFrame(find);
    };
    find();
  }

  // ---------- Разметка ----------

  private markup(): string {
    const tools = TOOLS.map((t) => `<button data-bug-tool="${t.id}" data-tip="${t.tip} (${t.key})">${t.icon}</button>`).join('');
    const colors = COLORS.map((c) => `<button class="bug-color" data-bug-color="${c}" data-tip="Цвет"><i class="bug-swatch" style="background:${c}"></i></button>`).join('');
    const widths = WIDTHS.map(
      (w) =>
        `<button data-bug-width="${w}" data-tip="Толщина ${w} px"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 12H20" stroke="currentColor" stroke-width="${Math.min(9, w * 0.75 + 0.5)}" stroke-linecap="round"/></svg></button>`,
    ).join('');
    const sizes = SIZES.map((s) => `<button data-bug-size="${s}" data-tip="Размер текста ${s} px"><span style="font-size:${Math.round(9 + s * 0.22)}px">A</span></button>`).join('');
    return `<div class="bug-modal" role="dialog" aria-label="Сообщить об ошибке">
      <header class="bug-head">${bugSvg(26)}<h2>Сообщить об ошибке</h2><span class="bug-warn hidden" data-bug-hudwarn data-tip="Браузер не дал снять панели — на снимке только карта">${ICON.warn}только карта</span>
        <button class="bug-x" data-bug="close" data-tip="Закрыть без отправки (Esc)" data-tip-end>✕</button></header>
      <div class="bug-tools">
        <div class="bug-group" role="toolbar">${tools}</div>
        <div class="bug-group">${colors}<label class="bug-color custom" data-tip="Свой цвет"><i class="bug-swatch"></i><input type="color" data-bug-custom value="#e8483f" /></label></div>
        <div class="bug-group" data-bug-widths>${widths}</div>
        <div class="bug-group" data-bug-sizes>${sizes}</div>
        <div class="bug-group">
          <button data-bug="delete" data-tip="Удалить пометку (Delete)">${ICON.trash}</button>
          <button data-bug="undo" data-tip="Отменить (Ctrl+Z)">${ICON.undo}</button>
          <button data-bug="redo" data-tip="Повторить (Ctrl+Shift+Z)">${ICON.redo}</button>
          <button data-bug="uncrop" data-tip="Весь снимок — убрать кадр">${ICON.full}</button>
        </div>
      </div>
      <div class="bug-body">
        <div class="bug-stage" data-bug-stage>
          <canvas data-bug-canvas></canvas>
          <textarea class="bug-text-edit hidden" data-bug-text spellcheck="false" rows="1"></textarea>
          <div class="bug-hint" data-bug-hint></div>
          <div class="bug-off">${ICON.noShot}<b>Без снимка</b><button class="bug-secondary small" data-bug="shot-on">${ICON.shot}Приложить снимок</button></div>
        </div>
        <aside class="bug-side">
          <label class="bug-name">${ICON.person}<input type="text" data-bug-name maxlength="32" autocomplete="name" placeholder="Ваше имя" /></label>
          <textarea class="bug-desc" data-bug-desc placeholder="Что пошло не так? Как это повторить?"></textarea>
          <div class="bug-files" data-bug-files></div>
          <div class="bug-result hidden" data-bug-result></div>
          <div class="bug-actions">
            <button class="bug-icon-btn" data-bug="archive" data-tip="Скачать всё одним архивом (.zip): снимок, журнал, сохранение, описание и сведения об игре">${ICON.archive}</button>
            <button class="bug-secondary" data-bug="close">Отмена</button>
            <button class="bug-primary" data-bug="send">Отправить</button>
          </div>
        </aside>
      </div>
      <div class="bug-thanks hidden" data-bug-thanks></div>
    </div>`;
  }

  /** Место кнопки — слева от миникарты (см. bugButtonSpot). */
  private place(): void {
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const spot = bugButtonSpot({ w: window.innerWidth, h: window.innerHeight }, rect('.minimap-wrap'), rect('.toolbar'), BUG_BUTTON.size);
    this.button.style.right = `${spot.right}px`;
    this.button.style.bottom = `${spot.bottom}px`;
  }

  // ---------- Открыть и закрыть ----------

  private async open(): Promise<void> {
    if (this.isOpen || this.busy) return;
    this.busy = true;
    this.button.classList.add('busy');
    const game = this.deps.game();
    try {
      // Журнал и сохранение — в тот же момент, что и снимок.
      const moment: Moment = { at: new Date(), journal: this.deps.journalText(), journalEntries: game.journal.entries.length, save: this.deps.saveText() };
      const shot = await captureScreen(this.deps.canvas, (el) => el.hasAttribute('data-shot-skip') || el.classList.contains('tip-float'));
      this.moment = moment;
      this.shot = shot;
    } catch (e) {
      console.error(e);
      game.notify('Не удалось снять экран для отчёта', '#e5534b');
      return;
    } finally {
      this.busy = false;
      this.button.classList.remove('busy');
    }
    this.speedBefore = game.speed;
    game.speed = 0;
    this.tl = new Timeline(emptySketch());
    // Новый снимок — новый отчёт.
    this.reportKey = newReportKey();
    this.selected = null;
    this.editing = null;
    this.drag = null;
    this.sent = null;
    this.desc.value = '';
    this.nameInput.value = loadAuthor(storage());
    this.include.shot = this.include.journal = this.include.save = true;
    this.thanks.classList.add('hidden');
    this.isOpen = true;
    this.screen.classList.remove('hidden');
    this.button.classList.add('hidden');
    this.screen.querySelector('[data-bug-hudwarn]')!.classList.toggle('hidden', this.shot!.hud);
    this.setTool(this.tool);
    this.renderFiles();
    this.setShotOn(true);
    this.renderResult();
    this.render();
  }

  /** Приложить снимок или нет. Без снимка редактор пометок гаснет; сами пометки остаются — вернётся снимок, вернутся и они. */
  private setShotOn(on: boolean): void {
    this.commitEdit();
    this.include.shot = on;
    this.selected = null;
    this.drag = null;
    this.stage.classList.toggle('off', !on);
    this.screen.querySelector('.bug-tools')!.classList.toggle('off', !on);
    this.screen.querySelector('[data-bug-hudwarn]')!.classList.toggle('dim', !on);
    const box = this.screen.querySelector<HTMLInputElement>('[data-bug-include="shot"]');
    if (box) box.checked = on;
    this.changed();
    this.redraw();
  }

  private close(): void {
    if (!this.isOpen) return;
    this.commitEdit();
    this.isOpen = false;
    // Фокус не остаётся на кнопках спрятанного окна — клавиши снова у игры.
    if (this.screen.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.screen.classList.add('hidden');
    this.button.classList.remove('hidden');
    const game = this.deps.game();
    if (game.speed === 0) game.speed = this.speedBefore;
    this.shot = null;
    this.moment = null;
  }

  // ---------- Инструменты и свойства ----------

  private setTool(tool: Tool): void {
    this.commitEdit();
    this.tool = tool;
    if (tool === 'crop') this.selected = null;
    this.stage.dataset.tool = tool;
    this.screen.querySelector('[data-bug-hint]')!.textContent = HINTS[tool];
    this.syncControls();
    this.render();
  }

  /** Стиль на панели: у выбранной пометки — её, иначе — для новых. */
  private currentStyle(): Style {
    const m = findMark(this.tl.now, this.selected);
    if (!m) return this.style;
    return m.kind === 'text' ? { ...this.style, color: m.color, size: m.size } : { ...this.style, color: m.color, width: m.width };
  }

  private syncControls(): void {
    const s = this.currentStyle();
    const sel = findMark(this.tl.now, this.selected);
    const all = <T extends HTMLElement>(sel: string) => [...this.screen.querySelectorAll<T>(sel)];
    for (const b of all('[data-bug-tool]')) b.classList.toggle('active', b.dataset.bugTool === this.tool);
    let known = false;
    for (const b of all('[data-bug-color]')) {
      const on = b.dataset.bugColor === s.color;
      known ||= on;
      b.classList.toggle('active', on);
    }
    const custom = this.screen.querySelector<HTMLElement>('.bug-color.custom')!;
    custom.classList.toggle('active', !known);
    custom.querySelector<HTMLElement>('.bug-swatch')!.style.background = known ? '' : s.color;
    for (const b of all('[data-bug-width]')) b.classList.toggle('active', Number(b.dataset.bugWidth) === s.width);
    for (const b of all('[data-bug-size]')) b.classList.toggle('active', Number(b.dataset.bugSize) === s.size);
    // Толщина — у фигур, размер — у текста: у выбранной пометки лишнее гаснет.
    this.screen.querySelector('[data-bug-widths]')!.classList.toggle('dim', sel?.kind === 'text' || (!sel && this.tool === 'text'));
    this.screen.querySelector('[data-bug-sizes]')!.classList.toggle('dim', !!sel && sel.kind !== 'text');
    const btn = (name: string) => this.screen.querySelector<HTMLButtonElement>(`[data-bug="${name}"]`)!;
    btn('delete').disabled = !sel;
    btn('undo').disabled = !this.tl.canUndo;
    btn('redo').disabled = !this.tl.canRedo;
    btn('uncrop').disabled = !this.tl.now.crop;
    btn('send').disabled = this.sending;
  }

  /** Новое значение с панели: и для новых пометок, и для выбранной. */
  private applyStyle(patch: Partial<Style>, preview = false): void {
    this.style = { ...this.style, ...patch };
    const m = findMark(this.tl.now, this.selected);
    if (m) {
      const next = replaceMark(this.tl.now, restyle(m, patch));
      if (preview || this.editing !== null) this.tl.preview(next);
      else this.tl.set(next);
      this.changed();
    }
    if (this.editing !== null) this.placeEditor();
    this.syncControls();
    this.render();
  }

  // ---------- Клики по кнопкам ----------

  private onClick(e: MouseEvent): void {
    const el = (e.target as Element).closest<HTMLElement>('[data-bug-tool],[data-bug-color],[data-bug-width],[data-bug-size],[data-bug]');
    if (!el) {
      if (e.target === this.screen) this.close();
      return;
    }
    if (el.dataset.bugTool) return this.setTool(el.dataset.bugTool as Tool);
    if (el.dataset.bugColor) return this.applyStyle({ color: el.dataset.bugColor });
    if (el.dataset.bugWidth) return this.applyStyle({ width: Number(el.dataset.bugWidth) });
    if (el.dataset.bugSize) return this.applyStyle({ size: Number(el.dataset.bugSize) });
    switch (el.dataset.bug) {
      case 'close':
        return this.close();
      case 'delete':
        return this.deleteSelected();
      case 'undo':
        return this.history(-1);
      case 'redo':
        return this.history(1);
      case 'uncrop':
        this.tl.set({ ...this.tl.now, crop: null });
        this.changed();
        return this.redraw();
      case 'send':
        return void this.send();
      case 'copy':
        return void this.copyAgain();
      case 'archive':
        return void this.downloadArchive();
      case 'shot-on':
        return this.setShotOn(true);
    }
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.bugCustom !== undefined) {
      // Палитра закрылась: всё, что меняли в ней, — один шаг отмены.
      if (this.colorBase) this.tl.settle(this.colorBase);
      this.colorBase = null;
      this.syncControls();
    }
    if (t.dataset.bugInclude) {
      const kind = t.dataset.bugInclude as AttachKind;
      if (kind === 'shot') return this.setShotOn(t.checked);
      this.include[kind] = t.checked;
      this.changed();
    }
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLElement;
    if (t === this.textEdit) return this.onEditInput();
    if (t === this.desc) return this.changed();
    if (t === this.nameInput) {
      saveAuthor(storage(), this.nameInput.value);
      return this.changed();
    }
    if (t instanceof HTMLInputElement && t.dataset.bugCustom !== undefined) {
      this.colorBase ??= this.tl.now;
      this.applyStyle({ color: t.value }, true);
    }
  }

  private history(dir: -1 | 1): void {
    this.commitEdit();
    if (dir < 0 ? this.tl.undo() : this.tl.redo()) {
      if (!findMark(this.tl.now, this.selected)) this.selected = null;
      this.changed();
    }
    this.redraw();
  }

  private deleteSelected(): void {
    if (this.selected === null) return;
    if (this.editing !== null) {
      this.textEdit.classList.add('hidden');
      this.editing = null;
    }
    const base = this.editBase ?? this.tl.now;
    this.editBase = null;
    this.tl.preview(removeMark(this.tl.now, this.selected));
    this.tl.settle(base);
    this.selected = null;
    this.changed();
    this.redraw();
  }

  /** Что-то поменялось после отправки — прежний результат уже не про эту картинку. */
  private changed(): void {
    if (!this.sent) return;
    this.sent = null;
    this.renderResult();
  }

  private redraw(): void {
    this.syncControls();
    this.render();
    // Размер итоговой картинки — по кадру.
    const note = this.screen.querySelector('[data-bug-file-note="shot"]');
    if (note && this.shot) {
      const out = outputBox(this.tl.now, this.shot.width, this.shot.height);
      note.textContent = `${Math.round(out.w)} × ${Math.round(out.h)}`;
    }
  }

  // ---------- Мышь на снимке ----------

  private point(e: MouseEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return toModel(this.view, { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  private get tol(): number {
    return 6 / this.view.zoom;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.shot || !this.include.shot) return;
    const p = this.point(e);
    const sk = this.tl.now;
    if (this.editing !== null) {
      // Поле ввода открыто: рамку правимого текста можно тянуть, щелчок мимо — закончить правку.
      const hit = hitTest(sk.marks, p, this.tol, this.measure);
      if (hit?.id !== this.editing) {
        this.commitEdit();
        return;
      }
    }
    this.canvas.setPointerCapture(e.pointerId);
    if (this.tool === 'crop') {
      const h = sk.crop ? hitCrop(sk.crop, p, this.tol) : null;
      if (h === 'move') this.drag = { type: 'crop-move', start: p, orig: sk.crop!, base: sk };
      else if (h) this.drag = { type: 'crop-handle', handle: h, orig: sk.crop!, base: sk };
      else this.drag = { type: 'crop-new', start: p, base: sk };
      return;
    }
    const hit = hitTest(sk.marks, p, this.tol, this.measure, { selected: this.selected, inside: this.tool === 'select' });
    if (hit) {
      const m = findMark(sk, hit.id)!;
      this.selected = hit.id;
      if (hit.handle && isShape(m)) this.drag = { type: 'handle', id: m.id, handle: hit.handle, orig: m, base: sk };
      else this.drag = { type: 'move', id: m.id, start: p, orig: m, base: sk, moved: false };
      this.redraw();
      return;
    }
    if (this.tool === 'select') {
      this.selected = null;
      this.redraw();
      return;
    }
    if (this.tool === 'text') {
      const s = this.style.size;
      const [next, id] = addMark(sk, { kind: 'text', color: this.style.color, size: s, at: { x: p.x, y: p.y - s * 0.6 }, text: '' });
      this.tl.preview(next);
      this.startEdit(id, sk);
      return;
    }
    const [next, id] = addMark(sk, { kind: this.tool, color: this.style.color, width: this.style.width, a: p, b: p });
    this.tl.preview(next);
    this.selected = id;
    this.drag = { type: 'create', id, base: sk };
  }

  private onMove(e: PointerEvent): void {
    if (!this.shot) return;
    const p = this.point(e);
    const d = this.drag;
    if (!d) return this.hover(p);
    const { width: W, height: H } = this.shot;
    switch (d.type) {
      case 'create': {
        const m = findMark(this.tl.now, d.id) as ShapeMark;
        const b = e.shiftKey ? constrain(m.kind as ShapeKind, m.a, p) : p;
        this.tl.preview(replaceMark(this.tl.now, { ...m, b }));
        break;
      }
      case 'move': {
        const dx = p.x - d.start.x;
        const dy = p.y - d.start.y;
        d.moved ||= Math.hypot(dx, dy) * this.view.zoom > 2;
        if (d.moved) this.tl.preview(replaceMark(d.base, moveMark(d.orig, dx, dy)));
        if (this.editing === d.id) this.placeEditor();
        break;
      }
      case 'handle': {
        const end = e.shiftKey ? constrain(d.orig.kind, d.handle === 'a' ? d.orig.b : d.orig.a, p) : p;
        this.tl.preview(replaceMark(d.base, dragHandle(d.orig, d.handle, d.handle === 'a' || d.handle === 'b' ? end : p)));
        break;
      }
      case 'crop-new':
        this.tl.preview({ ...d.base, crop: normBox(d.start, p) });
        break;
      case 'crop-move':
        this.tl.preview({ ...d.base, crop: moveCrop(d.orig, p.x - d.start.x, p.y - d.start.y, W, H) });
        break;
      case 'crop-handle':
        this.tl.preview({ ...d.base, crop: dragCrop(d.orig, d.handle, p) });
        break;
    }
    this.render();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || !this.shot) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const { width: W, height: H } = this.shot;
    switch (d.type) {
      case 'create': {
        const m = findMark(this.tl.now, d.id);
        if (!m || tooSmall(m)) {
          // Щелчок без протяжки — пометки нет.
          this.tl.preview(d.base);
          this.selected = null;
        } else this.tl.settle(d.base);
        break;
      }
      case 'move':
        if (this.editing === d.id) break;
        if (d.moved) this.tl.settle(d.base);
        else if (d.orig.kind === 'text' && this.tool === 'text') this.startEdit(d.id);
        break;
      case 'handle':
        this.tl.settle(d.base);
        break;
      default: {
        const crop = setCrop(this.tl.now, this.tl.now.crop, W, H);
        // Новый кадр — случайный щелчок: остаётся прежний.
        if (d.type === 'crop-new' && !crop.crop) this.tl.preview(d.base);
        else {
          this.tl.preview(crop);
          this.tl.settle(d.base);
        }
      }
    }
    this.changed();
    this.redraw();
  }

  private onDouble(e: MouseEvent): void {
    if (this.tool === 'crop') return;
    const hit = hitTest(this.tl.now.marks, this.point(e), this.tol, this.measure);
    const m = hit && findMark(this.tl.now, hit.id);
    if (m?.kind === 'text') this.startEdit(m.id);
  }

  /** Курсор над снимком: что будет, если нажать. */
  private hover(p: Pt): void {
    const sk = this.tl.now;
    let cursor = this.tool === 'text' ? 'text' : this.tool === 'select' ? 'default' : 'crosshair';
    let text: number | null = null;
    if (this.tool === 'crop') {
      const h = sk.crop ? hitCrop(sk.crop, p, this.tol) : null;
      if (h === 'move') cursor = 'move';
      else if (h) cursor = h === 'a' || h === 'b' ? 'nwse-resize' : 'nesw-resize';
      else cursor = 'crosshair';
    } else {
      const hit = hitTest(sk.marks, p, this.tol, this.measure, { selected: this.selected, inside: this.tool === 'select' });
      const m = hit && findMark(sk, hit.id);
      if (hit?.handle && m) {
        const hs = handles(m);
        const i = hs.findIndex((h) => h.h === hit.handle);
        cursor = hs.length === 4 ? cornerCursor(hs[i].p, hs[(i + 2) % 4].p) : 'move';
      } else if (hit) {
        cursor = 'move';
        if (findMark(sk, hit.id)?.kind === 'text') text = hit.id;
      }
    }
    this.canvas.style.cursor = cursor;
    if (text !== this.hoverText) {
      this.hoverText = text;
      this.render();
    }
  }

  // ---------- Текст прямо на снимке ----------

  private startEdit(id: number, base: Sketch = this.tl.now): void {
    this.editing = id;
    this.selected = id;
    this.editBase = base;
    const m = findMark(this.tl.now, id) as TextMark;
    this.textEdit.value = m.text;
    this.textEdit.classList.remove('hidden');
    this.placeEditor();
    this.syncControls();
    this.render();
    this.textEdit.focus();
    this.textEdit.setSelectionRange(m.text.length, m.text.length);
  }

  /** Поле ввода — ровно поверх текста: тот же шрифт, цвет и масштаб. */
  private placeEditor(): void {
    const m = findMark(this.tl.now, this.editing) as TextMark | undefined;
    if (!m) return;
    const z = this.view.zoom;
    const s = toScreen(this.view, m.at);
    const box = textBox(m, this.measure);
    const size = m.size * z;
    const st = this.textEdit.style;
    // canvas пишет от верха буквы, поле — по середине строки: сдвиг на половину межстрочного отступа.
    st.left = `${s.x}px`;
    st.top = `${s.y - ((LINE_HEIGHT - 1) / 2) * size}px`;
    st.width = `${(box.w - 2 * m.size * 0.3) * z + size}px`;
    st.height = `${m.text.split('\n').length * size * LINE_HEIGHT}px`;
    st.font = markFont(size);
    st.lineHeight = String(LINE_HEIGHT);
    st.color = m.color;
    st.setProperty('--halo', haloFor(m.color));
  }

  private onEditInput(): void {
    const m = findMark(this.tl.now, this.editing) as TextMark | undefined;
    if (!m) return;
    this.tl.preview(replaceMark(this.tl.now, { ...m, text: this.textEdit.value }));
    this.placeEditor();
    this.changed();
    this.render();
  }

  /** Правка текста закончена: пустой текст убирается, вся правка — один шаг отмены. */
  private commitEdit(): void {
    if (this.editing === null) return;
    const m = findMark(this.tl.now, this.editing);
    this.editing = null;
    // Фокус уходит из поля сразу: спрятанное поле, оставшись в фокусе, съело бы следующую клавишу (букву инструмента).
    if (document.activeElement === this.textEdit) this.textEdit.blur();
    this.textEdit.classList.add('hidden');
    if (m && tooSmall(m)) {
      this.tl.preview(removeMark(this.tl.now, m.id));
      this.selected = null;
    }
    if (this.editBase) this.tl.settle(this.editBase);
    this.editBase = null;
    this.redraw();
  }

  // ---------- Клавиши ----------

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    // Пока окно открыто, игра клавиш не видит; набор текста в полях идёт как обычно.
    e.stopImmediatePropagation();
    const t = e.target;
    if (t === this.textEdit && this.editing !== null) {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commitEdit();
      }
      return;
    }
    if ((t instanceof HTMLTextAreaElement && t !== this.textEdit) || (t instanceof HTMLInputElement && t.type !== 'checkbox')) {
      if (e.key === 'Escape') (t as HTMLElement).blur();
      // Имя введено — Enter переводит к описанию.
      if (t === this.nameInput && e.key === 'Enter') {
        e.preventDefault();
        this.desc.focus();
      }
      return;
    }
    // Без снимка пометок нет — из клавиш редактора остаётся только Esc.
    if (!this.include.shot && e.key !== 'Escape') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      return this.history(e.shiftKey ? 1 : -1);
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      return this.history(1);
    }
    if (mod || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.selected !== null) {
        this.selected = null;
        this.redraw();
      } else this.close();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      return this.deleteSelected();
    }
    const tool = TOOLS.find((x) => x.code === e.code);
    if (tool) {
      e.preventDefault();
      this.setTool(tool.id);
    }
  }

  // ---------- Отрисовка редактора ----------

  private render(): void {
    const shot = this.shot;
    if (!shot) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = this.stage.clientWidth;
    const ch = this.stage.clientHeight;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const sk = this.tl.now;
    const W = shot.width;
    const H = shot.height;
    const cropping = this.tool === 'crop';
    // Пока кадрируем — виден весь снимок, потом — только кадр.
    const region = cropping || !sk.crop ? { x: 0, y: 0, w: W, h: H } : sk.crop;
    const prev = this.view;
    this.view = fitView(region, cw, ch, 16);
    if (this.editing !== null && (prev.zoom !== this.view.zoom || prev.ox !== this.view.ox || prev.oy !== this.view.oy)) this.placeEditor();
    const v = this.view;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    // Тень под снимком.
    const tl = toScreen(v, { x: region.x, y: region.y });
    ctx.save();
    ctx.shadowColor = 'rgba(20, 30, 20, 0.28)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#fff';
    ctx.fillRect(tl.x, tl.y, region.w * v.zoom, region.h * v.zoom);
    ctx.restore();

    ctx.save();
    ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.ox, dpr * v.oy);
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.w, region.h);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shot.canvas, 0, 0, W, H);
    drawMarks(ctx, sk.marks, this.editing);
    ctx.restore();

    if (cropping) this.drawCrop(sk.crop);
    else this.drawSelection(sk);
  }

  private handle(p: Pt, round = false): void {
    const ctx = this.ctx;
    const s = toScreen(this.view, p);
    ctx.beginPath();
    if (round) ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    else ctx.rect(s.x - 4.5, s.y - 4.5, 9, 9);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#2f80ed';
    ctx.stroke();
  }

  private dashed(box: Box, color = '#2f80ed'): void {
    const ctx = this.ctx;
    const a = toScreen(this.view, { x: box.x, y: box.y });
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeRect(a.x, a.y, box.w * this.view.zoom, box.h * this.view.zoom);
    ctx.lineDashOffset = 4.5;
    ctx.strokeStyle = color;
    ctx.strokeRect(a.x, a.y, box.w * this.view.zoom, box.h * this.view.zoom);
    ctx.restore();
  }

  /** Выбранная пометка — узелки; у текста — рамка, за которую его тянут (и у текста под курсором). */
  private drawSelection(sk: Sketch): void {
    for (const m of sk.marks) {
      if (m.kind === 'text' && (m.id === this.selected || m.id === this.hoverText || m.id === this.editing)) {
        this.dashed(textBox(m, this.measure), m.id === this.selected ? '#2f80ed' : '#8a96a3');
      }
    }
    const m = findMark(sk, this.selected);
    if (!m || m.kind === 'text') return;
    // У овала узелки — на углах его рамки: рамку и показываем.
    if (m.kind === 'ellipse') this.dashed(markBox({ ...m, width: 0 }, this.measure), '#8a96a3');
    for (const h of handles(m)) this.handle(h.p, m.kind === 'line' || m.kind === 'arrow');
  }

  /** Кадр: всё вне его притушено, у рамки — узелки. */
  private drawCrop(crop: Box | null): void {
    if (!crop || !this.shot) return;
    const ctx = this.ctx;
    const v = this.view;
    const a = toScreen(v, { x: 0, y: 0 });
    const full = { w: this.shot.width * v.zoom, h: this.shot.height * v.zoom };
    const c = toScreen(v, { x: crop.x, y: crop.y });
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.x, a.y, full.w, full.h);
    ctx.rect(c.x, c.y, crop.w * v.zoom, crop.h * v.zoom);
    ctx.fillStyle = 'rgba(20, 26, 32, 0.55)';
    ctx.fill('evenodd');
    ctx.restore();
    this.dashed(crop, '#1f2933');
    for (const h of cropHandles(crop)) this.handle(h.p);
  }

  // ---------- Файлы и отправка ----------

  private renderFiles(): void {
    const m = this.moment;
    const shot = this.shot;
    if (!m || !shot) return;
    const out = outputBox(this.tl.now, shot.width, shot.height);
    const row = (kind: AttachKind, icon: string, name: string, note: string) =>
      `<label class="bug-file"><input type="checkbox" data-bug-include="${kind}" ${this.include[kind] ? 'checked' : ''} />${icon}<span>${name}</span><small data-bug-file-note="${kind}">${note}</small></label>`;
    const enc = new TextEncoder();
    this.screen.querySelector('[data-bug-files]')!.innerHTML =
      row('shot', ICON.shot, 'Приложить снимок', `${Math.round(out.w)} × ${Math.round(out.h)}`) +
      row('journal', ICON.journal, 'Журнал партии', `${m.journalEntries} зап. · ${sizeLabel(enc.encode(m.journal).length)}`) +
      row('save', ICON.save, 'Сохранение', sizeLabel(enc.encode(m.save).length));
  }

  /** Итоговая картинка с пометками и кадром — PNG. */
  private async renderPng(): Promise<Blob> {
    const shot = this.shot!;
    const sk = this.tl.now;
    const size = outputSize(sk, shot.width, shot.height, shot.scale);
    const c = document.createElement('canvas');
    c.width = size.width;
    c.height = size.height;
    // Снимок уже в пикселях экрана (scale на точку): рисуем его в точках — renderSketch масштабирует сам.
    renderSketch(c.getContext('2d')!, shot.canvas, sk, shot.width, shot.height, shot.scale);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG не собрался'))), 'image/png'));
  }

  private async send(): Promise<void> {
    if (this.sending || !this.shot || !this.moment) return;
    this.commitEdit();
    this.selected = null;
    this.redraw();
    this.sending = true;
    this.syncControls();
    this.status('Готовлю файлы…');
    const m = this.moment;
    const names = attachmentNames(m.at);
    const files: Attachment[] = [];
    // Снимок не приложен — не загружается и в отчёт не попадает.
    if (this.include.shot) files.push({ kind: 'shot', name: names.shot, type: 'image/png', data: await this.renderPng() });
    if (this.include.journal) files.push({ kind: 'journal', name: names.journal, type: 'application/x-ndjson', data: new Blob([m.journal], { type: 'application/x-ndjson' }) });
    if (this.include.save) files.push({ kind: 'save', name: names.save, type: 'application/json', data: new Blob([m.save], { type: 'application/json' }) });
    // Сначала файлы — в публичный загрузчик (ссылки на них войдут в карточку); не принял — карточка всё равно
    // уйдёт, с пометкой, каких файлов в ней нет.
    let uploaded: Uploaded[] | null = null;
    let uploadError = '';
    if (files.length) {
      try {
        uploaded = await uploadAttachments(files, {
          fetch: window.fetch.bind(window),
          onProgress: (done, total) => this.status(`Загружаю файлы: ${done} из ${total}`),
        });
      } catch (e) {
        // Сеть или загрузчик не пускает файлы с этого сайта (fetch бросает TypeError) — без подробностей.
        uploadError = e instanceof UploadError ? e.message : 'загрузчик доски не принимает файлы с сайта игры';
        console.warn('Баг-репорт: файлы не загрузились', e);
      }
    } else uploaded = [];
    const info = this.info();
    const refs = files.map((f) => ({ kind: f.kind, name: f.name, url: uploaded?.find((u) => u.kind === f.kind)?.url }));
    // Затем карточка — публичная отправка доски, без токена.
    this.status('Отправляю отчёт на доску…');
    let receipt: Receipt | null = null;
    let error = '';
    try {
      receipt = await submitReport(boardReport(info, refs, this.reportKey), { fetch: window.fetch.bind(window) });
    } catch (e) {
      error = e instanceof UploadError ? e.message : 'нет связи с доской задач';
      console.warn('Баг-репорт: отчёт не отправился', e);
    }
    // Текст с файлами «приложенными» — для буфера и архива: пригодится, если что-то не дошло.
    const text = reportMarkdown(info, refs);
    const copied = receipt ? false : await copyText(text);
    this.sent = { text, receipt, error, uploaded, uploadError, copied };
    if (receipt) this.reportKey = newReportKey();
    this.sending = false;
    this.renderResult();
    this.syncControls();
  }

  private info(): ReportInfo {
    const g = this.deps.game();
    const sc = g.settings.scenario;
    const shot = this.shot!;
    return {
      description: this.desc.value,
      author: this.nameInput.value.trim() || undefined,
      at: this.moment!.at,
      build: BUILD,
      saveVersion: SAVE_VERSION,
      date: g.dateLabel,
      seed: g.seed,
      scenario: sc ? `сценарий ${sc.difficulty}${sc.challenge ? ', испытание' : ''}` : undefined,
      screen: { width: shot.width, height: shot.height, dpr: window.devicePixelRatio || 1 },
      page: `${location.origin}${location.pathname}`,
      userAgent: navigator.userAgent,
    };
  }

  private status(text: string): void {
    const el = this.screen.querySelector<HTMLElement>('[data-bug-result]')!;
    el.className = 'bug-result busy';
    el.innerHTML = `<span class="bug-spin"></span>${text}`;
  }

  private renderResult(): void {
    const el = this.screen.querySelector<HTMLElement>('[data-bug-result]')!;
    const s = this.sent;
    if (!s) {
      el.className = 'bug-result hidden';
      el.innerHTML = '';
      return;
    }
    if (s.receipt) {
      // Карточка на доске — экран благодарности поверх окна.
      el.className = 'bug-result hidden';
      el.innerHTML = '';
      this.showThanks(s);
      return;
    }
    const copied = s.copied ? 'Текст отчёта скопирован' : 'Текст отчёта — ниже';
    const board = boardUrl();
    const copy = `<button class="bug-secondary small" data-bug="copy">${ICON.copy}Скопировать</button>`;
    const open = board ? `<a class="bug-secondary small" href="${board}" target="_blank" rel="noopener" data-tip="Доска задач игры">${ICON.link}Доска</a>` : '';
    el.className = 'bug-result fail';
    el.innerHTML = `<p class="bug-res-head">${ICON.warn}Отчёт не отправился: ${reason(s.error)}.</p>
      <p>${copied}. Можно отправить ещё раз или скачать архив и передать его вместе с текстом.</p>
      <textarea class="bug-report-text" readonly>${escapeHtml(s.text)}</textarea>
      <div class="bug-res-actions"><button class="bug-secondary small" data-bug="archive">${ICON.download}Архив</button>${copy}${open}</div>`;
  }

  /**
   * После отправки — короткое «спасибо»: картинка, номер задачи на доске (ссылкой), что из файлов дошло
   * (галочками) и кнопка назад в игру. Файлы не загрузились — об этом строка и кнопка скачать архив.
   */
  private showThanks(s: Sent): void {
    const r = s.receipt!;
    const label: Record<AttachKind, string> = { shot: 'Снимок', journal: 'Журнал', save: 'Сохранение' };
    const icon: Record<AttachKind, string> = { shot: ICON.shot, journal: ICON.journal, save: ICON.save };
    const files = (s.uploaded ?? [])
      .map((u) => `<a class="bug-thanks-file" href="${escapeHtml(u.url)}" target="_blank" rel="noopener" data-tip="Открыть файл">${icon[u.kind]}${label[u.kind]}<i>${ICON.ok}</i></a>`)
      .join('');
    const name = r.number ? `Задача #${r.number}` : 'Задача';
    const card = r.url
      ? `<a class="bug-thanks-card" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" data-tip="Открыть задачу на доске">${name}${ICON.link}</a>`
      : `<b class="bug-thanks-card">${name}</b>`;
    const lost = s.uploaded
      ? ''
      : `<p class="bug-thanks-lost">${ICON.warn}Файлы отчёта к задаче не приложились: ${reason(s.uploadError)}.</p>
        <button class="bug-thanks-copy" data-bug="archive">${ICON.download}Скачать их архивом</button>`;
    this.thanks.innerHTML = `${thanksSvg()}
      <h2>Спасибо за отчёт!</h2>
      <p>${card} на доске — разберёмся, что пошло не так.</p>
      ${files ? `<div class="bug-thanks-files">${files}</div>` : ''}
      ${lost}
      <button class="bug-primary" data-bug="close">Вернуться в игру</button>`;
    this.thanks.classList.remove('hidden');
  }

  private async copyAgain(): Promise<void> {
    if (!this.sent) return;
    this.sent.copied = await copyText(this.sent.text);
    if (!this.sent.copied) this.screen.querySelector<HTMLTextAreaElement>('.bug-report-text')?.select();
    if (this.sent.copied) for (const b of this.screen.querySelectorAll<HTMLElement>('[data-bug="copy"]')) b.innerHTML = `${ICON.ok}Скопировано`;
  }

  /**
   * Всё одним архивом: снимок (если приложен), журнал, сохранение, report.md с именем и описанием и meta.json —
   * сборка игры, дата партии, seed, экран, браузер, время. Можно и до отправки, и вместо неё.
   */
  private async downloadArchive(): Promise<void> {
    if (this.archiving || !this.shot || !this.moment) return;
    this.commitEdit();
    this.archiving = true;
    const btn = this.screen.querySelector<HTMLElement>('.bug-icon-btn[data-bug="archive"]')!;
    btn.classList.add('busy');
    try {
      const m = this.moment;
      const shot = this.include.shot ? new Uint8Array(await (await this.renderPng()).arrayBuffer()) : undefined;
      const entries = archiveEntries({
        info: this.info(),
        shot,
        journal: this.include.journal ? m.journal : undefined,
        save: this.include.save ? m.save : undefined,
      });
      const data = await zip(entries, { at: m.at });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }));
      a.download = archiveName(m.at);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      console.error('Баг-репорт: архив не собрался', e);
    } finally {
      this.archiving = false;
      btn.classList.remove('busy');
    }
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Причина отказа внутри фразы: без точки в конце (её ставит фраза) и с маленькой буквы. */
function reason(message: string): string {
  const s = message.trim().replace(/[.!]+$/, '');
  return escapeHtml(s.charAt(0).toLowerCase() + s.slice(1));
}

/** Курсор над углом рамки: диагональ зависит от того, где противоположный угол. */
function cornerCursor(p: Pt, opposite: Pt): string {
  return (p.x - opposite.x) * (p.y - opposite.y) > 0 ? 'nwse-resize' : 'nesw-resize';
}
