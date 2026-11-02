import { dist } from '../core/vec';
import type { RingSize } from '../game/roads';
import { SAVE_VERSION, type Game, type Ledger, type Partner, type TurnKind } from '../game/game';
import { TEMPLATES } from '../game/interchange';
import type { SaveEntry } from '../game/persist';
import { listTemplates } from '../game/templates';
import {
  carsOf,
  FleetVehicle,
  Line,
  LINE_COLORS,
  LineFolder,
  MODELS,
  ModelId,
  modelsFor,
  StopRule,
  vehicleCapacity,
  vehicleLoad,
} from '../game/transport';
import { Controller, DRAW_MODES, Tool, TOOLS } from '../input/controller';
import { CARGO, CargoType, consumersOf, FREIGHT, producersOf } from '../world/cargo';
import { StationServes, TOWN_NEED, TownStyle } from '../world/entities';
import { footprintRadius } from '../world/spatial';
import { COST, ECONOMY, LIGHTS, MONTH_LENGTH, RAIL_STATION, STATION, STOP } from '../config';
import { isOneWay, KMH_PER_UNIT, LEVELS, RAIL_SPEC, ROAD_PRESETS, RoadSpec, SPEED_LIMITS, specCost, specKmh } from '../world/roadTypes';
import {
  DEFAULT_SETTINGS,
  INDUSTRY_DENSITY,
  IndustryDensity,
  MAP_SIZES,
  MapSize,
  MONEY_OPTIONS,
  WATER,
  WaterAmount,
  WorldSettings,
} from '../world/settings';
import { cargoIcon, townIcon } from './cargoIcons';
import {
  bulldozeAreaSvg,
  bulldozePointSvg,
  copySvg,
  crossingSvg,
  folderSvg,
  fragmentSvg,
  levelSvg,
  lineKindSvg,
  modelSvg,
  modeSvg,
  diamondSvg,
  templateSvg,
  platformsSvg,
  baysSvg,
  moveEndSvg,
  moveNodeSvg,
  bendSvg,
  handleSvg,
  railSvg,
  ringSvg,
  roadSvg,
  speedSign,
  ledgerIcon,
  stationSvg,
  tracksSvg,
  signalSvg,
  switchSvg,
  upgradeSvg,
  laneSvg,
} from './icons';
import { Minimap } from './minimap';

/** Управление партией: сохранение и новая игра. */
export interface HudSession {
  hasProgress(): boolean;
  /** Автосохранение текущей партии. */
  save(): void;
  newGame(settings: WorldSettings): void;
  /** Сохранение со своим именем, которому принадлежит текущая партия. */
  linked(): string | null;
  list(): Promise<SaveEntry[]>;
  /** Сохранить под именем; id — перезаписать это сохранение. */
  saveAs(name: string, id?: string): Promise<boolean>;
  load(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
}

/** Силуэт карты с пропорциями сторон. */
function mapSvg(w: number, h: number): string {
  const k = 26 / Math.max(w, h);
  return `<svg class="map-mini" viewBox="0 0 28 28" width="28" height="28"><rect x="${14 - (w * k) / 2}" y="${14 - (h * k) / 2}" width="${w * k}" height="${h * k}" rx="2" fill="#d6e2bd" stroke="#8aa070"/>
    <path d="M${14 - (w * k) / 2 + 3} ${14 + (h * k) / 4}c4-6 8 2 ${w * k - 6}-4" stroke="#8cc3e6" stroke-width="2" fill="none"/></svg>`;
}

const STYLE_NAMES: Record<TownStyle, string> = {
  radial: 'радиально-кольцевой',
  organic: 'старый город',
  linear: 'вдоль дороги',
};

const ICONS: Record<Tool, string> = {
  select: '<svg viewBox="0 0 24 24"><path d="M5 3l12 9-5 1 3 6-2 1-3-6-4 4z" /></svg>',
  road: '<svg viewBox="0 0 24 24"><path d="M4 21 C6 12 10 8 20 4" /><path d="M9 21 C11 14 14 11 21 9" /></svg>',
  rail: '<svg viewBox="0 0 24 24"><path d="M8 2L5 22M16 2l3 20" /><path d="M6 6h12M5.5 11h13M5 16h14M4.5 20.5h15" /></svg>',
  lights:
    '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="16" rx="3" /><circle cx="12" cy="6" r="1.4" /><circle cx="12" cy="10" r="1.4" /><circle cx="12" cy="14" r="1.4" /><path d="M12 18v4" /></svg>',
  roundabout:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></svg>',
  station: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="10" rx="2" /><path d="M3 12h18M7 18v3M17 18v3M8 8V5h8v3" /></svg>',
  line: '<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="13" r="2" /><path d="M7 16.5l3.5-2.5M13.5 11.5l3.8-4" /></svg>',
  bulldoze:
    '<svg viewBox="0 0 24 24"><path d="M3 17h11l3-5h-6l-2-4H5z" /><circle cx="6" cy="19" r="2" /><circle cx="13" cy="19" r="2" /><path d="M17 12l4 6" /></svg>',
};

const SPEEDS = [
  { value: 0, label: '❚❚', title: 'Пауза (Пробел)' },
  { value: 1, label: '▶', title: 'Обычная скорость' },
  { value: 2, label: '▶▶', title: 'Быстро' },
  { value: 4, label: '▶▶▶', title: 'Очень быстро' },
];

const PRESET_HINTS: Record<string, string> = {
  street: 'Обычная двусторонняя улица: по полосе в каждую сторону',
  avenue: 'Широкий проспект: по две полосы в каждую сторону, быстрее улицы',
  oneway: 'Односторонняя: для колец, съездов и развязок. Скорость — знаком',
  road: 'Шоссе: загородная дорога по полосе в каждую сторону, быстрая, нужны плавные повороты',
  hw2: 'Магистраль: по две быстрые полосы в каждую сторону, нужны плавные повороты',
  mw2: 'Автомагистраль: по две полосы в каждую сторону, посередине барьер. Без левых поворотов и перекрёстков — подключайте развязками. Больше полос — в редакторе полос',
};

const MODE_HINTS: Record<string, string> = {
  straight: 'Прямая от точки до точки. Сама прилипает к «прямо» и 90°; Alt — не прилипать, Shift — шаг угла 15°',
  arc: 'Дуга: плавно продолжает дорогу по касательной',
  curve: 'Кривая по трём кликам: начало, изгиб, конец',
};

const LEVEL_HINTS: Record<number, string> = {
  [-1]: 'Тоннель: проходит под дорогами, водой и зданиями. Между уровнями строится пандус',
  0: 'Земля: обычная дорога. Через реку автоматически получится мост',
  1: 'Мост: проходит над дорогами на земле',
  2: 'Эстакада: второй ярус, над мостами',
};

function lanesLabel(spec: RoadSpec): string {
  return isOneWay(spec) ? `${spec.lanesF}→` : `${spec.lanesF}+${spec.lanesB}`;
}

/** Условие отправления как одна из четырёх кнопок. */
type WaitId = 'auto' | 'full' | 'fullm' | 'none';

const WAIT_LABELS: Record<WaitId, string> = {
  auto: '⏳ Авто',
  full: '▣ Полная',
  fullm: '▣ Полная ≤ мес',
  none: '→ Не ждать',
};

const WAIT_HINTS: Record<WaitId, string> = {
  auto: 'Пустой грузовик немного подождёт груз у производителя',
  full: 'Ждать полной загрузки сколько угодно',
  fullm: 'Ждать полной загрузки, но не дольше месяца',
  none: 'Сразу в путь с тем, что успели погрузить',
};

const ruleWaitId = (r: StopRule): WaitId => (r.wait === 'full' ? (r.maxWait === null ? 'full' : 'fullm') : r.wait);

const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;

/** Столбики «доход / расход» по месяцам — для компании и для линии. */
function incomeChart(months: { label: string; income: number; expense: number }[], H = 90): string {
  if (!months.length) return '<p class="muted">График появится после первого месяца.</p>';
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
  const W = 300;
  const bw = W / Math.max(12, months.length);
  const bars = months
    .map((m, i) => {
      const x = i * bw;
      const hi = (m.income / max) * (H - 14);
      const he = (m.expense / max) * (H - 14);
      return `<rect x="${x + 2}" y="${H - 12 - hi}" width="${bw / 2 - 2}" height="${hi}" rx="1.5" fill="#3fae6a"><title>${m.label}: доход ${money(m.income)}</title></rect>
        <rect x="${x + bw / 2}" y="${H - 12 - he}" width="${bw / 2 - 2}" height="${he}" rx="1.5" fill="#e5534b"><title>${m.label}: расход ${money(m.expense)}</title></rect>
        <text x="${x + bw / 2}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#7b8794">${m.label.split(' ')[0]}</text>`;
    })
    .join('');
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars}</svg>`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Hud {
  private readonly q: <T extends HTMLElement>(sel: string) => T;
  private lastPanel = '';
  /** Кнопка мыши зажата над панелью: не перерисовываем, иначе клик потеряется. */
  private pressing = false;
  /** Скорость игры до открытия меню — к ней вернёмся по «Продолжить». */
  private speedBeforeMenu = 1;
  private lastConfirm = '';
  /** Список линий свёрнут до заголовка (запоминается в браузере). */
  private linesCollapsed = localStorage.getItem('roads.linesCollapsed') === '1';
  private readonly minimap: Minimap;
  private lastOptions = '';
  private panelTimer = 0;

  private confirmNew = false;
  /** Сохранения со своими именами (последний прочитанный список). */
  private saves: SaveEntry[] = [];
  /** Ждём второго нажатия: `load:id` — загрузить без сохранения текущей, `del:id` — удалить. */
  private confirmSave: string | null = null;
  /** Линия, у которой открыта палитра цвета. */
  private colorsOpen: number | null = null;
  /** Остановка, у которой раскрыты условия. */
  private stopOpen: { line: number; i: number } | null = null;
  /** Папка, у которой сейчас открыто поле названия. */
  private renamingFolder: number | null = null;
  /** Линия, которую тянут мышью на папку: пока тянем, панель не перерисовываем. */
  private dragLine: number | null = null;
  /** Черновик параметров нового мира. */
  private draft: WorldSettings = { ...DEFAULT_SETTINGS };

  constructor(
    private readonly root: HTMLElement,
    private readonly controller: Controller,
    private readonly game: () => Game,
    private readonly session: HudSession,
  ) {
    root.innerHTML = `
      <div class="panel stats" data-action="finance" title="Финансы: доходы и расходы по статьям">
        <div class="stat"><span class="label">Деньги</span><span class="value" data-money></span></div>
        <div class="stat"><span class="label">За месяц</span><span class="value small" data-balance></span></div>
        <div class="stat"><span class="label">Парк</span><span class="value small" data-fleet></span></div>
        <div class="stat day"><span class="label" data-date></span><div class="bar"><div data-month></div></div></div>
      </div>
      <div class="panel speed" data-speed></div>
      <div class="notices" data-notices></div>
      <div class="panel options hidden" data-options></div>
      <div class="panel toolbar" data-tools></div>
      <div class="panel side" data-side></div>
      <div class="panel chains hidden" data-chains></div>
      <div class="panel finance hidden" data-finance></div>
      <div class="panel minimap-wrap" data-minimap></div>
      <div class="screen hidden" data-start>
        <div class="modal">
          <h1>Развязка</h1>
          <p class="sub">Транспортная компания: дороги, грузы, пассажиры и пробки.</p>
          <ul>
            <li>Ставьте <b>станции</b> у дорог в городах или вплотную к <b>предприятию</b> — с любой его стороны.</li>
            <li>Соедините станции <b>маршрутом</b> и купите на него грузовики или автобусы.</li>
            <li>Для дальних перевозок проложите <b>ж/д путь</b>, поставьте <b>ж/д станции</b> и пустите поезда.</li>
            <li>Сырьё везите на заводы, готовую продукцию — в города. Что кому нужно, видно по значкам и в панели <b>«Цепочки»</b>.</li>
            <li>Выберите предприятие или город — пунктиром покажутся ближайшие партнёры.</li>
            <li>Обеспеченные города растут, а жители ездят по вашим дорогам и создают пробки.</li>
          </ul>
          <div class="actions"><button class="primary" data-action="begin">Начать</button></div>
          <p class="muted save-note">Прогресс сохраняется сам: каждый игровой месяц и при закрытии вкладки.</p>
        </div>
      </div>
      <div class="screen hidden" data-menu>
        <div class="modal menu">
          <button class="icon modal-close" data-action="resume" title="Закрыть (Esc)">✕</button>
          <h2>Меню</h2>
          <p class="muted" data-menu-info></p>
          <div class="menu-buttons">
            <button class="secondary" data-action="save-game">Сохранить</button>
            <button class="secondary" data-action="new-game">Новая игра…</button>
            <button class="primary" data-action="resume">Продолжить</button>
          </div>
          <div class="saves" data-saves></div>
        </div>
      </div>
      <div class="screen hidden" data-newgame><div class="modal newgame" data-newgame-body></div></div>
      <div class="screen hidden" data-confirm></div>
    `;
    this.q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

    const tools = this.q('[data-tools]');
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.action = 'tool';
      b.dataset.id = t.id;
      b.innerHTML = `${ICONS[t.id]}<span class="name">${t.name}</span><kbd>${t.alt ?? t.key}</kbd>`;
      b.title = t.alt ? `${t.name} (${t.alt} или ${t.key})` : `${t.name} (${t.key})`;
      tools.appendChild(b);
    }
    const speed = this.q('[data-speed]');
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.title = s.title;
      b.dataset.action = 'speed';
      b.dataset.v = String(s.value);
      speed.appendChild(b);
    }
    const chains = document.createElement('button');
    chains.textContent = 'Цепочки';
    chains.title = 'Что производят предприятия и что нужно городам (C)';
    chains.dataset.action = 'chains';
    speed.appendChild(chains);
    const heat = document.createElement('button');
    heat.textContent = 'Пробки';
    heat.title = 'Карта загрузки дорог (H)';
    heat.dataset.action = 'heatmap';
    speed.appendChild(heat);
    const menu = document.createElement('button');
    menu.textContent = 'Меню';
    menu.title = 'Сохранение и новая игра';
    menu.dataset.action = 'menu';
    speed.appendChild(menu);
    // Правая панель — ровно по ширине верхней панели кнопок.
    const side = this.q('[data-side]');
    new ResizeObserver(() => (side.style.width = `${speed.offsetWidth}px`)).observe(speed);

    this.minimap = new Minimap(this.q('[data-minimap]'), game, controller.camera);
    root.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.ngSeed === undefined) return;
      const v = Math.abs(Math.floor(Number(input.value.replace(/\D/g, '')))) || 1;
      this.draft = { ...this.draft, seed: v };
      this.renderNewGame();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyC' && !(e.target instanceof HTMLInputElement)) this.toggleChains();
    });
    // Esc закрывает меню (а из «Новой игры» возвращает в меню) — раньше, чем его увидит карта.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape') return;
        if (!this.closeModal()) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      { capture: true },
    );
    // Клик мимо окна — то же, что Esc.
    for (const s of ['menu', 'newgame']) {
      this.q(`[data-${s}]`).addEventListener('click', (e) => {
        if (e.target === e.currentTarget) this.closeModal();
      });
    }
    this.q('[data-confirm]').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.controller.cancelArea();
    });
    root.addEventListener('click', (e) => this.onClick(e));
    // Карточка транспорта меняется каждый кадр (скорость): держим её, пока кнопка мыши зажата.
    this.q('[data-side]').addEventListener('pointerdown', () => (this.pressing = true));
    window.addEventListener('pointerup', () => setTimeout(() => (this.pressing = false)));
    // Переименование линии: сохраняем по Enter или при уходе фокуса.
    root.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.lineColor) {
        this.game().setLineColor(Number(input.dataset.lineColor), input.value);
        input.blur();
        this.sync(true);
        return;
      }
      if (!input.dataset.lineName) return;
      this.game().renameLine(Number(input.dataset.lineName), input.value);
      input.blur();
      this.sync(true);
    });
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset?.lineName && e.key === 'Enter') input.blur();
      if (input.dataset?.lineName && e.key === 'Escape') {
        input.value = this.game().lines.get(Number(input.dataset.lineName))?.name ?? input.value;
        input.blur();
      }
      // Enter в поле имени сохранения — сохранить как новое.
      if (input.dataset?.saveName !== undefined && e.key === 'Enter') void this.session.saveAs(this.saveName()).then(() => this.renderSaves(true));
      if (input.dataset?.templateName !== undefined && e.key === 'Enter') this.saveUserTemplate();
    });
    this.bindFolders(root, this.q('[data-side]'));
    controller.onChange = () => this.sync(true);
    this.sync(true);
  }

  /**
   * Папки линий: переименование в поле (Enter или уход фокуса — сохранить, Esc — отменить),
   * двойной клик по названию и перетаскивание строки линии: на папку, в корень списка
   * или между строками — так меняется порядок линий.
   */
  private bindFolders(root: HTMLElement, side: HTMLElement): void {
    root.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.folderName) return;
      if (e.key === 'Escape') input.value = this.game().folders.get(Number(input.dataset.folderName))?.name ?? input.value;
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    });
    root.addEventListener('focusout', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.dataset?.folderName) return;
      this.game().renameFolder(Number(input.dataset.folderName), input.value);
      this.renamingFolder = null;
      // Пока идёт focusout, поле ещё считается активным — перерисуем панель следом.
      setTimeout(() => this.sync(true));
    });
    side.addEventListener('dblclick', (e) => {
      const title = (e.target as HTMLElement).closest<HTMLElement>('[data-folder-title]');
      if (!title) return;
      this.renamingFolder = Number(title.dataset.folderTitle);
      this.sync(true);
    });
    const marks = ['drop-over', 'drop-before', 'drop-after', 'dragged'];
    const clearOver = (keep = false) =>
      side.querySelectorAll(marks.map((m) => `.${m}`).join(',')).forEach((el) => el.classList.remove(...marks.slice(0, keep ? 3 : 4)));
    /**
     * Куда упадёт линия: над строкой — вставка до или после неё (по половине строки),
     * над заголовком папки или пустым местом — в конец папки или корня списка.
     */
    const targetOf = (e: DragEvent) => {
      const el = e.target as HTMLElement;
      const zone = el.closest<HTMLElement>('[data-folder-drop]');
      if (this.dragLine === null || !zone) return null;
      const folder = zone.dataset.folderDrop === 'root' ? null : Number(zone.dataset.folderDrop);
      const row = el.closest<HTMLElement>('[data-drag-line]');
      if (!row) return { folder, before: null, mark: zone, cls: 'drop-over' };
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      // «После строки» — это перед следующей строкой той же папки, а за последней — в конец.
      const next = (row.nextElementSibling as HTMLElement | null)?.dataset?.dragLine;
      const before = after ? (next ? Number(next) : null) : Number(row.dataset.dragLine);
      return { folder, before, mark: row, cls: after ? 'drop-after' : 'drop-before' };
    };
    side.addEventListener('dragstart', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-line]');
      if (!row || !e.dataTransfer) return;
      this.dragLine = Number(row.dataset.dragLine);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.dragLine!);
      side.classList.add('dragging-line');
      row.classList.add('dragged');
    });
    side.addEventListener('dragover', (e) => {
      const t = targetOf(e);
      if (!t) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (!t.mark.classList.contains(t.cls)) {
        clearOver(true);
        t.mark.classList.add(t.cls);
      }
    });
    side.addEventListener('dragleave', (e) => {
      if (!side.contains(e.relatedTarget as Node | null)) clearOver(true);
    });
    side.addEventListener('drop', (e) => {
      const t = targetOf(e);
      if (!t) return;
      e.preventDefault();
      this.game().moveLine(this.dragLine!, t.folder, t.before);
    });
    // После перетаскивания pointerup не приходит — снимаем «зажатую кнопку» сами.
    side.addEventListener('dragend', () => {
      this.dragLine = null;
      this.pressing = false;
      side.classList.remove('dragging-line');
      clearOver();
      this.sync(true);
    });
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    const c = this.controller;
    const g = this.game();
    const d = el.dataset;
    if (d.action !== 'ng-create') this.confirmNew = false;
    switch (d.action) {
      case 'begin':
        this.hideScreens();
        c.setSpeed(1);
        break;
      case 'menu':
        this.speedBeforeMenu = g.speed || 1;
        c.setSpeed(0);
        this.showMenu();
        break;
      case 'resume':
        this.hideScreens();
        c.setSpeed(this.speedBeforeMenu);
        break;
      case 'save-game': {
        // Партия из сохранения — перезаписываем его; иначе — новое сохранение с именем из поля.
        const id = this.session.linked();
        const entry = id ? this.saves.find((s) => s.id === id) : undefined;
        void this.session.saveAs(entry?.name ?? this.saveName(), entry?.id).then(() => this.renderSaves());
        break;
      }
      case 'save-new':
        void this.session.saveAs(this.saveName()).then(() => this.renderSaves());
        break;
      case 'save-load': {
        const id = d.id!;
        const linked = this.session.linked();
        // Текущая партия не в списке — загрузка её потеряет: просим нажать ещё раз.
        if (!linked && this.session.hasProgress() && this.confirmSave !== `load:${id}`) {
          this.confirmSave = `load:${id}`;
          void this.renderSaves();
          break;
        }
        this.confirmSave = null;
        const current = linked ? this.saves.find((s) => s.id === linked) : undefined;
        const before = current ? this.session.saveAs(current.name, current.id) : Promise.resolve(true);
        void before
          .then(() => this.session.load(id))
          .then((ok) => {
            if (!ok) return;
            this.hideScreens();
            c.setSpeed(this.speedBeforeMenu);
          });
        break;
      }
      case 'save-del':
        if (this.confirmSave !== `del:${d.id}`) {
          this.confirmSave = `del:${d.id}`;
          void this.renderSaves();
          break;
        }
        this.confirmSave = null;
        void this.session.remove(d.id!).then(() => this.renderSaves());
        break;
      case 'new-game':
        this.draft = { ...g.settings, seed: Math.floor(Math.random() * 1e9) };
        this.showScreen('newgame');
        this.renderNewGame();
        break;
      case 'ng-cancel':
        this.showMenu();
        break;
      case 'ng-set':
        this.draft = { ...this.draft, [d.key!]: d.key === 'money' ? Number(d.v) : d.v };
        this.renderNewGame();
        break;
      case 'ng-towns':
        this.draft = { ...this.draft, towns: Math.max(4, Math.min(20, this.draft.towns + Number(d.d))) };
        this.renderNewGame();
        break;
      case 'ng-seed':
        this.draft = { ...this.draft, seed: Math.floor(Math.random() * 1e9) };
        this.renderNewGame();
        break;
      case 'ng-create':
        // Есть прогресс — просим подтвердить вторым нажатием.
        if (this.session.hasProgress() && !this.confirmNew) {
          this.confirmNew = true;
          this.renderNewGame();
          break;
        }
        this.confirmNew = false;
        this.session.newGame(this.draft);
        this.showWelcome();
        break;
      case 'tool':
        c.setTool(d.id as Tool);
        break;
      case 'speed':
        c.setSpeed(Number(d.v));
        break;
      case 'heatmap':
        c.toggleHeatmap();
        break;
      case 'chains':
        this.toggleChains();
        break;
      case 'finance':
        this.toggleFinance();
        break;
      case 'loan-take':
        g.takeLoan();
        this.lastFinance = '';
        break;
      case 'loan-repay':
        g.repayLoan();
        this.lastFinance = '';
        break;
      case 'town-streets': {
        const t = g.towns.find((x) => x.id === Number(d.id));
        if (t) t.autoStreets = t.autoStreets === false;
        this.sync(true);
        break;
      }
      case 'chain-kind': {
        // Подсвечиваем все предприятия типа и показываем ближайшее к центру экрана.
        const list = g.industries.filter((i) => i.info.kind === d.kind);
        c.highlight = list.map((i) => i.id);
        const center = { x: c.camera.x, y: c.camera.y };
        const nearest = list.sort((a, b) => dist(a.fp.center, center) - dist(b.fp.center, center))[0];
        if (nearest) c.focus(nearest.fp.center, 0.35);
        break;
      }
      case 'focus': {
        const id = Number(d.id);
        if (d.type === 'town') {
          const t = g.towns.find((x) => x.id === id);
          if (t) c.focus(t.center, 0.35);
          c.select({ type: 'town', id });
        } else {
          const ind = g.industries.find((x) => x.id === id);
          if (ind) c.focus(ind.fp.center, 0.35);
          c.select({ type: 'industry', id });
        }
        c.selectLine(null);
        break;
      }
      case 'toggle-lines':
        this.linesCollapsed = !this.linesCollapsed;
        localStorage.setItem('roads.linesCollapsed', this.linesCollapsed ? '1' : '0');
        break;
      case 'bulldoze-mode':
        c.setBulldozeMode(d.id === 'area' ? 'area' : 'point');
        break;
      case 'area-confirm':
        c.confirmArea();
        break;
      case 'area-cancel':
        c.cancelArea();
        break;
      case 'template-kind':
        c.setTemplate(d.id === 'tee' || d.id === 'clover' ? d.id : 'diamond');
        break;
      case 'show-station': {
        const st = g.stations.get(Number(d.id));
        if (st) c.showPlace(st.fp.center, footprintRadius(st.fp));
        break;
      }
      case 'preset':
        c.setPreset(d.id!);
        break;
      case 'road-mode':
        c.setRoadMode(d.id === 'upgrade' || d.id === 'move' || d.id === 'lane' ? d.id : 'build');
        break;
      case 'junction-mode':
        c.setJunctionMode(d.id === 'template' || d.id === 'copy' ? d.id : 'ring');
        break;
      case 'user-template':
        c.setUserTemplate(d.id ?? null);
        break;
      case 'user-template-del': {
        const t = listTemplates().find((x) => x.id === d.id);
        if (t && confirm(`Удалить шаблон «${t.name}»?`)) c.removeUserTemplate(t.id);
        break;
      }
      case 'paste-rotate':
        c.rotatePaste(Number(d.v));
        break;
      case 'clipboard-clear':
        c.clearClipboard();
        break;
      case 'template-save':
        this.saveUserTemplate();
        break;
      case 'rail-mode':
        c.setRailMode(d.id === 'station' || d.id === 'signal' || d.id === 'parallel' ? d.id : 'track');
        break;
      case 'rail-tracks':
        c.setRailTracks(Number(d.v));
        break;
      case 'limit':
        c.setLimit(Number(d.v));
        break;
      case 'ring-lanes':
        c.setRingLanes(Number(d.v));
        break;
      case 'ring-size':
        c.setRingSize(d.id as RingSize);
        break;
      case 'lanes':
        c.setLanes(c.spec.lanesF + Number(d.f ?? 0), c.spec.lanesB + Number(d.b ?? 0));
        break;
      case 'mode':
        c.setMode(d.id as typeof c.drawMode);
        break;
      case 'level':
        c.setLevel(Number(d.v));
        break;
      case 'new-line':
        c.setTool('line');
        break;
      case 'finish-line':
        c.finishLine();
        break;
      case 'cancel-line':
        c.cancelLine();
        c.setTool('select');
        break;
      case 'select-line':
        c.selectLine(Number(d.id));
        c.select(null);
        break;
      case 'close-line':
        c.selectLine(null);
        break;
      case 'st-tracks':
        c.setStationTracks(Number(d.v));
        break;
      case 'new-serves':
        c.toggleStationServe(d.what === 'pax' ? 'pax' : 'cargo');
        break;
      case 'station-mode':
        c.setStationMode(d.id === 'stop' ? 'stop' : 'road');
        break;
      case 'st-serves': {
        const st = g.stations.get(Number(d.id));
        if (st) g.setStationServes(st.id, { ...st.serves, [d.what === 'pax' ? 'pax' : 'cargo']: !st.serves[d.what === 'pax' ? 'pax' : 'cargo'] });
        break;
      }
      case 'st-bays': {
        const st = g.stations.get(Number(d.id));
        const problem = st && g.setStationBays(st.id, st.bays + Number(d.d));
        if (problem) g.notify(problem);
        break;
      }
      case 'toggle-colors':
        this.colorsOpen = this.colorsOpen === Number(d.id) ? null : Number(d.id);
        break;
      case 'line-color':
        g.setLineColor(Number(d.id), d.color!);
        this.colorsOpen = null;
        break;
      case 'delete-line':
        g.deleteLine(Number(d.id));
        c.selectLine(null);
        break;
      case 'new-folder':
        // Новая папка сразу открывается для ввода названия.
        this.renamingFolder = g.createFolder().id;
        break;
      case 'toggle-folder':
        g.toggleFolder(Number(d.id));
        break;
      case 'rename-folder':
        this.renamingFolder = Number(d.id);
        break;
      case 'delete-folder':
        g.deleteFolder(Number(d.id));
        if (this.renamingFolder === Number(d.id)) this.renamingFolder = null;
        break;
      case 'line-folder': {
        // В другую папку линия встаёт последней; повторный клик по своей папке порядок не меняет.
        const to = d.folder ? Number(d.folder) : null;
        if ((g.lines.get(Number(d.line))?.folder ?? null) !== to) g.moveLine(Number(d.line), to);
        break;
      }
      case 'line-folder-new': {
        const folder = g.createFolder();
        g.setLineFolder(Number(d.line), folder.id);
        this.renamingFolder = folder.id;
        break;
      }
      case 'buy': {
        const v = g.buyVehicle(Number(d.line), d.model as ModelId);
        if (!v) g.notify('Не хватает денег');
        break;
      }
      case 'sell':
        g.sellVehicle(Number(d.id));
        break;
      case 'replace':
        if (!g.replaceVehicle(Number(d.id))) g.notify('Не хватает денег на замену');
        break;
      case 'cars': {
        const v = g.fleet.get(Number(d.id));
        if (v && !g.setTrainCars(v.id, carsOf(v) + Number(d.d))) g.notify(Number(d.d) > 0 ? 'Длиннее состав не поместится на платформы маршрута' : 'Меньше двух вагонов нельзя');
        break;
      }
      case 'close-sel':
        c.select(null);
        break;
      case 'demolish': {
        const b = g.buildingById(Number(d.id));
        g.checkpoint('снос здания');
        if (b && g.demolishBuilding(b)) c.select(null);
        g.commit();
        break;
      }
      case 'move': {
        const b = g.buildingById(Number(d.id));
        if (b) c.startMove(b);
        break;
      }
      case 'show-fleet':
        // Выбираем машину или поезд компании и переносим к нему камеру.
        c.select({ type: 'fleet', id: Number(d.id) });
        c.focusSelection();
        break;
      case 'toggle-follow':
        c.toggleFollow();
        break;
      case 'jn-lanes-edit':
        // Настраивать полосы на карте можно инструментом «Перекрёсток» — выбор перекрёстка остаётся.
        c.setTool('lights');
        break;
      case 'jn-lights':
      case 'jn-green':
      case 'jn-adaptive':
      case 'jn-main':
      case 'jn-lanes-reset':
      case 'jn-ban': {
        // Настройки перекрёстка — тоже стройка: их можно отменить Ctrl+Z.
        const id = Number(d.id);
        const n = g.roads.net.nodes.get(id);
        if (!n) break;
        g.checkpoint('настройка перекрёстка');
        if (d.action === 'jn-lights') g.toggleLights(id);
        else if (d.action === 'jn-lanes-reset') g.resetLanes(id);
        else if (d.action === 'jn-adaptive') g.setJunction(id, { adaptive: d.v === '1' });
        else if (d.action === 'jn-green') {
          const count = g.junctionInfo(id)?.phases.length ?? 0;
          const greens = Array.from({ length: count }, (_, i) => n.greens?.[i] ?? LIGHTS.green);
          const i = Number(d.i);
          greens[i] = Math.max(4, Math.min(40, greens[i] + Number(d.d)));
          g.setJunction(id, { greens });
        } else if (d.action === 'jn-main') {
          g.setJunction(id, { mainPair: d.v === 'auto' ? null : d.v === 'none' ? [] : d.v!.split(',').map(Number) });
        } else {
          const key = `${d.from}>${d.out}`;
          const bans = n.bans ?? [];
          g.setJunction(id, { bans: bans.includes(key) ? bans.filter((b) => b !== key) : [...bans, key] });
        }
        g.commit();
        break;
      }
      case 'stop-open': {
        const key = { line: Number(d.line), i: Number(d.i) };
        const same = this.stopOpen?.line === key.line && this.stopOpen.i === key.i;
        this.stopOpen = same ? null : key;
        break;
      }
      case 'stop-up':
      case 'stop-down': {
        const i = Number(d.i);
        const problem = g.moveLineStop(Number(d.line), i, d.action === 'stop-up' ? -1 : 1);
        if (problem) g.notify(problem);
        this.stopOpen = null;
        break;
      }
      case 'stop-del': {
        const problem = g.removeLineStop(Number(d.line), Number(d.i));
        if (problem) g.notify(problem);
        this.stopOpen = null;
        break;
      }
      case 'stop-add':
        c.startAddStop(Number(d.line));
        break;
      case 'stop-add-done':
        c.stopAddStop();
        break;
      case 'rule-wait':
      case 'rule-load':
      case 'rule-unload': {
        const line = g.lines.get(Number(d.line));
        if (!line) break;
        const i = Number(d.i);
        const rule: StopRule = { ...g.stopRule(line, i) };
        if (d.action === 'rule-wait') {
          const w = d.v as WaitId;
          rule.wait = w === 'fullm' ? 'full' : w;
          rule.maxWait = w === 'fullm' ? MONTH_LENGTH : null;
        } else if (d.action === 'rule-load') {
          if (d.c === 'auto') rule.load = 'auto';
          else {
            const list = rule.load === 'auto' ? [] : [...rule.load];
            const c = d.c as CargoType;
            rule.load = list.includes(c) ? list.filter((x) => x !== c) : [...list, c];
          }
        } else if (d.c === 'auto' || d.c === 'all') {
          rule.unload = d.c;
        } else {
          const list = Array.isArray(rule.unload) ? [...rule.unload] : [];
          const c = d.c as CargoType;
          const next = list.includes(c) ? list.filter((x) => x !== c) : [...list, c];
          rule.unload = next.length ? next : 'auto';
        }
        g.setStopRule(line.id, i, rule);
        break;
      }
    }
    this.sync(true);
  }

  private sync(force = false): void {
    const c = this.controller;
    const g = this.game();
    this.root.querySelectorAll<HTMLElement>('[data-action="tool"]').forEach((b) => b.classList.toggle('active', b.dataset.id === c.tool));
    this.root.querySelectorAll<HTMLElement>('[data-action="speed"]').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === g.speed));
    this.q('[data-action="heatmap"]').classList.toggle('active', c.heatmap);
    this.q('[data-action="chains"]').classList.toggle('active', !this.q('[data-chains]').classList.contains('hidden'));
    this.renderOptions();
    this.renderConfirm();
    if (force) this.renderSide();
  }

  /** Переключатель режима — большие карточки с картинками. */
  /** grid — компактно: кнопки в две колонки, значок слева от названия. */
  /** key — горячая клавиша режима, видна на карточке. */
  private kindSwitch(title: string, action: string, current: string, items: { id: string; name: string; svg: string; hint: string; key?: string }[], grid = false): string {
    return `<div class="opt-group"><div class="opt-title">${title}</div><div class="cards ${grid ? 'grid2' : ''}">${items
      .map(
        (it) => `<button class="card ${grid ? 'row' : ''} ${current === it.id ? 'active' : ''}" data-action="${action}" data-id="${it.id}" title="${it.key ? `${it.hint} (${it.key})` : it.hint}">
          ${it.svg}<span class="name">${it.name}</span>${it.key ? `<kbd>${it.key}</kbd>` : ''}</button>`,
      )
      .join('')}</div></div>`;
  }

  private renderOptions(): void {
    const c = this.controller;
    const el = this.q('[data-options]');
    const show = c.tool === 'road' || c.tool === 'rail' || c.tool === 'station' || c.tool === 'roundabout' || c.tool === 'bulldoze';
    el.classList.toggle('hidden', !show);
    if (!show) return;
    const html =
      c.tool === 'station'
        ? this.stationOptionsHtml()
        : c.tool === 'rail'
          ? this.railOptionsHtml()
          : c.tool === 'roundabout'
            ? this.junctionOptionsHtml()
            : c.tool === 'bulldoze'
              ? this.bulldozeOptionsHtml()
              : this.roadOptionsHtml();
    if (html !== this.lastOptions) {
      el.innerHTML = html;
      this.lastOptions = html;
    }
  }

  /** Снос: по одному объекту (можно вести мышью) или рамкой. */
  private bulldozeOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Как сносим', 'bulldoze-mode', c.bulldozeMode, [
      { id: 'point', name: 'По одному', svg: bulldozePointSvg(), hint: 'Клик по дороге, дому или станции; можно вести мышью' },
      { id: 'area', name: 'Рамкой', svg: bulldozeAreaSvg(), hint: 'Растяните рамку — снесётся всё внутри' },
    ]);
    const tip =
      c.bulldozeMode === 'area'
        ? 'Зажмите и растяните рамку: красным подсветится всё, что снесётся. Если объектов много или есть станция — спросим. Ратуша и станции с маршрутами не сносятся. Ctrl+Z — вернуть.'
        : 'Клик — снести дорогу, дом или станцию. Зажмите и ведите — сносится всё под курсором. Ctrl+Z — вернуть.';
    return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как сносить</div><p class="muted">${tip}</p></div></div>`;
  }

  /** Окно «точно снести?» для большой рамки. */
  private renderConfirm(): void {
    const el = this.q('[data-confirm]');
    const p = this.controller.pendingArea;
    el.classList.toggle('hidden', !p);
    if (!p) {
      this.lastConfirm = '';
      return;
    }
    const c = p.contents;
    const chip = (icon: string, n: number, title: string) =>
      n ? `<span class="confirm-chip" title="${title}">${icon}<b>${n}</b></span>` : '';
    const html = `<div class="modal menu confirm">
        <button class="icon modal-close" data-action="area-cancel" title="Отмена (Esc)">✕</button>
        <h2>Снести всё в рамке?</h2>
        <div class="confirm-chips">
          ${chip(roadSvg({ cls: 'street', lanesF: 1, lanesB: 1 }, 40, 18), c.segs.length, 'Участки дорог и путей')}
          ${chip('🏠', c.buildings.length, 'Дома')}
          ${chip(stationSvg('road', 24), c.stations.length, 'Станции')}
        </div>
        <p class="muted">Вернём за дороги ${money(c.refund)}${c.cost ? `, снос домов стоит ${money(c.cost)}` : ''}. Отменить можно Ctrl+Z.</p>
        <div class="menu-buttons">
          <button class="secondary" data-action="area-cancel">Отмена</button>
          <button class="primary danger-fill" data-action="area-confirm">Снести</button>
        </div>
      </div>`;
    if (html !== this.lastConfirm) {
      el.innerHTML = html;
      this.lastConfirm = html;
    }
  }

  /** Форма и высота — общие для дорог и путей. */
  private shapeHtml(): string {
    const c = this.controller;
    return `<div class="opt-group"><div class="opt-title">Форма <kbd>Q</kbd></div><div class="icons">${DRAW_MODES.map(
      (m) => `<button class="icon-btn ${c.drawMode === m.id ? 'active' : ''}" data-action="mode" data-id="${m.id}" title="${MODE_HINTS[m.id]}">
        ${modeSvg(m.id)}<span>${m.name}</span></button>`,
    ).join('')}</div></div>
    <div class="opt-group"><div class="opt-title">Высота <kbd>[</kbd><kbd>]</kbd></div><div class="icons">${LEVELS.map(
      (l) => `<button class="icon-btn ${c.level === l.level ? 'active' : ''}" data-action="level" data-v="${l.level}" title="${LEVEL_HINTS[l.level]}">
        ${levelSvg(l.level)}<span>${l.name}</span></button>`,
    ).join('')}</div></div>`;
  }

  /** Развязки: кольцо на перекрёстке, готовый или свой шаблон, копия куска дорог. */
  private junctionOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Что ставим', 'junction-mode', c.junctionMode, [
      { id: 'ring', name: 'Кольцо', svg: ringSvg(0.5, 1), hint: 'Кольцо на месте перекрёстка' },
      { id: 'template', name: 'Шаблон', svg: diamondSvg(48, 36), hint: 'Готовая или своя развязка в один клик' },
      { id: 'copy', name: 'Копия', svg: copySvg(48, 36), hint: 'Скопировать дороги рамкой и вставить с поворотом' },
    ]);
    if (c.junctionMode === 'template') {
      const own = !!c.userTemplate;
      const cards = TEMPLATES.map(
        (t) => `<button class="card ${!own && c.templateKind === t.id ? 'active' : ''}" data-action="template-kind" data-id="${t.id}" title="${t.hint}">
          ${templateSvg(t.id, 64, 48)}<span class="name">${t.name}</span><small>${t.short}</small></button>`,
      ).join('');
      const mine = listTemplates()
        .map(
          (t) => `<div class="card user-tpl ${c.userTemplate === t.id ? 'active' : ''}" data-action="user-template" data-id="${t.id}" title="Свой шаблон «${esc(t.name)}»">
            ${fragmentSvg(t.fragment, 64, 48)}<span class="name">${esc(t.name)}</span>
            <button class="icon tpl-del" data-action="user-template-del" data-id="${t.id}" title="Удалить шаблон">✕</button></div>`,
        )
        .join('');
      const ownGroup = mine
        ? `<div class="opt-group"><div class="opt-title">Свои</div><div class="cards">${mine}</div></div>`
        : `<div class="opt-group narrow"><div class="opt-title">Свои</div><p class="muted">Скопируйте удачную развязку (режим «Копия») и сохраните её шаблоном — она появится здесь.</p></div>`;
      const tip = own
        ? 'Клик — поставить, протяжка или R — повернуть. На дороге того же класса ложится вдоль неё (Alt — нет), дороги под рамкой заменяются.'
        : 'Наведите на прямой участок магистрали — или в чистое поле: тогда магистраль построится вместе с развязкой (R — повернуть). Для магистрали берётся выбранный тип дороги, если это магистраль. Концы дорог подключите к своей сети. Не понравилось — Ctrl+Z.';
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Шаблон</div><div class="cards">${cards}</div></div>${ownGroup}
        <div class="opt-group narrow"><div class="opt-title">Как ставить <kbd>R</kbd></div><p class="muted">${tip}</p></div></div>`;
    }
    if (c.junctionMode === 'copy') return this.copyOptionsHtml(sw);
    return this.ringOptionsHtml(sw);
  }

  /** Копия: рамкой — что скопировать; скопированное — схемой, поворотом и кнопкой «в шаблоны». */
  private copyOptionsHtml(sw: string): string {
    const frag = this.controller.clipboard;
    if (!frag) {
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как копировать</div>
        <p class="muted">Зажмите и растяните рамку: синим подсветится, что попадёт в копию. Дороги режутся по рамке, кольца берутся целиком, настройки перекрёстков — вместе с ними.</p></div></div>`;
    }
    return `<div class="opt-row">${sw}
      <div class="opt-group"><div class="opt-title">Скопировано</div><div class="cards"><div class="card active">${fragmentSvg(frag, 64, 48)}<span class="name">${frag.corridors.length} уч.</span></div></div></div>
      <div class="opt-group"><div class="opt-title">Поворот <kbd>R</kbd></div><div class="icons">
        <button class="icon-btn" data-action="paste-rotate" data-v="-1" title="На 15° против часовой (Shift+R)">↺<span>−15°</span></button>
        <button class="icon-btn" data-action="paste-rotate" data-v="1" title="На 15° по часовой (R)">↻<span>+15°</span></button>
        <button class="icon-btn" data-action="clipboard-clear" title="Скопировать другое (Esc)">${copySvg(30, 22)}<span>Новая рамка</span></button>
      </div></div>
      <div class="opt-group"><div class="opt-title">В свои шаблоны</div><div class="save-new"><input class="line-name" data-template-name maxlength="30" placeholder="Моя развязка" />
        <button class="small" data-action="template-save">Сохранить</button></div></div>
      <div class="opt-group narrow"><div class="opt-title">Как вставлять</div><p class="muted">Клик — вставить (хоть много раз), протяжка — повернуть на любой угол. На дороге того же класса ложится вдоль неё (Alt — нет), дороги под рамкой заменяются.</p></div></div>`;
  }

  /** Скопированное — в свои шаблоны под именем из поля. */
  private saveUserTemplate(): void {
    const input = this.q<HTMLInputElement>('[data-template-name]');
    const name = input?.value.trim() || 'Моя развязка';
    if (!this.controller.saveClipboard(name)) {
      this.game().notify('Не хватило места для шаблона');
      return;
    }
    if (input) input.value = '';
    this.game().notify(`Шаблон «${name}» сохранён — он в разделе «Шаблон»`);
  }

  /** Кольцо: число полос и размер — картинками. */
  private ringOptionsHtml(sw: string): string {
    const c = this.controller;
    const sizes: { id: RingSize; name: string; k: number }[] = [
      { id: 'small', name: 'Малое', k: 0 },
      { id: 'medium', name: 'Среднее', k: 0.5 },
      { id: 'large', name: 'Большое', k: 1 },
    ];
    const lanes = [1, 2, 3]
      .map(
        (n) => `<button class="icon-btn ${c.ring.lanes === n ? 'active' : ''}" data-action="ring-lanes" data-v="${n}" title="${n} ${n === 1 ? 'полоса' : 'полосы'} по кольцу">
          ${ringSvg(0.5, n)}<span>${n} ${n === 1 ? 'полоса' : 'полосы'}</span></button>`,
      )
      .join('');
    const size = sizes
      .map(
        (s) => `<button class="icon-btn ${c.ring.size === s.id ? 'active' : ''}" data-action="ring-size" data-id="${s.id}" title="${s.name} кольцо: больше места для въездов и машин">
          ${ringSvg(s.k, c.ring.lanes)}<span>${s.name}</span></button>`,
      )
      .join('');
    return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Полосы кольца</div><div class="icons">${lanes}</div></div>
      <div class="opt-group"><div class="opt-title">Размер</div><div class="icons">${size}</div></div>
      <div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">Кликните по перекрёстку — он станет кольцом с выбранным числом полос. Если примыкают широкие дороги, кольцо будет больше.</p></div></div>`;
  }

  /** Отдельный инструмент «Ж/д»: путь или вокзал. */
  private railOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Что строим', 'rail-mode', c.railMode, [
      { id: 'track', name: 'Путь', svg: railSvg(76, 34), hint: 'Ж/д путь: прямые, дуги, мосты и тоннели' },
      { id: 'parallel', name: 'Пристроить', svg: tracksSvg(2, true), hint: 'Зажмите на пути и тяните вдоль: рядом ляжет второй путь' },
      { id: 'station', name: 'Станция', svg: stationSvg('rail', 34), hint: 'Ж/д станция с двумя платформами: на пути или в чистом поле' },
      { id: 'signal', name: 'Сигнал', svg: signalSvg(), hint: 'Делит путь на блоки: несколько поездов едут друг за другом' },
    ]);
    if (c.railMode === 'signal') {
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как ставить сигналы</div>
        <div class="rules">
          <div>${signalSvg()}<span>Клик рядом с путём: сигнал встанет для поездов, у которых курсор справа по ходу. Повторный клик — снять</span></div>
          <div>${railSvg(40, 20)}<span>Без сигналов поезд занимает весь путь до станции. С сигналами — только участок до следующего сигнала</span></div>
          <div>${switchSvg()}<span>Двухпутка: на каждом пути сигналы в его направлении — поезда пойдут друг за другом</span></div>
          <div>⚠️<span>На однопутке ставьте сигналы только в одну сторону — иначе встречные поезда могут упереться друг в друга</span></div>
        </div>
        <div class="price">${money(COST.signal)} за сигнал</div></div></div>`;
    }
    if (c.railMode === 'station') {
      const tip = `Ставьте на прямой участок пути или в чистом поле — тогда путь построится вместе со станцией (R — повернуть). Рядом будут пути с платформами, чтобы поезда разъезжались. Охват ${RAIL_STATION.catchment} м.`;
      const tracks = [2, 3, 4]
        .map(
          (n) => `<button class="icon-btn ${c.stationTracks === n ? 'active' : ''}" data-action="st-tracks" data-v="${n}" title="${n} пути с платформами">
            ${platformsSvg(n)}<span>${n} пути</span></button>`,
        )
        .join('');
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Платформы</div><div class="icons">${tracks}</div></div>
        <div class="opt-group"><div class="opt-title">Работает с</div>${this.servesHtml(c.stationServes, 'new-serves')}</div>
        <div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">${tip}</p>
        <div class="price">от ${money(RAIL_STATION.cost * (c.stationTracks - 1))}</div></div></div>`;
    }
    const rules = `<div class="opt-group narrow"><div class="opt-title">Ж/д путь · ${speedSign(specKmh(RAIL_SPEC), 22)}</div>
      <div class="rules">
        <div>${railSvg(40, 20)}<span>Один путь — поезда ходят по очереди, автоблокировка не пустит встречный</span></div>
        <div>${switchSvg()}<span>Ответвление — только плавной стрелкой, под небольшим углом</span></div>
        <div>${crossingSvg()}<span>Переезд с дорогой — под углом от 30°, шлагбаум закрывается перед поездом</span></div>
      </div>
      <div class="price">≈ ${money(specCost(RAIL_SPEC) * 100)} за 100 м на земле</div></div>`;
    if (c.railMode === 'parallel') {
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Пристроить путь</div>
        <div class="rules">
          <div>${tracksSvg(2, true)}<span>Зажмите на пути и тяните вдоль него — рядом, со стороны курсора, ляжет второй путь до точки, где отпустите</span></div>
          <div>${switchSvg()}<span>Путь идёт по участкам до ближайшей стрелки. Соединить пути — стрелкой, инструментом «Путь»</span></div>
        </div></div></div>`;
    }
    // Сколько путей класть сразу: один или два рядом (ось — по курсору).
    const count = [1, 2]
      .map(
        (n) => `<button class="icon-btn ${c.railTracks === n ? 'active' : ''}" data-action="rail-tracks" data-v="${n}" title="${n === 1 ? 'Один путь' : 'Два пути рядом: курсор — ось между ними'}">
          ${tracksSvg(n)}<span>${n === 1 ? '1 путь' : '2 пути'}</span></button>`,
      )
      .join('');
    return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Путей</div><div class="icons">${count}</div></div>${rules}${this.shapeHtml()}</div>`;
  }

  /** «Работает с»: пассажиры и/или груз — две карточки-переключателя. */
  private servesHtml(serves: StationServes, action: string, id = ''): string {
    const card = (what: 'pax' | 'cargo', icon: string, name: string, hint: string) =>
      `<button class="card ${serves[what] ? 'active' : ''}" data-action="${action}" data-what="${what}" data-id="${id}" title="${hint}">
        ${icon}<span class="name">${name}</span></button>`;
    return `<div class="cards serves">${card('pax', cargoIcon('passengers', 28), 'Пассажиры', 'Жители садятся и выходят здесь')}${card(
      'cargo',
      cargoIcon('goods', 28),
      'Груз',
      'Грузы предприятий и поставки в город',
    )}</div>`;
  }

  private stationOptionsHtml(): string {
    const c = this.controller;
    const sw = this.kindSwitch('Что ставим', 'station-mode', c.stationMode, [
      { id: 'road', name: 'Автостанция', svg: stationSvg('road', 34), hint: 'Грузовики и автобусы, с заездом и постами погрузки' },
      { id: 'stop', name: 'Остановка', svg: stationSvg('stop', 34), hint: 'Автобусная остановка прямо на улице — для маршрутов по городу' },
    ]);
    if (c.stationMode === 'stop') {
      const tip = `Остановка встаёт у края улицы со стороны курсора: автобусы останавливаются прямо в полосе. Только пассажиры, охват ${STOP.catchment} м, ${STOP.bays} места для автобусов. Не ближе ${STOP.gap} м к перекрёстку. В маршруте её можно смешивать с автостанциями.`;
      return `<div class="opt-row">${sw}<div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">${tip}</p>
        <div class="price">${money(STOP.cost)}</div></div></div>`;
    }
    const tip = `Автостанция для грузовиков и автобусов: у дороги, прямо у перекрёстка или вплотную к предприятию — с той стороны, где курсор. Дома на месте станции снесём (красные). Охват ${STATION.catchment} м. Посты погрузки добавляются в карточке станции. Ж/д станции — в инструменте «Ж/д».`;
    return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Работает с</div>${this.servesHtml(c.stationServes, 'new-serves')}</div>
      <div class="opt-group narrow"><div class="opt-title">Как ставить</div><p class="muted">${tip}</p>
      <div class="price">${money(COST.station)}</div></div></div>`;
  }

  private roadOptionsHtml(): string {
    const c = this.controller;
    const s = c.spec;
    const sw = this.kindSwitch('Действие', 'road-mode', c.roadMode, [
      { id: 'build', name: 'Строить', svg: modeSvg('arc'), hint: 'Новая дорога по точкам', key: 'N' },
      { id: 'lane', name: 'Полоса', svg: laneSvg(), hint: 'Тяните от края дороги вдоль неё — новая полоса; уведите в сторону — съезд; из поля к краю и вдоль — въезд с полосой разгона', key: 'L' },
      { id: 'upgrade', name: 'Перестроить', svg: upgradeSvg(), hint: 'Клик по дороге — заменить её выбранным типом, полосами и скоростью', key: 'U' },
      { id: 'move', name: 'Двигать', svg: moveNodeSvg(), hint: 'Тяните узел — дороги следом; середину дороги — выгнуть', key: 'M' },
    ], true);
    if (c.roadMode === 'move') {
      // Что можно тянуть — картинками: узел (дороги следом), тупик (продлить, примкнуть), середину и перо.
      const what = [
        { svg: moveNodeSvg(), name: 'Узел', small: 'дороги следом' },
        { svg: moveEndSvg(), name: 'Тупик', small: 'продлить, примкнуть' },
        { svg: bendSvg(), name: 'Середина', small: 'изогнуть дугой' },
        { svg: handleSvg(), name: 'Перо', small: 'угол у узла' },
      ]
        .map((x) => `<div class="card">${x.svg}<span class="name">${x.name}</span><small>${x.small}</small></div>`)
        .join('');
      return `<div class="opt-row">${sw}<div class="opt-group"><div class="opt-title">Что тянуть</div><div class="cards">${what}</div></div>
        <div class="opt-group narrow"><div class="opt-title">Двигать</div>
        <p class="muted">Изгиб у прямой между соседями встаёт ровно на неё. Тупик на другой дороге — примыкает. Перья видны у дороги под курсором; в стыке соседняя дорога поворачивает следом, <kbd>Shift</kbd> — излом.</p></div></div>`;
    }
    const presets = ROAD_PRESETS.map(
      (p) => `<button class="card ${c.presetId === p.id ? 'active' : ''}" data-action="preset" data-id="${p.id}"
        title="${PRESET_HINTS[p.id] ?? p.name}">${roadSvg(p.spec, 64, 26)}<span class="name">${p.name}</span>
        <small>${lanesLabel(p.spec)} · ${specKmh(p.spec)} км/ч</small></button>`,
    ).join('');
    const stepper = (key: 'f' | 'b', value: number, arrow: string, title: string) =>
      `<span class="stepper" title="${title}"><button data-action="lanes" data-${key}="-1">−</button>
        <b>${arrow} ${value}</b><button data-action="lanes" data-${key}="1">+</button></span>`;
    // Только знаки: ограничение скорости не зависит от типа дороги.
    const limits = SPEED_LIMITS.map(
      (v) => `<button class="limit ${specKmh(s) === v ? 'active' : ''}" data-action="limit" data-v="${v}" title="Ограничение ${v} км/ч">${speedSign(v, 26)}</button>`,
    ).join('');
    // Полосы в одну строку: встречные — схема — попутные; цена — в заголовке.
    const lanes = `<div class="lane-editor">
        ${stepper('b', s.lanesB, '←', 'Полосы во встречном направлении (0 — односторонняя)')}
        <div class="lane-preview">${roadSvg(s, 104, 36)}</div>
        ${stepper('f', s.lanesF, '→', 'Полосы в направлении строительства')}
      </div>`;
    const tail =
      c.roadMode === 'build'
        ? this.shapeHtml()
        : `<div class="opt-group narrow"><div class="opt-title">Перестроить</div>
          <p class="muted">Кликните по дороге, чтобы заменить её выбранным типом, полосами и скоростью. Повторный клик по односторонней дороге разворачивает её.</p></div>`;
    return `<div class="opt-row">${sw}<div class="opt-group wide"><div class="opt-title">Тип дороги</div><div class="cards">${presets}</div></div></div>
      <div class="opt-row"><div class="opt-group"><div class="opt-title">Полосы <span class="price-tag">≈ ${money(specCost(s) * 100)} за 100 м</span></div>${lanes}</div>
        <div class="opt-group"><div class="opt-title">Скорость</div><div class="limits">${limits}</div></div>${tail}</div>`;
  }

  private renderSide(): void {
    // Пока игрок вводит название линии, не перерисовываем панель.
    if (document.activeElement instanceof HTMLInputElement && this.q('[data-side]').contains(document.activeElement)) return;
    if (this.pressing || this.dragLine !== null) return;
    const html = this.sideHtml();
    if (html !== this.lastPanel) {
      const side = this.q('[data-side]');
      side.innerHTML = html;
      this.lastPanel = html;
      // Новую или переименовываемую папку сразу открываем для ввода названия.
      const input = side.querySelector<HTMLInputElement>('[data-folder-name]');
      input?.focus();
      input?.select();
    }
  }

  private sideHtml(): string {
    const c = this.controller;
    const g = this.game();
    const parts: string[] = [];
    // Дополнение маршрута: показываем карточку этой линии, клики по станциям добавляют их.
    if (c.tool === 'line' && c.addStopTo !== null && g.lines.has(c.addStopTo)) return this.lineHtml(c.addStopTo);
    if (c.tool === 'line') {
      const names = c.lineDraft.map((id) => esc(g.stations.get(id)?.name ?? '?'));
      parts.push(`<section><h3>Новый маршрут</h3>
        <p class="muted">${names.length ? names.join(' → ') : 'Кликните по станциям в порядке следования.'}</p>
        <div class="actions"><button class="primary small" data-action="finish-line" ${names.length < 2 ? 'disabled' : ''}>Готово</button>
        <button class="small" data-action="cancel-line">Отмена</button></div></section>`);
      return parts.join('');
    }
    const line = c.selectedLine !== null ? g.lines.get(c.selectedLine) : undefined;
    if (line) parts.push(this.lineHtml(line.id));
    else if (c.selection) parts.push(this.selectionHtml());
    parts.push(this.linesListHtml());
    return parts.join('');
  }

  /**
   * Список линий; если выбрана станция — только линии через неё,
   * если машина компании — только её линия, у машины жителя списка нет.
   * Общий список — с папками: сначала папки, за ними линии без папки.
   */
  private linesListHtml(): string {
    const g = this.game();
    const sel = this.controller.selection;
    // У машины жителя линий нет, а у машины компании её линия уже есть в карточке.
    if (sel?.type === 'vehicle' || sel?.type === 'fleet') return '';
    const station = sel?.type === 'station' && this.controller.selectedLine === null ? g.stations.get(sel.id) : undefined;
    const list = station ? g.stationLines(station.id) : [...g.lines.values()];
    const title = station ? 'Маршруты станции' : 'Маршруты';
    const empty = station
      ? 'Через эту станцию маршруты не проходят.'
      : 'Пока нет маршрутов. Постройте две станции и соедините их маршрутом.';
    const rows = station
      ? list.map((l) => this.lineRowHtml(l)).join('')
      : [...g.folders.values()].map((f) => this.folderHtml(f)).join('') +
        g
          .folderLines(null)
          .map((l) => this.lineRowHtml(l, true))
          .join('');
    const folderBtn = station
      ? ''
      : `<button class="small with-ic" data-action="new-folder" title="Папка для маршрутов: перетащите в неё строки маршрутов">${folderSvg(15)}Папка</button>`;
    // Заголовок сворачивает весь список; кнопки — рядом с ним, наверху.
    const collapsed = this.linesCollapsed;
    const head = `<header class="lines-head">
        <button class="lines-toggle" data-action="toggle-lines" title="${collapsed ? 'Развернуть' : 'Свернуть'} список">
          <span class="caret">${collapsed ? '▸' : '▾'}</span><h3>${title}</h3>${list.length ? `<span class="muted">${list.length}</span>` : ''}</button>
        <button class="small" data-action="new-line" title="Новый маршрут">+ Маршрут</button>${folderBtn}</header>`;
    return `<section class="lines-list" ${station ? '' : 'data-folder-drop="root"'}>${head}${
      collapsed ? '' : rows || `<p class="muted">${empty}</p>`
    }</section>`;
  }

  /** Папка в списке: значок, название, сводка по линиям (число, прибыль) и вложенные линии. */
  private folderHtml(f: LineFolder): string {
    const lines = this.game().folderLines(f.id);
    const profit = lines.reduce((s, l) => s + l.revenueLast - l.costLast, 0);
    const renaming = this.renamingFolder === f.id;
    const name = renaming
      ? `<input class="line-name folder-name" data-folder-name="${f.id}" value="${esc(f.name)}" maxlength="40" />`
      : `<span class="folder-title" data-folder-title="${f.id}" title="Двойной клик — переименовать">${esc(f.name)}</span>`;
    // Свёрнутая папка показывает цвета своих линий.
    const dots = f.collapsed ? `<span class="folder-dots">${lines.slice(0, 6).map((l) => `<i style="background:${l.color}"></i>`).join('')}</span>` : '';
    const body = f.collapsed
      ? ''
      : `<div class="folder-lines">${lines.map((l) => this.lineRowHtml(l, true)).join('') || '<p class="muted small-note">Перетащите сюда строку маршрута</p>'}</div>`;
    // Карандаш — сразу за названием, сводка и ✕ — у правого края.
    const pencil = renaming
      ? ''
      : `<button class="icon pencil" data-action="rename-folder" data-id="${f.id}" title="Переименовать">✎</button><span class="folder-fill"></span>`;
    return `<div class="folder ${f.collapsed ? 'collapsed' : ''}" data-folder-drop="${f.id}">
      <div class="folder-row" ${renaming ? '' : `data-action="toggle-folder" data-id="${f.id}"`} title="${f.collapsed ? 'Развернуть' : 'Свернуть'}">
        <span class="caret">${f.collapsed ? '▸' : '▾'}</span>${folderSvg(16, !f.collapsed)}${name}${pencil}${dots}
        <small>${lines.length} мрш.</small><small class="${profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</small>${lines.some((l) => l.problem) ? '<b class="warn">!</b>' : ''}
        <button class="icon" data-action="delete-folder" data-id="${f.id}" title="Удалить папку — маршруты останутся в списке">✕</button>
      </div>${body}</div>`;
  }

  /** Значок линии цвета линии: автобус, грузовик или поезд. */
  private lineIcon(l: Line, w = 20): string {
    return lineKindSvg(this.game().lineVehicleKind(l), l.color, w);
  }

  /** Строка линии; в общем списке её можно перетащить на папку или в другое место списка. */
  private lineRowHtml(l: Line, draggable = false): string {
    const profit = l.revenueLast - l.costLast;
    // Перетаскиваемая строка — div: кнопки перетаскиваются не во всех браузерах.
    const tag = draggable ? 'div' : 'button';
    const drag = draggable
      ? ` draggable="true" data-drag-line="${l.id}" title="Перетащите, чтобы поменять порядок${this.game().folders.size ? ' или переложить в папку' : ''}"`
      : '';
    return `<${tag} class="line-row ${this.controller.selectedLine === l.id ? 'active' : ''}" data-action="select-line" data-id="${l.id}"${drag}>
      ${this.lineIcon(l)}<span>${esc(l.name)}</span><small>${l.vehicles.length} маш.</small>
      <small class="${profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</small>${l.problem ? '<b class="warn">!</b>' : ''}</${tag}>`;
  }

  /** Папка линии в карточке: чипы с папками, «+ Папка» — новая папка сразу с этой линией. */
  private folderPickHtml(line: Line): string {
    const chip = (id: number | null, label: string) =>
      `<button class="opt ${(line.folder ?? null) === id ? 'active' : ''}" data-action="line-folder" data-line="${line.id}" data-folder="${id ?? ''}">${label}</button>`;
    const chips = [...this.game().folders.values()].map((f) => chip(f.id, esc(f.name))).join('');
    return `<div class="folder-pick" title="Папка в списке маршрутов">${folderSvg(18)}<div class="opts">${chip(null, 'Без папки')}${chips}
      <button class="opt" data-action="line-folder-new" data-line="${line.id}" title="Новая папка с этим маршрутом">+ Папка</button></div></div>`;
  }

  /**
   * Маршрут линии: станции по порядку с условиями отправления, погрузки и выгрузки.
   * Клик по условию раскрывает настройку этой остановки.
   */
  private routeHtml(line: Line): string {
    const g = this.game();
    const n = line.stops.length;
    const adding = this.controller.addStopTo === line.id;
    const rows = line.stops
      .map((sid, i) => {
        const st = g.stations.get(sid);
        const rule = g.stopRule(line, i);
        const open = this.stopOpen?.line === line.id && this.stopOpen.i === i;
        const loadIcons = rule.load === 'auto' ? '' : `<span class="rl">⬆${rule.load.length ? rule.load.map((c) => cargoIcon(c, 14)).join('') : '✕'}</span>`;
        const unloadIcons =
          rule.unload === 'auto' ? '' : rule.unload === 'all' ? '<span class="rl">⬇ склад</span>' : `<span class="rl">⬇${rule.unload.map((c) => cargoIcon(c, 14)).join('')}</span>`;
        const btn = (action: string, label: string, title: string, disabled = false) =>
          `<button class="icon" data-action="${action}" data-line="${line.id}" data-i="${i}" title="${title}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        return `<div class="stop ${open ? 'open' : ''}">
          <span class="num">${i + 1}</span>
          <span class="st-name">${st ? (st.kind === 'rail' ? '🚉 ' : '') + esc(st.name) : '?'}</span>
          <button class="rule-chip" data-action="stop-open" data-line="${line.id}" data-i="${i}" title="Условия на этой остановке">${WAIT_LABELS[ruleWaitId(rule)]}${loadIcons}${unloadIcons}</button>
          ${btn('stop-up', '↑', 'Раньше', i === 0)}${btn('stop-down', '↓', 'Позже', i === n - 1)}${btn('stop-del', '✕', 'Убрать из маршрута', n <= 2)}
        </div>${open ? this.stopRuleHtml(line, i, rule) : ''}`;
      })
      .join('');
    return `<div class="route"><div class="route-head"><span class="lbl2">Остановки</span>
      <button class="small ${adding ? 'primary' : ''}" data-action="${adding ? 'stop-add-done' : 'stop-add'}" data-line="${line.id}">${adding ? 'Готово' : '+ Станция'}</button></div>
      ${adding ? '<p class="tip">Кликайте по станциям на карте — они добавятся в конец маршрута.</p>' : ''}
      ${rows}<p class="muted small-note">После последней станции — снова к первой.</p></div>`;
  }

  /** Настройка остановки: отправление, погрузка, выгрузка — кнопками и значками грузов. */
  private stopRuleHtml(line: Line, i: number, rule: StopRule): string {
    const attrs = `data-line="${line.id}" data-i="${i}"`;
    const waitId = ruleWaitId(rule);
    const waits = (Object.keys(WAIT_LABELS) as WaitId[])
      .map((w) => `<button class="opt ${waitId === w ? 'active' : ''}" data-action="rule-wait" ${attrs} data-v="${w}" title="${WAIT_HINTS[w]}">${WAIT_LABELS[w]}</button>`)
      .join('');
    const cargoChips = (action: string, list: CargoType[] | null) =>
      FREIGHT.map(
        (c) => `<button class="cargo-chip ${list?.includes(c) ? 'active' : ''}" data-action="${action}" ${attrs} data-c="${c}" title="${CARGO[c].name}">${cargoIcon(c, 20)}</button>`,
      ).join('');
    const loadList = rule.load === 'auto' ? null : rule.load;
    const unloadList = Array.isArray(rule.unload) ? rule.unload : null;
    return `<div class="stop-rule">
      <div class="rule-row"><span class="lbl2">Отправление</span><div class="opts">${waits}</div></div>
      <div class="rule-row"><span class="lbl2">Грузить</span><div class="opts">
        <button class="opt ${rule.load === 'auto' ? 'active' : ''}" data-action="rule-load" ${attrs} data-c="auto" title="То, что примут дальше по маршруту">Авто</button>
        ${cargoChips('rule-load', loadList)}</div></div>
      <div class="rule-row"><span class="lbl2">Выгружать</span><div class="opts">
        <button class="opt ${rule.unload === 'auto' ? 'active' : ''}" data-action="rule-unload" ${attrs} data-c="auto" title="Только тому, кто здесь принимает груз">Авто</button>
        <button class="opt ${rule.unload === 'all' ? 'active' : ''}" data-action="rule-unload" ${attrs} data-c="all" title="Всё, что везём: получателю, а остальное — на склад станции для другого маршрута">Всё на склад</button>
        ${cargoChips('rule-unload', unloadList)}</div></div>
    </div>`;
  }

  private lineHtml(id: number): string {
    const g = this.game();
    const line = g.lines.get(id)!;
    const vehicles = line.vehicles
      .map((vid) => {
        const v = g.fleet.get(vid);
        if (!v) return '';
        const m = MODELS[v.model];
        const st = g.stations.get(line.stops[v.stop]);
        const state =
          v.state === 'driving' ? `едет на ${esc(st?.name ?? '?')}` : v.state === 'loading' ? `погрузка: ${esc(st?.name ?? '?')}` : `ждёт: ${esc(st?.name ?? '?')}`;
        const load = vehicleLoad(v);
        const what = v.cargo ? cargoIcon(v.cargo, 14) : load ? cargoIcon('passengers', 14) : 'пусто';
        // Замена на модель новее, когда она вышла.
        const next = g.replacementFor(v);
        const replace = next
          ? `<button class="small replace" data-action="replace" data-id="${v.id}" title="Продать за ${money(g.saleValue(v))} и купить ${MODELS[next].name} за ${money(MODELS[next].price)}">⟳ ${
              MODELS[next].name
            }</button>`
          : '';
        // Длина состава: вагоны добавляются и снимаются, пока помещаются на платформы линии.
        const cars =
          m.mode === 'rail'
            ? `<span class="stepper cars" title="Вагонов в составе (до ${g.maxCars(v)} — по длине платформ)"><button data-action="cars" data-id="${v.id}" data-d="-1">−</button><b>🚃 ${carsOf(
                v,
              )}</b><button data-action="cars" data-id="${v.id}" data-d="1">+</button></span>`
            : '';
        return `<div class="veh"><div><b>${esc(v.name)}</b><small>${state} · ${load}/${vehicleCapacity(v)} ${what}</small></div>
          ${cars}${replace}
          <button class="icon" title="Показать" data-action="show-fleet" data-id="${v.id}">◎</button>
          <button class="icon" title="Продать за ${money(g.saleValue(v))}" data-action="sell" data-id="${v.id}">✕</button></div>`;
      })
      .join('');
    // Палитра открывается по клику на кружок цвета линии.
    const palette =
      this.colorsOpen === line.id
        ? `<div class="swatches" title="Цвет маршрута">${LINE_COLORS.map(
            (c) => `<button class="swatch ${c === line.color ? 'active' : ''}" style="background:${c}" data-action="line-color" data-id="${line.id}" data-color="${c}"></button>`,
          ).join('')}<label class="swatch custom" title="Свой цвет"><input type="color" data-line-color="${line.id}" value="${line.color}" /></label></div>`
        : '';
    return `<section class="detail"><header><button class="line-dot" style="background:${line.color}" data-action="toggle-colors" data-id="${line.id}" title="Сменить цвет"></button>
        <input class="line-name" data-line-name="${line.id}" value="${esc(line.name)}" title="Нажмите, чтобы переименовать" maxlength="60" />
        <button class="icon" data-action="close-line">✕</button></header>
      ${palette}
      ${this.folderPickHtml(line)}
      ${this.routeHtml(line)}
      ${line.problem ? `<p class="warn">${esc(line.problem)}</p>` : ''}
      ${g
        .lineAdvice(line)
        .map((a) => `<p class="tip">${esc(a)}</p>`)
        .join('')}
      <div class="kv"><span>Прибыль (прошлый мес.)</span><b class="${line.revenueLast - line.costLast >= 0 ? 'pos' : 'neg'}">${money(line.revenueLast - line.costLast)}</b>
        <span>Доход / расходы</span><b>${money(line.revenueLast)} / ${money(line.costLast)}</b>
        <span>Перевезено</span><b>${line.carriedLast}</b>
        <span>Загрузка рейсов</span><b>${line.loadLast === undefined || line.loadLast === null ? '—' : `${Math.round(line.loadLast * 100)}%`}</b>
        <span>В этом месяце</span><b>${money(line.revenueMonth)}</b>
        <span>Всего заработано</span><b>${money(line.revenueTotal)}</b></div>
      ${line.history?.length ? `<div class="line-chart">${incomeChart(line.history.map((h) => ({ label: h.label, income: h.revenue, expense: h.cost })), 70)}</div>` : ''}
      <div class="buy">${modelsFor(g.lineMode(line), g.year)
        .map(
          (m) => `<button class="buy-card" data-action="buy" data-line="${line.id}" data-model="${m}" title="Вместимость ${MODELS[m].capacity} · содержание ${money(MODELS[m].running)}/мес · с ${MODELS[m].year} г.">
            ${modelSvg(m)}<span>+ ${MODELS[m].name}</span><small>${MODELS[m].capacity} мест · ${money(MODELS[m].price)}</small></button>`,
        )
        .join('')}</div>
      <div class="vehicles">${vehicles || `<p class="muted">Купите ${g.lineMode(line) === 'rail' ? 'поезд' : 'машину'}, чтобы маршрут заработал.</p>`}</div>
      <div class="actions"><button class="small danger" data-action="delete-line" data-id="${line.id}">Удалить маршрут</button></div></section>`;
  }

  private selectionHtml(): string {
    const g = this.game();
    const sel = this.controller.selection!;
    const head = (title: string, sub = '') =>
      `<header><h3>${esc(title)}</h3><button class="icon" data-action="close-sel">✕</button></header>${sub ? `<p class="muted">${sub}</p>` : ''}`;
    if (sel.type === 'station') {
      const st = g.stations.get(sel.id);
      if (!st) return '';
      let pax = 0;
      for (const n of st.passengers.values()) pax += n;
      const waiting = [
        ...FREIGHT.filter((c) => (st.cargo[c] ?? 0) >= 1).map((c) => [c, Math.floor(st.cargo[c] ?? 0)] as const),
        ...(pax ? [['passengers', pax] as const] : []),
      ];
      const suppliesAll = [...new Set(g.industries.filter((i) => st.industryIds.includes(i.id)).map((i) => i.info.produces))];
      const towns = st.townIds.map((id) => g.towns.find((t) => t.id === id)?.name).filter(Boolean).join(', ');
      const kind =
        st.industryId !== null ? 'Станция предприятия · ' : st.kind === 'rail' ? 'Ж/д станция · ' : st.kind === 'stop' ? 'Автобусная остановка · ' : '';
      const busy =
        st.kind === 'rail'
          ? `платформ занято ${st.platforms.filter((p) => g.rail.isReserved(p)).length} из ${st.platforms.length}`
          : st.kind === 'stop'
            ? `автобусов ${st.occupied.length} из ${st.bays}`
            : `постов занято ${st.occupied.length} из ${st.bays}`;
      const supplies = st.serves.cargo ? suppliesAll : [];
      // Куда едут пассажиры: станция назначения (клик — показать), сколько ждут и какие линии туда ходят.
      const routes = g.paxRoutes(st);
      const dests = [...new Set([...routes.keys(), ...st.passengers.keys()])]
        .map((sid) => ({ sid, n: Math.floor(st.passengers.get(sid) ?? 0), lines: routes.get(sid) ?? [] }))
        .filter((d) => g.stations.has(d.sid))
        .sort((a, b) => b.n - a.n);
      const most = Math.max(1, ...dests.map((d) => d.n));
      const paxRows = dests
        .map((d) => {
          const to = g.stations.get(d.sid)!;
          const lines = d.lines
            .map((l) => `<button class="line-kind-btn" data-action="select-line" data-id="${l.id}" title="${esc(l.name)}">${this.lineIcon(l, 18)}</button>`)
            .join('');
          return `<div class="pax-row">${lines}<span class="arrow">→</span>
            <button class="place-link" data-action="show-station" data-id="${to.id}" title="Показать на карте">${esc(to.name)}</button>
            <span class="pax-bar"><i style="width:${(d.n / most) * 100}%"></i></span><b>${d.n}</b></div>`;
        })
        .join('');
      const paxBlock =
        st.serves.pax && (pax || dests.length)
          ? `<div class="rule-row"><span class="lbl2">${cargoIcon('passengers', 16)} Куда едут пассажиры</span>${paxRows}</div>`
          : st.serves.pax && st.catchPop > 0
            ? `<p class="muted">${cargoIcon('passengers', 14)} Пассажиры появятся, когда отсюда пойдёт автобус или пассажирский поезд.</p>`
            : '';
      const freightWaiting = waiting.filter(([c]) => c !== 'passengers');
      // Посты погрузки автостанции: картинка станции с постами, «−» и «+» (с ценой или причиной, почему нельзя).
      let baysRow = '';
      if (st.kind === 'road') {
        const more = g.stationBaysPlan(st.id, st.bays + 1);
        const plusTitle = more.ok ? `Добавить пост погрузки · ${money(STATION.bayCost)}` : (more.reason ?? '');
        baysRow = `<div class="icon-row"><span class="lbl2">Посты погрузки</span>
          <span class="stepper bays"><button data-action="st-bays" data-id="${st.id}" data-d="-1" ${st.bays > STATION.minBays ? '' : 'disabled'}
            title="Убрать пост · вернём ${money(STATION.bayCost * COST.refundRatio)}">−</button><b>${baysSvg(st.bays, st.occupied.length)}<span>${st.bays}</span></b><button
            data-action="st-bays" data-id="${st.id}" data-d="1" class="${more.ok ? '' : 'off'}" title="${esc(plusTitle)}">+</button></span>
          ${more.ok ? `<span class="muted">+${money(STATION.bayCost)}</span>` : ''}</div>`;
      }
      // Остановка — только для пассажиров: переключать нечего.
      const servesRow = st.kind === 'stop' ? '' : `<div class="serves-row"><span class="lbl2">Работает с</span>${this.servesHtml(st.serves, 'st-serves', String(st.id))}</div>`;
      return `<section class="detail">${head(st.name, `${kind}${busy}`)}
        ${servesRow}
        ${baysRow}
        ${
          st.serves.cargo || freightWaiting.length
            ? `<div class="icon-row"><span class="lbl2">Груз ждёт</span>${
                freightWaiting.length
                  ? freightWaiting.map(([c, n]) => `<span class="chip-ic">${cargoIcon(c, 18)}<b>${n}</b></span>`).join('')
                  : '<span class="muted">ничего</span>'
              }</div>`
            : ''
        }
        ${paxBlock}
        <div class="icon-row"><span class="lbl2">Отправляет</span>${
          supplies.length ? supplies.map((c) => cargoIcon(c, 20)).join('') : pax || st.catchPop ? cargoIcon('passengers', 20) : '<span class="muted">—</span>'
        }</div>
        <div class="icon-row"><span class="lbl2">Принимает</span>${
          st.accepts.size ? [...st.accepts].map((c) => cargoIcon(c, 20)).join('') : '<span class="muted">—</span>'
        }</div>
        <p class="muted">${towns ? `Город: ${esc(towns)} · ` : ''}жителей в охвате ${st.catchPop}</p></section>`;
    }
    if (sel.type === 'industry') {
      const ind = g.industries.find((i) => i.id === sel.id);
      if (!ind) return '';
      const info = ind.info;
      const recipe = `${info.accepts.map((c) => cargoIcon(c, 26)).join('<span class="plus">+</span>')}${
        info.accepts.length ? '<span class="arrow">→</span>' : ''
      }${cargoIcon(info.produces, 30)}`;
      const stock = info.accepts.length
        ? `<div class="icon-row"><span class="lbl2">На складе</span>${info.accepts
            .map((c) => `<span class="chip-ic">${cargoIcon(c, 18)}<b>${Math.floor(ind.stock[c] ?? 0)}</b></span>`)
            .join('')}</div>`
        : '';
      return `<section class="detail">${head(ind.name)}
        <div class="recipe">${recipe}</div>
        <p class="muted">${
          info.accepts.length > 1
            ? 'Работает, только когда привезли все виды сырья.'
            : info.accepts.length
              ? 'Перерабатывает сырьё, которое ему привозят.'
              : 'Добывает сырьё, когда рядом есть станция с маршрутом.'
        }</p>
        ${stock}
        <div class="kv"><span>Уровень производства</span><b>×${ind.level ?? 1} · до ${g.industryRate(ind)}/мес</b>
          <span>Произведено (прош. мес.)</span><b>${ind.producedLast}</b><span>В этом месяце</span><b>${ind.producedMonth}</b></div>
        <div class="level-bar" title="Растёт, если продукцию регулярно вывозят; падает, если предприятие долго не обслуживают">
          <div style="width:${(((ind.level ?? 1) - 1) / 3) * 100}%"></div></div>
        <p class="muted small-note">Вывозите продукцию без задержек — производство вырастет до ×4.</p>
        <p class="tip">Инструментом «Станция» наведите на предприятие: станция встанет вплотную к той стороне, куда указывает курсор, и выезд будет смотреть туда же.</p>
        ${this.partnersHtml(g.partners(ind, 3))}</section>`;
    }
    if (sel.type === 'building') {
      const b = g.buildingById(sel.id);
      if (!b) return '';
      const town = g.townOf(b);
      const kind = b.kind === 'landmark' ? 'Ратуша' : b.kind === 'com' ? 'Офисы и магазины' : 'Жилой дом';
      const people = b.kind === 'res' ? `${b.floors * 14} жителей` : b.kind === 'com' ? `${b.floors * 4} рабочих мест` : 'центр города';
      const moveCost = Math.round(g.demolishCost(b.id) * 0.6) || 3000;
      return `<section class="detail">${head(kind, `${b.floors} эт. · ${people}`)}
        ${town ? `<button class="partner" data-action="focus" data-type="town" data-id="${town.id}">${townIcon(18)}<span>${esc(town.name)}</span><small>${town.population} жит.</small></button>` : ''}
        <div class="actions">
          <button class="small" data-action="move" data-id="${b.id}">Перенести · ${money(moveCost)}</button>
          ${b.kind !== 'landmark' ? `<button class="small danger" data-action="demolish" data-id="${b.id}">Снести · ${money(g.demolishCost(b.id))}</button>` : ''}
        </div>
        <p class="muted">Перенесённое здание встанет вдоль ближайшей улицы. Дорога, проложенная через дома, снесёт их сама.</p></section>`;
    }
    if (sel.type === 'town') {
      const t = g.towns.find((x) => x.id === sel.id);
      if (!t) return '';
      const needs = t.demands
        .map((c) => {
          const now = t.supplied[c] ?? 0;
          const last = t.lastSupplied[c] ?? 0;
          const pct = Math.min(100, (now / TOWN_NEED) * 100);
          return `<div class="need">${cargoIcon(c, 24)}<div><b>${CARGO[c].name}</b>
            <div class="bar"><div style="width:${pct}%;background:${CARGO[c].color}"></div></div>
            <small>в этом месяце ${now} из ${TOWN_NEED} · в прошлом ${last}${last >= TOWN_NEED ? ' ✓' : ''}</small></div></div>`;
        })
        .join('');
      const faces = { good: '😊', ok: '😐', bad: '😠' };
      const reviews = g
        .townReviews(t)
        .map((r) => `<div class="review ${r.mood}"><span class="face">${faces[r.mood]}</span><span>${esc(r.text)}</span></div>`)
        .join('');
      const auto = t.autoStreets !== false;
      const streets = `<button class="switch-row" data-action="town-streets" data-id="${t.id}" title="Когда вдоль улиц тесно, город сам прокладывает новые и застраивает их">
          <span>🏘️ Строить улицы автоматически</span><span class="switch ${auto ? 'on' : ''}"><i></i></span></button>`;
      return `<section class="detail">${head(t.name, `${t.population} жителей · ${STYLE_NAMES[t.style]}`)}
        ${streets}
        <h4>Что говорят жители</h4>${reviews}
        <h4>Что нужно городу</h4>${needs}
        <p class="muted">Каждая закрытая потребность ускоряет рост. Привозите груз на станцию в черте города.</p>
        ${this.partnersHtml(g.partners(t, 2))}</section>`;
    }
    if (sel.type === 'junction') return this.junctionHtml(sel.id);
    const follow = `<button class="small ${this.controller.following ? 'primary' : ''}" data-action="toggle-follow">${
      this.controller.following ? '◉ Камера следует' : '◎ Следовать'
    } <kbd>F</kbd></button>`;
    if (sel.type === 'fleet') {
      const fleet = g.fleet.get(sel.id);
      if (!fleet) return `<section class="detail">${head('Транспорт')}<p class="muted">Продан.</p></section>`;
      const fsim = g.fleetSim(fleet);
      const train = g.fleetTrain(fleet);
      const v = fsim?.v ?? train?.v ?? 0;
      const trip = fsim ? `<span>В пути</span><b>${Math.round(fsim.tripTime)} с, стоял ${Math.round(fsim.stoppedTime)} с</b>` : '';
      return this.fleetCardHtml(fleet, Math.round(v * KMH_PER_UNIT), follow, trip);
    }
    const sim = g.traffic.vehicles.get(sel.simId);
    if (!sim) return `<section class="detail">${head('Машина')}<p class="muted">Доехала.</p></section>`;
    const speed = Math.round(sim.v * KMH_PER_UNIT);
    return `<section class="detail">${head('Машина жителя')}
      <div class="kv"><span>Скорость</span><b>${speed} км/ч</b><span>В пути</span><b>${Math.round(sim.tripTime)} с</b><span>Стоял в пробках</span><b>${Math.round(sim.stoppedTime)} с</b></div>
      <div class="actions">${follow}</div></section>`;
  }

  /**
   * Карточка перекрёстка: светофор и его фазы, главная дорога и повороты с каждого подъезда.
   * Подъезды подписаны сторонами света и стрелками, повороты — значками.
   */
  private junctionHtml(id: number): string {
    const g = this.game();
    const info = g.junctionInfo(id);
    const head = `<header><h3>Перекрёсток</h3><button class="icon" data-action="close-sel">✕</button></header>`;
    if (!info) return `<section class="detail">${head}<p class="muted">Перекрёстка больше нет.</p></section>`;
    const n = info.node;
    const lights = n.control === 'lights';
    const check = g.lightsPlan(id);
    const toggle = `<button class="small ${lights ? 'primary' : ''}" data-action="jn-lights" data-id="${id}" ${check.ok ? '' : 'disabled'} title="${esc(check.reason ?? '')}">
      🚦 ${lights ? `Светофор включён · убрать +${money(-check.cost)}` : `Поставить светофор · ${money(check.cost)}`}</button>`;
    const attrs = `data-id="${id}"`;
    let control = '';
    if (lights) {
      const adaptive = n.adaptive !== false;
      const phases = info.phases
        .map(
          (p, i) => `<div class="phase ${p.active ? 'active' : ''}"><span class="ph-dirs">${p.approaches.map((a) => `<b title="${a.name}">${a.arrow}</b>`).join('')}</span>
            <span class="muted">${p.approaches.map((a) => a.name).join(' + ')}</span>
            <span class="stepper"><button data-action="jn-green" ${attrs} data-i="${i}" data-d="-2">−</button><b>${p.green} с</b><button data-action="jn-green" ${attrs} data-i="${i}" data-d="2">+</button></span></div>`,
        )
        .join('');
      control = `<div class="rule-row"><span class="lbl2">Режим</span><div class="opts">
          <button class="opt ${adaptive ? 'active' : ''}" data-action="jn-adaptive" ${attrs} data-v="1" title="Пропускает пустые фазы и держит зелёный, пока никто не ждёт">Умный</button>
          <button class="opt ${!adaptive ? 'active' : ''}" data-action="jn-adaptive" ${attrs} data-v="0" title="Строго по кругу с заданным временем">По таймеру</button></div></div>
        <div class="rule-row"><span class="lbl2">Фазы: кому зелёный</span>${phases}</div>`;
    } else if ((n.roundabout ?? null) === null && info.approaches.length >= 3) {
      const manual = n.mainPair;
      const isAuto = manual === undefined || manual === null;
      const isNone = !!manual && manual.length === 0;
      const same = (p: [number, number]) => !!manual && manual.length === 2 && manual.includes(p[0]) && manual.includes(p[1]);
      const now = info.mainNow.map((s) => info.label(s).name).join('–');
      control = `<div class="rule-row"><span class="lbl2">Главная дорога ${isAuto && now ? `(сейчас ${now})` : ''}</span><div class="opts">
        <button class="opt ${isAuto ? 'active' : ''}" data-action="jn-main" ${attrs} data-v="auto" title="Самая прямая и широкая дорога">Авто</button>
        ${info.pairs
          .map((p) => `<button class="opt ${same(p.segs) ? 'active' : ''}" data-action="jn-main" ${attrs} data-v="${p.segs.join(',')}">${p.name}</button>`)
          .join('')}
        <button class="opt ${isNone ? 'active' : ''}" data-action="jn-main" ${attrs} data-v="none" title="Все уступают по очереди, кто раньше подъехал">Равнозначный</button></div></div>`;
    }
    const icons: Record<TurnKind, string> = { left: '↰', straight: '↑', right: '↱' };
    const names: Record<TurnKind, string> = { left: 'налево', straight: 'прямо', right: 'направо' };
    const turns = info.turns
      .map(
        (t) => `<div class="turn-row"><span class="from" title="Подъезд с ${t.label.name}">${t.label.arrow} ${t.label.name}</span>${t.exits
          .map(
            (e) => `<button class="turn ${e.banned ? 'banned' : ''}" data-action="jn-ban" ${attrs} data-from="${t.from}" data-out="${e.out}"
              title="${names[e.kind]} на ${info.label(e.out).name}: ${e.banned ? 'запрещено' : 'разрешено'}">${icons[e.kind]}<small>${info.label(e.out).name}</small></button>`,
          )
          .join('')}</div>`,
      )
      .join('');
    // Связи полос настраиваются на карте в два шага: белый кружок — въезд, оранжевые — куда с него ехать.
    const c = this.controller;
    const second = !!c.laneFrom;
    const steps =
      c.tool === 'lights'
        ? `<span class="lane-step ${second ? '' : 'now'}" title="Кликните на карте белый кружок — полосу въезда"><b>1</b><i class="lane-dot in"></i></span>
          <span class="lane-arrow">➜</span>
          <span class="lane-step ${second ? 'now' : ''}" title="Оранжевые кружки — куда с неё ехать; повторный клик убирает связь"><b>2</b><i class="lane-dot out"></i></span>`
        : `<button class="small" data-action="jn-lanes-edit" title="Включить инструмент «Перекрёсток» и кликать по полосам">✎ На карте</button>`;
    const lanes = `<div class="rule-row"><span class="lbl2">Полосы ${info.customLanes ? `· своих: ${info.customLanes}` : '· авто'}</span>
      <div class="lane-steps">${steps}
        <button class="small" data-action="jn-lanes-reset" ${attrs} ${info.customLanes ? '' : 'disabled'} title="Все полосы — снова автоматически">↺ Сбросить полосы</button></div></div>`;
    return `<section class="detail">${head}
      <p class="muted">${info.approaches.map((a) => `${a.compass.arrow} ${a.compass.name}`).join(' · ')}</p>
      <div class="actions">${toggle}</div>
      ${control}
      <div class="rule-row"><span class="lbl2">Повороты — клик запрещает или разрешает</span>${turns}</div>
      ${lanes}</section>`;
  }

  /** Карточка машины или поезда компании: что везёт (значком и словом), куда едет, прибыль. */
  private fleetCardHtml(v: FleetVehicle, speed: number, follow: string, extra = ''): string {
    const g = this.game();
    const line = g.lines.get(v.lineId);
    const st = line && g.stations.get(line.stops[v.stop]);
    // Название станции — ссылка: камера покажет её на карте, выбор транспорта останется.
    const where = st ? `<button class="place-link" data-action="show-station" data-id="${st.id}" title="Показать на карте">${esc(st.name)}</button>` : '?';
    const state = v.state === 'driving' ? `едет на ${where}` : v.state === 'loading' ? `погрузка: ${where}` : `ждёт отправления: ${where}`;
    const load = vehicleLoad(v);
    const cargo = v.cargo
      ? `<span class="chip-ic">${cargoIcon(v.cargo, 20)}<b>${CARGO[v.cargo].name}</b></span>`
      : load
        ? `<span class="chip-ic">${cargoIcon('passengers', 20)}<b>Пассажиры</b></span>`
        : '<span class="muted">пусто</span>';
    return `<section class="detail"><header><h3>${esc(v.name)}</h3><button class="icon" data-action="close-sel">✕</button></header>
      ${line ? `<button class="line-row" data-action="select-line" data-id="${line.id}">${this.lineIcon(line)}<span>${esc(line.name)}</span></button>` : ''}
      <div class="icon-row"><span class="lbl2">Везёт</span>${cargo}<b class="load">${load}/${vehicleCapacity(v)}</b></div>
      <div class="kv"><span>Сейчас</span><b>${state}</b><span>Скорость</span><b>${speed} км/ч</b>
        <span title="За прошлый месяц">Прибыль</span><b>${money(v.profitLast)}</b>${extra}</div>
      <div class="actions">${follow}</div></section>`;
  }

  private showScreen(name: 'start' | 'menu' | 'newgame'): void {
    for (const s of ['start', 'menu', 'newgame']) this.q(`[data-${s}]`).classList.toggle('hidden', s !== name);
  }

  private hideScreens(): void {
    for (const s of ['start', 'menu', 'newgame']) this.q(`[data-${s}]`).classList.add('hidden');
  }

  /** Закрывает открытое окно: меню — продолжить игру, «Новая игра» — назад в меню. */
  private closeModal(): boolean {
    if (!this.q('[data-newgame]').classList.contains('hidden')) {
      this.confirmNew = false;
      this.showMenu();
      return true;
    }
    if (!this.q('[data-menu]').classList.contains('hidden')) {
      this.hideScreens();
      this.controller.setSpeed(this.speedBeforeMenu);
      return true;
    }
    return false;
  }

  /** Окно с правилами — только для только что созданного мира. */
  showWelcome(): void {
    this.controller.setSpeed(0);
    this.showScreen('start');
  }

  private showMenu(): void {
    const g = this.game();
    const s = g.settings;
    this.q('[data-menu-info]').textContent = `${g.dateLabel} · карта «${MAP_SIZES[s.size].name.toLowerCase()}», ${g.towns.length} городов · seed ${s.seed}`;
    this.confirmSave = null;
    this.showScreen('menu');
    void this.renderSaves(true);
  }

  /** Имя для нового сохранения: из поля, иначе — крупнейший город и дата. */
  private saveName(): string {
    return this.q<HTMLInputElement>('[data-save-name]')?.value.trim() || this.defaultSaveName();
  }

  private defaultSaveName(): string {
    const g = this.game();
    const town = [...g.towns].sort((a, b) => b.population - a.population)[0];
    return `${town?.name ?? 'Партия'} · ${g.dateLabel}`;
  }

  /** Список сохранений со своими именами: загрузить, удалить; текущее отмечено. fresh — новое имя в поле. */
  private async renderSaves(fresh = false): Promise<void> {
    const el = this.q('[data-saves]');
    const typed = fresh ? '' : (this.q<HTMLInputElement>('[data-save-name]')?.value ?? '');
    this.saves = await this.session.list().catch(() => []);
    const linked = this.session.linked();
    const when = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const rows = this.saves
      .map((s) => {
        const old = s.version !== SAVE_VERSION;
        const load =
          this.confirmSave === `load:${s.id}`
            ? `<button class="small danger-fill" data-action="save-load" data-id="${s.id}" title="Текущая партия не сохранена в список и пропадёт">Точно загрузить?</button>`
            : `<button class="small" data-action="save-load" data-id="${s.id}" ${old ? 'disabled title="Сохранение от другой версии игры"' : ''}>Загрузить</button>`;
        const del =
          this.confirmSave === `del:${s.id}`
            ? `<button class="small danger-fill" data-action="save-del" data-id="${s.id}">Удалить?</button>`
            : `<button class="icon" data-action="save-del" data-id="${s.id}" title="Удалить сохранение">✕</button>`;
        return `<div class="save-row ${s.id === linked ? 'current' : ''}">
          <div class="save-info"><b>${esc(s.name)}</b><small>${esc(s.summary)} · ${when(s.savedAt)}${s.id === linked ? ' · текущая партия' : ''}</small></div>
          ${load}${del}</div>`;
      })
      .join('');
    el.innerHTML = `<h3>Сохранения</h3>
      <div class="save-new"><input class="line-name" data-save-name maxlength="40" placeholder="${esc(this.defaultSaveName())}" value="${esc(typed)}" />
        <button class="small" data-action="save-new">Сохранить как новое</button></div>
      <div class="save-list">${rows || '<p class="muted">Своих сохранений пока нет: «Сохранить» запишет партию сюда.</p>'}</div>`;
  }

  /** Форма параметров нового мира. */
  private renderNewGame(): void {
    const d = this.draft;
    const chips = <T extends string | number>(key: string, current: T, options: { v: T; name: string; hint?: string }[]) =>
      options
        .map(
          (o) =>
            `<button class="ng-chip ${o.v === current ? 'active' : ''}" data-action="ng-set" data-key="${key}" data-v="${o.v}">${o.name}${
              o.hint ? `<small>${o.hint}</small>` : ''
            }</button>`,
        )
        .join('');
    const sizes = (Object.keys(MAP_SIZES) as MapSize[]).map((k) => {
      const m = MAP_SIZES[k];
      return { v: k, name: `${mapSvg(m.w, m.h)}${m.name}`, hint: `${((m.w * 0.6) / 1000).toFixed(1)} × ${((m.h * 0.6) / 1000).toFixed(1)} км` };
    });
    const progress = this.session.hasProgress();
    this.q('[data-newgame-body]').innerHTML = `
      <h2>Новая игра</h2>
      <div class="ng-row"><span class="ng-label">Карта</span><div class="ng-options">${chips('size', d.size, sizes)}</div></div>
      <div class="ng-row"><span class="ng-label">Города</span>
        <span class="stepper big"><button data-action="ng-towns" data-d="-1">−</button><b>${townIcon(18)} ${d.towns}</b><button data-action="ng-towns" data-d="1">+</button></span></div>
      <div class="ng-row"><span class="ng-label">Предприятия</span><div class="ng-options">${chips(
        'industries',
        d.industries,
        (Object.keys(INDUSTRY_DENSITY) as IndustryDensity[]).map((k) => ({ v: k, name: INDUSTRY_DENSITY[k].name })),
      )}</div></div>
      <div class="ng-row"><span class="ng-label">Вода</span><div class="ng-options">${chips(
        'water',
        d.water,
        (Object.keys(WATER) as WaterAmount[]).map((k) => ({ v: k, name: WATER[k].name })),
      )}</div></div>
      <div class="ng-row"><span class="ng-label">Капитал</span><div class="ng-options">${chips(
        'money',
        d.money,
        MONEY_OPTIONS.map((o) => ({ v: o.value, name: o.name, hint: money(o.value) })),
      )}</div></div>
      <div class="ng-row"><span class="ng-label">Seed</span>
        <input class="ng-seed" data-ng-seed value="${d.seed}" inputmode="numeric" />
        <button class="secondary small" data-action="ng-seed" title="Случайный мир">🎲</button></div>
      <div class="actions">
        <button class="primary ${this.confirmNew ? 'danger-fill' : ''}" data-action="ng-create">${
          this.confirmNew ? 'Точно? Текущая партия пропадёт' : 'Создать мир'
        }</button>
        <button class="secondary" data-action="ng-cancel">Отмена</button>
      </div>
      ${progress ? '<p class="muted">Текущая партия будет заменена новой.</p>' : ''}`;
  }

  /** Списки «куда везти» и «откуда везти» с переходом к партнёру. */
  private partnersHtml(list: Partner[]): string {
    const row = (p: Partner) => `<button class="partner" data-action="focus" data-type="${p.ref.type}" data-id="${p.ref.id}">
        ${cargoIcon(p.cargo, 18)}${p.ref.type === 'town' ? townIcon(18) : ''}<span>${esc(p.name)}</span><small>${(p.distance * 0.0006).toFixed(1)} км</small></button>`;
    const out = list.filter((p) => p.direction === 'out');
    const inn = list.filter((p) => p.direction === 'in');
    return `${out.length ? `<h4>Куда везти</h4>${out.map(row).join('')}` : ''}${inn.length ? `<h4>Откуда везти</h4>${inn.map(row).join('')}` : ''}`;
  }

  toggleChains(): void {
    const el = this.q('[data-chains]');
    const show = el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) el.innerHTML = this.chainsHtml();
    else this.controller.highlight = [];
    this.sync();
  }

  /** Панель цепочек: для каждого груза — кто производит и кому он нужен. */
  private chainsHtml(): string {
    const g = this.game();
    const chip = (kind: string, cargo: CargoType, name: string, count: number) =>
      `<button class="ind-chip" data-action="chain-kind" data-kind="${kind}" title="Показать на карте (${count} шт.)">${cargoIcon(cargo, 18)}${esc(name)}</button>`;
    const rows = FREIGHT.map((c) => {
      const producers = producersOf(c)
        .map((t) => chip(t.kind, t.produces, t.name, g.industries.filter((i) => i.info.kind === t.kind).length))
        .join('');
      const consumers = consumersOf(c).map((t) => chip(t.kind, t.produces, t.name, g.industries.filter((i) => i.info.kind === t.kind).length));
      const towns = g.towns
        .filter((t) => t.demands.includes(c))
        .map((t) => `<button class="ind-chip town" data-action="focus" data-type="town" data-id="${t.id}">${townIcon(18)}${esc(t.name)}</button>`);
      return `<div class="chain-row"><div class="cell">${producers}</div>
        <div class="cargo-cell">${cargoIcon(c, 28)}<span>${CARGO[c].name}</span></div>
        <div class="cell">${[...consumers, ...towns].join('') || '<span class="muted">—</span>'}</div></div>`;
    }).join('');
    return `<header><h3>Цепочки производства</h3><button class="icon" data-action="chains">✕</button></header>
      <p class="muted">Слева — кто производит груз, справа — куда его везти. Сырьё нужно заводам, готовая продукция — городам.
      Клик по названию подсветит предприятия на карте.</p>
      <div class="chain-head"><span>Производит</span><span>Груз</span><span>Принимает</span></div>${rows}`;
  }

  update(realDt: number): void {
    const g = this.game();
    this.minimap.update(realDt);
    this.q('[data-money]').textContent = money(g.money);
    this.q('[data-money]').classList.toggle('negative', g.money < 0);
    const balance = g.incomeMonth - g.expensesMonth;
    const bal = this.q('[data-balance]');
    bal.textContent = `${balance >= 0 ? '+' : ''}${money(balance)}`;
    bal.classList.toggle('negative', balance < 0);
    this.q('[data-fleet]').textContent = `${g.fleet.size} / жит. ${g.citizenCars}`;
    this.q('[data-date]').textContent = g.dateLabel;
    this.q('[data-month]').style.width = `${g.monthProgress * 100}%`;

    const notices = this.q('[data-notices]');
    const key = g.notices.map((n) => n.text + Math.floor(n.age)).join('|');
    if (notices.dataset.key !== key) {
      notices.dataset.key = key;
      notices.innerHTML = g.notices
        .map((n) => `<div class="notice" style="opacity:${Math.min(1, (6 - n.age) / 1.5)};${n.color ? `border-left-color:${n.color}` : ''}">${esc(n.text)}</div>`)
        .join('');
    }
    this.panelTimer -= realDt;
    if (this.panelTimer <= 0) {
      this.panelTimer = 0.3;
      this.renderSide();
      this.renderFinance();
    }
  }

  toggleFinance(): void {
    const el = this.q('[data-finance]');
    el.classList.toggle('hidden');
    this.lastFinance = '';
    this.renderFinance();
  }

  private lastFinance = '';

  private renderFinance(): void {
    const el = this.q('[data-finance]');
    if (el.classList.contains('hidden')) return;
    const html = this.financeHtml();
    if (html !== this.lastFinance) {
      el.innerHTML = html;
      this.lastFinance = html;
    }
  }

  /**
   * Финансы: статьи доходов и расходов за этот и прошлый месяц, график за год
   * и линии от самой прибыльной до самой убыточной — чтобы сразу видеть, куда уходят деньги.
   */
  private financeHtml(): string {
    const g = this.game();
    const last = g.history[g.history.length - 1];
    const rows: { kind: keyof Ledger; name: string; sign: 1 | -1 }[] = [
      { kind: 'transport', name: 'Перевозки', sign: 1 },
      { kind: 'sales', name: 'Продажа и возврат за снос', sign: 1 },
      { kind: 'vehicles', name: 'Содержание транспорта', sign: -1 },
      { kind: 'roads', name: 'Ремонт дорог и путей', sign: -1 },
      { kind: 'build', name: 'Строительство', sign: -1 },
      { kind: 'purchases', name: 'Покупка транспорта', sign: -1 },
      { kind: 'interest', name: 'Проценты по кредиту', sign: -1 },
    ];
    const cell = (v: number | undefined, sign: number) =>
      v === undefined ? '<td class="muted">—</td>' : `<td class="${v === 0 ? 'muted' : sign > 0 ? 'pos' : 'neg'}">${v === 0 ? '0' : `${sign > 0 ? '+' : '−'}${money(v).replace('$', '$')}`}</td>`;
    const table = rows
      .map((r) => `<tr><td class="ic">${ledgerIcon(r.kind, 20)}</td><td>${r.name}</td>${cell(g.ledger[r.kind], r.sign)}${cell(last?.ledger?.[r.kind], r.sign)}</tr>`)
      .join('');
    const netNow = g.incomeMonth - g.expensesMonth;
    const netLast = last ? last.income - last.expenses : undefined;
    const total = (v: number | undefined) => (v === undefined ? '<td class="muted">—</td>' : `<td class="${v >= 0 ? 'pos' : 'neg'}"><b>${v >= 0 ? '+' : '−'}${money(Math.abs(v))}</b></td>`);
    const chart = incomeChart(g.history.slice(-12).map((m) => ({ label: m.label, income: m.income, expense: m.expenses })));
    const lines = [...g.lines.values()]
      .map((l) => ({ l, p: l.revenueLast - l.costLast }))
      .sort((a, b) => b.p - a.p)
      .map(
        ({ l, p }) => `<button class="line-row" data-action="select-line" data-id="${l.id}">${this.lineIcon(l)}<span>${esc(l.name)}</span>
          <small class="${p >= 0 ? 'pos' : 'neg'}">${p >= 0 ? '+' : '−'}${money(Math.abs(p))}</small></button>`,
      )
      .join('');
    return `<header><h3>Финансы</h3><button class="icon" data-action="finance">✕</button></header>
      <table class="ledger"><tr><th></th><th></th><th>Этот месяц</th><th>Прошлый</th></tr>${table}
        <tr class="sum"><td></td><td>Итого</td>${total(netNow)}${total(netLast)}</tr></table>
      <h4>Кредит</h4>
      <div class="loan"><div><b>${money(g.loan)}</b> <span class="muted">из ${money(ECONOMY.loanMax)} · ${Math.round(ECONOMY.loanRate * 100)}% в месяц = ${money(
        g.loan * ECONOMY.loanRate,
      )}</span></div>
        <div class="actions"><button class="small" data-action="loan-take" ${g.loan >= ECONOMY.loanMax ? 'disabled' : ''}>Взять ${money(ECONOMY.loanStep)}</button>
        <button class="small" data-action="loan-repay" ${g.loan <= 0 || g.money < Math.min(ECONOMY.loanStep, g.loan) ? 'disabled' : ''}>Погасить ${money(
          Math.min(ECONOMY.loanStep, g.loan || ECONOMY.loanStep),
        )}</button></div></div>
      <h4>За год <span class="legend"><i style="background:#3fae6a"></i>доход <i style="background:#e5534b"></i>расход</span></h4>${chart}
      <h4>Маршруты по прибыли за прошлый месяц</h4>${lines || '<p class="muted">Маршрутов пока нет.</p>'}`;
  }

  reset(): void {
    this.lastPanel = '';
    this.q('[data-chains]').classList.add('hidden');
    this.q('[data-finance]').classList.add('hidden');
    this.minimap.reset();
    this.sync(true);
  }
}
