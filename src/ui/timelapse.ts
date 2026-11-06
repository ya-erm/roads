/**
 * Проигрыватель таймлапса партии: окно поверх игры, карта рельефа и сеть игрока по кадрам (см. game/timelapse.ts)
 * с плавным переходом — новые дороги дорисовываются вдоль и недолго подсвечены, станции появляются, маршруты
 * прочерчиваются, снесённое гаснет. Дата и счётчики (деньги, маршруты, транспорт, жители) — на самом холсте, чтобы
 * попасть и в видео. Пауза, перемотка по шкале, скорость 1×/2×/3× (timelapseSpeed.ts), линии маршрутов по прямой
 * между станциями можно скрыть (запоминается в браузере); этапы и задания сценария — значками на шкале.
 * Видео — встроенным MediaRecorder (WebM; где его нет — кнопки нет), без сторонних библиотек.
 */

import './timelapse.css';
import { splitBezier, type Cubic } from '../core/bezier';
import type { Game } from '../game/game';
import { buildTimeline, recCurve, timelapseOf, TL_STEP, type Timeline, type TimelapseSource, type TlItem, type TlLayer } from '../game/timelapse';
import { ReliefRenderer, waterPath } from '../render/relief';
import { smoothPath } from '../render/renderer';
import { BIOMES } from '../world/biomes';
import { cargoImage } from './cargoIcons';
import { downloadSvg, journalSvg, playSvg } from './icons';
import { flagSvg, objectiveIcon } from './scenarioIcons';
import { timelapseSvg } from './timelapseButton';
import { counterSlots, countInt, countShort, HUD_PAD, hudLayout, moneyShort, splitDate, tabText, type HudLayout, type Measure, type TabText } from './timelapseHud';
import { playRate, TL_SPEEDS } from './timelapseSpeed';

/** Кадры на шкале не ближе стольких месяцев: стройка на паузе в первый месяц тоже успевает показаться. */
const MIN_GAP = 0.5;
/** Толщина линии маршрута (по прямой между станциями), px. */
const LINE_WIDTH = 2.4;
/** Показывать ли линии маршрутов — запоминается в браузере ('0' — скрыты). */
const LINES_KEY = 'roads.timelapseLines';
/** Сколько секунд видео стоит на первом и последнем кадре. */
const HOLD_START = 0.6;
const HOLD_END = 2;
/** Цвета этапов A, B, C. */
const PHASE_COLORS = ['#2f80ed', '#7a5cc4', '#c4662f'];
const ROAD_COLOR = '#4b525c';
/** Толщина дорог по классу (улица … магистраль), px. */
const ROAD_WIDTHS = [0.9, 1.4, 2, 2.6];
const NEW_COLOR = '#ff7a1a';
const RAIL_COLOR = '#6b4f3a';

const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const easeOutBack = (u: number) => 1 + 2.4 * (u - 1) ** 3 + 1.4 * (u - 1) ** 2;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

function pauseSvg(size = 18): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>`;
}

function againSvg(size = 18): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><path d="M12.3 6.3A4.6 4.6 0 1 0 12.6 9.6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M13.1 2.8v3.8H9.3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function recSvg(size = 18): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><rect x="1.5" y="3.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 7L14.5 4.5V11.5L10.5 9Z" fill="currentColor"/><circle cx="6" cy="8" r="2" fill="#e5534b"/></svg>`;
}

function stopSvg(size = 18): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="#e5534b"/></svg>`;
}

/** Линии маршрутов: ломаная по трём станциям; скрыты — от линии пунктир, значок перечёркнут. */
function linesSvg(on: boolean, size = 18): string {
  const path = 'M3 12.5L11 3.5L19 11';
  const stations = [
    [3, 12.5],
    [11, 3.5],
    [19, 11],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.9" fill="#fff" stroke="#1f2933" stroke-width="1.1"/>`)
    .join('');
  const line = on
    ? `<path d="${path}" stroke="#e5534b" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${path}" stroke="#9aa5b1" stroke-width="1.3" stroke-dasharray="1.6 1.8" fill="none"/>`;
  const slash = on ? '' : '<path d="M3.5 2L18.5 14.5" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M3.5 2L18.5 14.5" stroke="#55606e" stroke-width="1.7" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 22 16" width="${Math.round((size * 22) / 16)}" height="${size}">${line}${stations}${slash}</svg>`;
}

function storedLines(): boolean {
  try {
    return localStorage.getItem(LINES_KEY) !== '0';
  } catch {
    return true;
  }
}

function storeLines(on: boolean): void {
  try {
    localStorage.setItem(LINES_KEY, on ? '1' : '0');
  } catch {
    // Хранилище запрещено — просто не запомним.
  }
}

/** Значки SVG без <title>: та всплывает системной подсказкой. */
const noTitle = (svg: string) => svg.replace(/<title>[^<]*<\/title>/g, '');

/** Дата кадра (месяц партии m) — по календарю этой партии: «Мар 2003». */
function dateOf(game: Game, m: number): string {
  return game.dateAt(Math.max(0, Math.floor(m + 1e-6)));
}

/** Формат видео, который умеет браузер; null — записывать нельзя. */
function videoType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/** Переход между кадрами i и j = i + 1: что видно в обоих, что появляется, что исчезает. */
interface Slice {
  i: number;
  j: number;
  roads: Path2D[];
  fresh: Path2D[];
  rails: Path2D;
  stable: Record<TlLayer, TlItem[]>;
  appear: Record<TlLayer, TlItem[]>;
  vanish: Record<TlLayer, TlItem[]>;
}

interface Mark {
  x: number;
  html: string;
  cls: string;
  tip: string;
}

let current: TimelapsePlayer | null = null;

/** Открывает таймлапс партии; false — смотреть нечего. */
export function openTimelapse(game: Game): boolean {
  closeTimelapse();
  const src = timelapseOf(game);
  if (src.frames.length < 2) return false;
  current = new TimelapsePlayer(game, src);
  return true;
}

/** Закрывает таймлапс, если открыт (запись видео при этом отменяется). */
export function closeTimelapse(): boolean {
  if (!current) return false;
  current.destroy();
  current = null;
  return true;
}

export function timelapseOpen(): boolean {
  return current !== null;
}

class TimelapsePlayer {
  private readonly tl: Timeline;
  /** Место кадра на шкале, месяцев (кадры не ближе MIN_GAP). */
  private readonly xs: number[];
  private readonly curves = new Map<TlItem, Cubic>();
  private readonly stationPos = new Map<number, { x: number; y: number }>();
  private readonly popNow = new Map<number, number>();
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private k = 1;
  private dpr = 1;
  private t: number;
  private playing = false;
  private speed = 1;
  /** Линии маршрутов по прямой между станциями: показаны или скрыты (и в видео так же). */
  private lines = storedLines();
  private scrubbing = false;
  /** Пауза перед стартом (и в видео — на первом кадре), с. */
  private hold = 0.4;
  private slice: Slice | null = null;
  private raf = 0;
  private last = 0;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private endHold = 0;
  private readonly font: string;
  /** Раскладка плашки — одна на всю партию (timelapseHud.ts): ширины не прыгают от кадра к кадру. */
  private hud: HudLayout | null = null;
  private dateMeasure: Measure | null = null;
  private numMeasure: Measure | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onResize = () => this.layout();

  constructor(
    private readonly game: Game,
    private readonly src: TimelapseSource,
  ) {
    this.tl = buildTimeline(src.frames);
    const xs: number[] = [];
    for (const f of this.tl.frames) xs.push(xs.length ? Math.max(f.m, xs[xs.length - 1] + MIN_GAP) : f.m);
    this.xs = xs;
    this.t = xs[0];
    for (const L of ['r', 't'] as const) for (const item of this.tl.layers[L]) this.curves.set(item, recCurve(item.rec));
    for (const item of this.tl.layers.s) this.stationPos.set(item.id, { x: Number(item.rec[2]) * TL_STEP, y: Number(item.rec[3]) * TL_STEP });
    for (const town of game.towns) this.popNow.set(town.id, Math.max(1, town.population));
    this.font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';

    this.root = document.createElement('div');
    this.root.className = 'tl-screen';
    this.root.innerHTML = this.html();
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) closeTimelapse();
    });
    this.bindTrack();
    window.addEventListener('keydown', this.onKey, { capture: true });
    window.addEventListener('resize', this.onResize);
    this.layout();
    this.renderMarks();
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, { capture: true });
    window.removeEventListener('resize', this.onResize);
    if (this.recorder) {
      // Закрыли посреди записи — видео не нужно.
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      this.recorder = null;
    }
    this.root.remove();
  }

  private get end(): number {
    return this.xs[this.xs.length - 1];
  }

  /** Месяцев шкалы в секунду на выбранной скорости (timelapseSpeed.ts). */
  private get rate(): number {
    return playRate(this.end - this.xs[0], this.speed);
  }

  // ---------- Разметка ----------

  private html(): string {
    const rough = this.src.rough
      ? `<span class="tl-rough" data-tip="Начало партии — по журналу: станции и маршруты, без дорог. Дороги — с ${dateOf(this.game, this.src.recordFrom)}">${journalSvg(18)}</span>`
      : '';
    const video = videoType()
      ? `<button class="tl-btn tl-video" data-tl="video" data-tip="Записать и скачать видео таймлапса">${recSvg(18)}${downloadSvg(14)}</button>`
      : '';
    return `<div class="tl-modal">
      <button class="icon modal-close" data-tl="close" data-tip="Закрыть (Esc)" data-tip-end>✕</button>
      <div class="tl-head">${timelapseSvg(26)}<h2>Таймлапс партии</h2>${rough}</div>
      <canvas class="tl-canvas"></canvas>
      <div class="tl-controls">
        <button class="tl-btn tl-play" data-tl="play" data-tip="Пауза · пробел"></button>
        <div class="tl-speeds">${TL_SPEEDS.map((s) => `<button class="tl-btn" data-tl="speed" data-v="${s}" data-tip="Скорость ×${s}">${s}×</button>`).join('')}</div>
        <button class="tl-btn tl-lines" data-tl="lines"></button>
        <div class="tl-track" data-tl-track>
          <div class="tl-marks"></div>
          <div class="tl-rail"><div class="tl-zone"></div><div class="tl-fill"></div></div>
          <div class="tl-bands"></div>
          <div class="tl-thumb"></div>
        </div>
        ${video}
      </div>
    </div>`;
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!;
  }

  /** Место на шкале (доля от 0 до 1). */
  private frac(x: number): number {
    const span = this.end - this.xs[0];
    return span > 0 ? clamp((x - this.xs[0]) / span, 0, 1) : 0;
  }

  /** Месяц партии → место на шкале. */
  private mToX(m: number): number {
    const f = this.tl.frames;
    if (m <= f[0].m) return this.xs[0];
    for (let i = 1; i < f.length; i++) {
      if (m <= f[i].m) {
        const u = f[i].m > f[i - 1].m ? (m - f[i - 1].m) / (f[i].m - f[i - 1].m) : 1;
        return lerp(this.xs[i - 1], this.xs[i], u);
      }
    }
    return this.end;
  }

  /** Этапы сценария — полосами под шкалой, задания — значками над ней, годы — засечками. */
  private renderMarks(): void {
    const pct = (x: number) => `${(this.frac(x) * 100).toFixed(2)}%`;
    // Этапы — по кадрам: в каком этапе был каждый. Весь сценарий в одном этапе — полоса ни к чему.
    const bands: string[] = [];
    const f = this.tl.frames;
    const phases = new Set(f.map((x) => x.phase).filter((p) => p !== undefined));
    let from = phases.size > 1 ? 0 : f.length;
    for (let i = from + 1; i <= f.length; i++) {
      if (i < f.length && f[i].phase === f[from].phase) continue;
      const ph = f[from].phase;
      if (ph !== undefined) {
        const x0 = from ? (this.xs[from - 1] + this.xs[from]) / 2 : this.xs[0];
        const x1 = i < f.length ? (this.xs[i - 1] + this.xs[i]) / 2 : this.end;
        const tip = `Этап ${'ABC'[ph]}`;
        bands.push(`<div class="tl-band" style="left:${pct(x0)};width:calc(${pct(x1)} - ${pct(x0)});background:${PHASE_COLORS[ph]}" data-tip="${tip}"><b>${'ABC'[ph]}</b></div>`);
      }
      from = i;
    }
    // Годы — засечки (на длинной партии — через 5 лет).
    const years = (this.end - this.xs[0]) / 12;
    const step = years > 15 ? 5 : years > 6 ? 2 : 1;
    for (let y = Math.ceil(f[0].m / 12); y * 12 <= f[f.length - 1].m; y++) {
      if ((this.game.startYear + y) % step) continue;
      bands.push(`<i class="tl-year" style="left:${pct(this.mToX(y * 12))}">${this.game.startYear + y}</i>`);
    }
    this.q('.tl-bands').innerHTML = bands.join('');
    if (this.src.rough) this.q('.tl-zone').style.width = pct(this.mToX(this.src.recordFrom));

    const marks: Mark[] = [];
    const sc = this.game.scenario?.state;
    if (sc) {
      for (const o of sc.objectives) {
        if ((o.status !== 'done' && o.status !== 'failed') || o.closedAt === undefined) continue;
        const done = o.status === 'done';
        marks.push({
          x: this.mToX(o.closedAt + 0.5),
          html: `${noTitle(objectiveIcon(o, 16))}<i>${done ? '✓' : '✗'}</i>`,
          cls: done ? 'done' : 'failed',
          tip: `${done ? 'Выполнено' : 'Провалено'}: ${o.title}`,
        });
      }
      if (sc.status !== 'running') {
        const won = sc.status === 'won';
        const at = [...sc.log].reverse().find((e) => (won ? e.kind === 'phase' : e.kind === 'failed'));
        marks.push({
          x: at ? this.mToX(at.month + 0.5) : this.end,
          html: won ? noTitle(flagSvg(16)) : '<i class="tl-lost">✗</i>',
          cls: won ? 'won' : 'lost',
          tip: won ? 'Сценарий пройден' : `Сценарий провален${sc.lostReason ? `: ${sc.lostReason}` : ''}`,
        });
      }
    }
    // Значки рядом — во второй ряд, чтобы не слипались.
    marks.sort((a, b) => a.x - b.x);
    const rows = [-Infinity, -Infinity];
    const gap = (this.end - this.xs[0]) * 0.025;
    const html = marks.map((m) => {
      const row = m.x - rows[0] >= gap ? 0 : m.x - rows[1] >= gap ? 1 : 0;
      rows[row] = m.x;
      return `<span class="tl-mark ${m.cls} row${row}" style="left:${pct(m.x)}" data-tip="${m.tip.replace(/"/g, '&quot;')}">${m.html}</span>`;
    });
    this.q('.tl-marks').innerHTML = html.join('');
    this.q('.tl-track').classList.toggle('with-marks', marks.length > 0);
    this.q('.tl-track').classList.toggle('with-bands', bands.length > 0);
  }

  /** Размер холста под окно: карта целиком, по пропорциям мира. */
  private layout(): void {
    const t = this.game.terrain;
    const aspect = t.height / t.width;
    const availW = Math.min(window.innerWidth * 0.94, 1240) - 40;
    const availH = window.innerHeight * 0.94 - 150;
    const w = Math.max(240, Math.floor(Math.min(availW, availH / aspect)));
    const h = Math.round(w * aspect);
    this.dpr = window.devicePixelRatio || 1;
    if (w === this.w && h === this.h && this.bg) return;
    this.w = w;
    this.h = h;
    this.k = w / t.width;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.q('.tl-controls').style.width = `${w}px`;
    this.bg = this.background();
  }

  /** Фон: рельеф, лес и вода — как на миникарте, только крупнее. */
  private background(): HTMLCanvasElement {
    const g = this.game;
    const t = g.terrain;
    const { w, h, k, dpr } = this;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const pal = BIOMES[t.biome].palette;
    ctx.fillStyle = pal.grass;
    ctx.fillRect(0, 0, w, h);
    if (t.hasRelief) {
      ctx.save();
      ctx.scale(k, k);
      new ReliefRenderer().drawGround(ctx, t, { x0: 0, y0: 0, x1: t.width, y1: t.height });
      ctx.restore();
    }
    ctx.fillStyle = pal.trees[3] + '50';
    const dot = Math.max(1, k * 14);
    for (const tree of t.trees) ctx.fillRect(tree.pos.x * k - dot / 2, tree.pos.y * k - dot / 2, dot, dot);
    ctx.fillStyle = '#8cc3e6';
    ctx.strokeStyle = '#8cc3e6';
    ctx.lineCap = 'round';
    const shaped = waterPath(t);
    if (shaped) {
      ctx.save();
      ctx.scale(k, k);
      ctx.fill(shaped, 'evenodd');
      ctx.restore();
    } else {
      for (const r of t.rivers) {
        ctx.lineWidth = Math.max(1.5, r.width * k);
        ctx.beginPath();
        smoothPath(ctx, r.points, k);
        ctx.stroke();
      }
      for (const lake of t.lakes) {
        ctx.beginPath();
        ctx.arc(lake.center.x * k, lake.center.y * k, lake.radius * k, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return c;
  }

  // ---------- Управление ----------

  private click(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tl]');
    if (!el) return;
    switch (el.dataset.tl) {
      case 'close':
        closeTimelapse();
        break;
      case 'play':
        this.toggle();
        break;
      case 'speed':
        this.speed = Number(el.dataset.v) || 1;
        break;
      case 'lines':
        this.toggleLines();
        break;
      case 'video':
        if (this.recorder) this.stopRecording();
        else this.startRecording();
        break;
    }
  }

  private toggle(): void {
    if (this.recorder) return;
    if (!this.playing && this.t >= this.end - 1e-6) this.t = this.xs[0];
    this.playing = !this.playing;
    this.hold = 0;
  }

  /** Скрыть или показать линии маршрутов (во время записи — нельзя: видео пишется как выбрано). */
  private toggleLines(): void {
    if (this.recorder) return;
    this.lines = !this.lines;
    storeLines(this.lines);
  }

  /** Перемотка по шкале: нажать и тянуть. */
  private bindTrack(): void {
    const track = this.q('[data-tl-track]');
    const seek = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const u = clamp((e.clientX - r.left) / r.width, 0, 1);
      this.t = lerp(this.xs[0], this.end, u);
    };
    track.addEventListener('pointerdown', (e) => {
      if (this.recorder) return;
      this.scrubbing = true;
      track.setPointerCapture(e.pointerId);
      seek(e);
    });
    track.addEventListener('pointermove', (e) => this.scrubbing && seek(e));
    const up = () => (this.scrubbing = false);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  }

  /** Пробел — пауза, стрелки — на кадр, Home/End — в начало и конец, L — линии маршрутов. Остальное до карты не доходит. */
  private key(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      closeTimelapse();
    } else if (this.recorder) {
      // Во время записи — только Esc (отменить).
    } else if (e.code === 'Space') {
      this.toggle();
    } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      // На кадр вперёд или назад от того места, где сейчас.
      this.playing = false;
      const xs = this.xs;
      this.t =
        e.code === 'ArrowRight'
          ? (xs.find((x) => x > this.t + 1e-6) ?? this.end)
          : ([...xs].reverse().find((x) => x < this.t - 1e-6) ?? xs[0]);
    } else if (e.code === 'Home') {
      this.t = this.xs[0];
    } else if (e.code === 'End') {
      this.t = this.end;
    } else if (e.code === 'KeyL' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.toggleLines();
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ---------- Видео ----------

  private startRecording(): void {
    const type = videoType();
    if (!type) return;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(this.canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 8_000_000 });
    } catch {
      return;
    }
    this.chunks = [];
    rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    rec.onstop = () => this.saveVideo(type);
    this.recorder = rec;
    this.t = this.xs[0];
    this.hold = HOLD_START;
    this.endHold = HOLD_END;
    this.playing = true;
    this.root.classList.add('recording');
    rec.start(500);
  }

  private stopRecording(): void {
    const rec = this.recorder;
    if (!rec) return;
    this.root.classList.remove('recording');
    this.playing = false;
    if (rec.state !== 'inactive') rec.stop();
  }

  private saveVideo(type: string): void {
    this.recorder = null;
    if (!this.chunks.length) return;
    const blob = new Blob(this.chunks, { type: type.split(';')[0] });
    this.chunks = [];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `razvyazka-timelapse-${this.game.settings.seed}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  // ---------- Кадр ----------

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.playing && !this.scrubbing) {
      if (this.hold > 0) this.hold -= dt;
      else this.t = Math.min(this.end, this.t + dt * this.rate);
      if (this.t >= this.end) {
        if (this.recorder) {
          this.endHold -= dt;
          if (this.endHold <= 0) this.stopRecording();
        } else this.playing = false;
      }
    }
    this.draw();
    this.syncControls();
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }

  private syncControls(): void {
    const play = this.q('.tl-play');
    const atEnd = this.t >= this.end - 1e-6;
    const state = this.playing ? 'pause' : atEnd ? 'again' : 'play';
    if (play.dataset.state !== state) {
      play.dataset.state = state;
      play.innerHTML = state === 'pause' ? pauseSvg() : state === 'again' ? againSvg() : playSvg();
      play.dataset.tip = state === 'pause' ? 'Пауза · пробел' : state === 'again' ? 'Сначала · пробел' : 'Смотреть · пробел';
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-tl="speed"]')) b.classList.toggle('active', Number(b.dataset.v) === this.speed);
    const lines = this.q('.tl-lines');
    const shown = this.lines ? 'on' : 'off';
    if (lines.dataset.state !== shown) {
      lines.dataset.state = shown;
      lines.innerHTML = linesSvg(this.lines);
      lines.classList.toggle('off', !this.lines);
      lines.setAttribute('aria-pressed', String(this.lines));
      lines.dataset.tip = this.lines ? 'Скрыть линии маршрутов · L' : 'Показать линии маршрутов · L';
    }
    const video = this.root.querySelector<HTMLElement>('.tl-video');
    if (video) {
      const rec = this.recorder ? 'rec' : 'idle';
      if (video.dataset.state !== rec) {
        video.dataset.state = rec;
        video.innerHTML = this.recorder ? stopSvg() : `${recSvg(18)}${downloadSvg(14)}`;
        video.dataset.tip = this.recorder ? 'Остановить запись и скачать видео' : 'Записать и скачать видео таймлапса';
      }
    }
    const p = `${(this.frac(this.t) * 100).toFixed(2)}%`;
    this.q('.tl-fill').style.width = p;
    this.q('.tl-thumb').style.left = p;
  }

  /** Кадр i до места t и доля перехода к следующему. */
  private at(t: number): { i: number; u: number } {
    const xs = this.xs;
    let lo = 0;
    let hi = xs.length - 1;
    if (t >= xs[hi]) return { i: hi, u: 0 };
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= t) lo = mid;
      else hi = mid;
    }
    return { i: lo, u: clamp((t - xs[lo]) / (xs[lo + 1] - xs[lo]), 0, 1) };
  }

  /** Что видно на переходе i → i + 1 (кэш: пересчёт, только когда кадр сменился). */
  private sliceAt(i: number): Slice {
    if (this.slice?.i === i) return this.slice;
    const j = Math.min(i + 1, this.xs.length - 1);
    const empty = () => ({ r: [], t: [], s: [], l: [] }) as Record<TlLayer, TlItem[]>;
    const stable = empty();
    const appear = empty();
    const vanish = empty();
    const roads = ROAD_WIDTHS.map(() => new Path2D());
    const fresh = ROAD_WIDTHS.map(() => new Path2D());
    const rails = new Path2D();
    for (const L of ['r', 't', 's', 'l'] as const) {
      for (const item of this.tl.layers[L]) {
        if (j > i && item.from === j) appear[L].push(item);
        else if (j > i && item.from <= i && item.to === j) vanish[L].push(item);
        if (!(item.from <= i && item.to > j)) continue;
        stable[L].push(item);
        if (L !== 'r' && L !== 't') continue;
        const c = this.curves.get(item)!;
        if (L === 't') this.addCurve(rails, c);
        else {
          const cls = clamp(Number(item.rec[1]) || 0, 0, ROAD_WIDTHS.length - 1);
          this.addCurve(roads[cls], c);
          // Построено к этому кадру — ещё подсвечено, гаснет за переход.
          if (i > 0 && item.from === i) this.addCurve(fresh[cls], c);
        }
      }
    }
    this.slice = { i, j, roads, fresh, rails, stable, appear, vanish };
    return this.slice;
  }

  private addCurve(path: Path2D, c: Cubic): void {
    path.moveTo(c.p0.x, c.p0.y);
    path.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
  }

  private draw(): void {
    const { ctx, k, w, h, dpr } = this;
    if (!this.bg) return;
    const { i, u } = this.at(this.t);
    const s = this.sliceAt(i);
    const f0 = this.tl.frames[i];
    const f1 = this.tl.frames[s.j];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0, w, h);

    // Города — пятном по числу жителей (от нынешнего размера).
    const g = this.game;
    ctx.fillStyle = 'rgba(85, 96, 110, 0.2)';
    for (const town of g.towns) {
      const pop = lerp(f0.pops.get(town.id) ?? town.population, f1.pops.get(town.id) ?? town.population, u);
      const r = town.radius * k * clamp(Math.sqrt(pop / this.popNow.get(town.id)!), 0.3, 1.3);
      ctx.beginPath();
      ctx.arc(town.center.x * k, town.center.y * k, Math.max(3, r), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const px = 1 / k;
    // Дороги: стоящие, новые (дорисовываются вдоль) и снесённые (гаснут).
    ctx.strokeStyle = ROAD_COLOR;
    s.roads.forEach((p, cls) => {
      ctx.lineWidth = ROAD_WIDTHS[cls] * px;
      ctx.stroke(p);
    });
    ctx.globalAlpha = 1 - u;
    ctx.strokeStyle = NEW_COLOR;
    s.fresh.forEach((p, cls) => {
      ctx.lineWidth = (ROAD_WIDTHS[cls] + 0.8) * px;
      ctx.stroke(p);
    });
    this.strokeChanging(s, 'r', u);
    // Ж/д пути — тёмные с белыми шпалами.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = RAIL_COLOR;
    ctx.lineWidth = 2 * px;
    ctx.stroke(s.rails);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 0.7 * px;
    ctx.setLineDash([2.5 * px, 2.5 * px]);
    ctx.stroke(s.rails);
    ctx.setLineDash([]);
    this.strokeChanging(s, 't', u);

    // Маршруты — цветной линией по остановкам (если не скрыты); новый прочерчивается.
    if (this.lines) {
      ctx.lineWidth = LINE_WIDTH * px;
      for (const item of s.stable.l) this.drawLine(item, 1, 1);
      for (const item of s.appear.l) this.drawLine(item, ease(u), Math.min(1, u * 2));
      for (const item of s.vanish.l) this.drawLine(item, 1, 1 - u);
    }

    // Станции.
    for (const item of s.stable.s) this.drawStation(item, 1, 1, px);
    for (const item of s.appear.s) this.drawStation(item, Math.max(0, easeOutBack(u)), Math.min(1, u * 3), px);
    for (const item of s.vanish.s) this.drawStation(item, 1, 1 - u, px);
    ctx.restore();
    ctx.globalAlpha = 1;

    // Предприятия — значком груза, как на миникарте.
    const icon = clamp(k * 90, 8, 14);
    for (const ind of g.industries) {
      const img = cargoImage(ind.info.produces);
      if (img.complete) ctx.drawImage(img, ind.fp.center.x * k - icon / 2, ind.fp.center.y * k - icon / 2, icon, icon);
    }
    // Названия городов.
    ctx.font = `600 11px ${this.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = '#1f2933';
    for (const town of g.towns) {
      const x = town.center.x * k;
      const y = town.center.y * k - Math.max(8, town.radius * k * 0.6);
      ctx.strokeText(town.name, x, y);
      ctx.fillText(town.name, x, y);
    }
    this.drawHud(f0, f1, u, s);
  }

  /** Новые полотна (дороги или пути) — дорисовываются вдоль, снесённые — гаснут. */
  private strokeChanging(s: Slice, L: 'r' | 't', u: number): void {
    const ctx = this.ctx;
    const px = 1 / this.k;
    const width = (item: TlItem) => (L === 't' ? 2 : ROAD_WIDTHS[clamp(Number(item.rec[1]) || 0, 0, ROAD_WIDTHS.length - 1)]);
    const e = ease(u);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = L === 't' ? RAIL_COLOR : NEW_COLOR;
    for (const item of s.appear[L]) {
      if (e <= 0) break;
      const c = e >= 1 ? this.curves.get(item)! : splitBezier(this.curves.get(item)!, e)[0];
      ctx.lineWidth = (width(item) + (L === 'r' ? 0.8 : 0)) * px;
      ctx.beginPath();
      ctx.moveTo(c.p0.x, c.p0.y);
      ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1 - u;
    ctx.strokeStyle = L === 't' ? RAIL_COLOR : '#a05a52';
    for (const item of s.vanish[L]) {
      const c = this.curves.get(item)!;
      ctx.lineWidth = width(item) * px;
      ctx.beginPath();
      ctx.moveTo(c.p0.x, c.p0.y);
      ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Маршрут по остановкам: part — какая доля длины прочерчена. */
  private drawLine(item: TlItem, part: number, alpha: number): void {
    if (part <= 0 || alpha <= 0) return;
    const pts = item.rec.slice(3).map((id) => this.stationPos.get(Number(id))).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length < 2) return;
    const ctx = this.ctx;
    let total = 0;
    for (let n = 1; n < pts.length; n++) total += Math.hypot(pts[n].x - pts[n - 1].x, pts[n].y - pts[n - 1].y);
    let left = total * part;
    ctx.globalAlpha = 0.9 * alpha;
    ctx.strokeStyle = String(item.rec[1]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let n = 1; n < pts.length && left > 0; n++) {
      const a = pts[n - 1];
      const b = pts[n];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const v = d > 0 ? Math.min(1, left / d) : 1;
      ctx.lineTo(lerp(a.x, b.x, v), lerp(a.y, b.y, v));
      left -= d;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Станция: автостанция — кружок, остановка — кружок поменьше, вокзал — квадрат, грузовой двор — серый квадрат. */
  private drawStation(item: TlItem, scale: number, alpha: number, px: number): void {
    if (scale <= 0 || alpha <= 0) return;
    const ctx = this.ctx;
    const x = Number(item.rec[2]) * TL_STEP;
    const y = Number(item.rec[3]) * TL_STEP;
    const kind = Number(item.rec[1]);
    const yard = Number(item.rec[4]) === 1;
    const r = (kind === 1 ? 2.7 : 3.6) * scale * px;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.2 * px;
    ctx.strokeStyle = '#1f2933';
    ctx.fillStyle = yard ? '#d7dde3' : '#fff';
    ctx.beginPath();
    if (kind === 2 || yard) ctx.rect(x - r, y - r, r * 2, r * 2);
    else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---------- Дата и счётчики ----------

  private drawHud(f0: Timeline['frames'][number], f1: Timeline['frames'][number], u: number, s: Slice): void {
    const ctx = this.ctx;
    const m = lerp(f0.m, f1.m, u);
    const money = lerp(f0.money, f1.money, u);
    const vehicles = Math.round(lerp(f0.vehicles, f1.vehicles, u));
    const sum = (f: typeof f0) => [...f.pops.values()].reduce((a, b) => a + b, 0);
    const pop = lerp(sum(f0), sum(f1), u);
    const lines = s.stable.l.length + (u >= 0.5 ? s.appear.l.length : s.vanish.l.length);
    const phase = u >= 0.5 ? f1.phase : f0.phase;

    // Ячейки фиксированной ширины на всю партию, цифры табличные — ничего не прыгает и в видео.
    const L = (this.hud ??= this.hudLayout());
    const items: [(x: number, y: number) => void, string][] = [
      [(x, y) => this.coinIcon(x, y), moneyShort(money)],
      [(x, y) => this.routeIcon(x, y), countInt(lines)],
      [(x, y) => this.busIcon(x, y), countInt(vehicles)],
      [(x, y) => this.personIcon(x, y), countShort(pop)],
    ];
    const x0 = 12;
    const y0 = 12;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.roundRect(x0, y0, L.boxW, 62, 12);
    ctx.fill();
    ctx.font = this.dateFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f2933';
    // Месяц слева, год — всегда на одном месте за самым длинным месяцем.
    const [month, year] = splitDate(dateOf(this.game, m));
    ctx.fillText(month, x0 + HUD_PAD, y0 + 20);
    this.fillTab(tabText(year, this.dateMeasure!, L.dateDigit), x0 + HUD_PAD + L.yearX, y0 + 20);
    if (phase !== undefined) {
      const cx = x0 + HUD_PAD + L.dateW + 16;
      ctx.fillStyle = PHASE_COLORS[phase];
      ctx.beginPath();
      ctx.arc(cx, y0 + 20, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `800 12px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.fillText('ABC'[phase], cx, y0 + 20.5);
      ctx.textAlign = 'left';
    }
    ctx.font = this.numFont;
    // Число — вплотную к значку (по левому краю ячейки); запас под длинные числа — справа, значки на месте.
    const slots = counterSlots(L.cells);
    items.forEach(([icon, text], n) => {
      icon(x0 + HUD_PAD + slots[n].icon, y0 + 45);
      ctx.fillStyle = '#1f2933';
      this.fillTab(tabText(text, this.numMeasure!, L.numDigit), x0 + HUD_PAD + slots[n].text, y0 + 45.5);
    });
    // Подпись игры — в углу (видно и в видео).
    ctx.font = `700 12px ${this.font}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.fillStyle = 'rgba(31,41,51,0.7)';
    ctx.strokeText('Дороги региона', this.w - 10, this.h - 10);
    ctx.fillText('Дороги региона', this.w - 10, this.h - 10);
  }

  private get dateFont(): string {
    return `800 20px ${this.font}`;
  }

  private get numFont(): string {
    return `700 13px ${this.font}`;
  }

  /** Ширина строки шрифтом font — с запоминанием (плашка рисуется каждый кадр). */
  private measurer(font: string): Measure {
    const cache = new Map<string, number>();
    return (text) => {
      let w = cache.get(text);
      if (w === undefined) {
        const prev = this.ctx.font;
        this.ctx.font = font;
        w = this.ctx.measureText(text).width;
        this.ctx.font = prev;
        cache.set(text, w);
      }
      return w;
    };
  }

  /** Раскладка плашки на всю партию: ячейки под самые длинные дату и числа по всем кадрам (и между ними). */
  private hudLayout(): HudLayout {
    const f = this.tl.frames;
    const lines = f.map((_, n) => this.tl.layers.l.filter((it) => it.from <= n && it.to > n).length);
    const pop = f.map((fr) => [...fr.pops.values()].reduce((a, b) => a + b, 0));
    const dates: string[] = [];
    for (let m = Math.floor(f[0].m); m <= Math.floor(f[f.length - 1].m + 1e-6); m++) dates.push(dateOf(this.game, m));
    this.dateMeasure = this.measurer(this.dateFont);
    this.numMeasure = this.measurer(this.numFont);
    const columns = [
      { values: f.map((fr) => fr.money), format: moneyShort },
      { values: lines, format: countInt },
      { values: f.map((fr) => fr.vehicles), format: countInt },
      { values: pop, format: countShort },
    ];
    return hudLayout({ dates, columns, phase: f.some((fr) => fr.phase !== undefined) }, this.dateMeasure, this.numMeasure);
  }

  /** Текст по кускам (табличные цифры — timelapseHud.ts), x — левый край. */
  private fillTab(t: TabText, x: number, y: number): void {
    for (const p of t.parts) this.ctx.fillText(p.text, x + p.x, y);
  }

  private coinIcon(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#e2a93b';
    ctx.beginPath();
    ctx.arc(x + 7, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `800 10px ${this.font}`;
    ctx.textAlign = 'center';
    ctx.fillText('$', x + 7, y + 0.5);
    ctx.textAlign = 'left';
    ctx.font = `700 13px ${this.font}`;
  }

  private routeIcon(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#e5534b';
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 4);
    ctx.lineTo(x + 7, y - 3);
    ctx.lineTo(x + 12, y + 2);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1f2933';
    ctx.lineWidth = 1.2;
    for (const [px, py] of [
      [2, 4],
      [7, -3],
      [12, 2],
    ]) {
      ctx.beginPath();
      ctx.arc(x + px, y + py, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private busIcon(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.roundRect(x, y - 6, 14, 10, 2.5);
    ctx.fill();
    ctx.fillStyle = '#dbe8fb';
    ctx.fillRect(x + 2, y - 4, 4, 3.5);
    ctx.fillRect(x + 7.5, y - 4, 4.5, 3.5);
    ctx.fillStyle = '#1f2933';
    for (const wx of [3.5, 10.5]) {
      ctx.beginPath();
      ctx.arc(x + wx, y + 4.5, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private personIcon(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#55606e';
    ctx.beginPath();
    ctx.arc(x + 7, y - 3.5, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + 7, y + 5, 5.5, 4.5, 0, Math.PI, 0);
    ctx.fill();
  }
}
