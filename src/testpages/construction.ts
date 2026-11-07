import type { Vec } from '../core/vec';
import { emptyLedger, Game } from '../game/game';
import { anchorOf, type End, roadPlan, STREET, withoutCitizens } from '../game/testkit';
import { profileOf, RoadTools } from '../input/roadtools';
import type { RoadOptions } from '../lanes/edit';
import type { Town } from '../world/entities';
import type { RoadSpec } from '../world/roadTypes';
import { TERRAIN_VERSION } from '../world/settings';
import type { TestScene } from './index';

/** Проект сцены: подпись на карте, номер проекта стройки (null — не заложился) и его база. */
export interface SceneProject {
  key: string;
  name: string;
  project: number | null;
  base: number | null;
}

export interface ConstructionScene extends TestScene {
  projects: SceneProject[];
}

const SPECS = {
  street: { cls: 'street', lanesF: 1, lanesB: 1 },
  avenue: { cls: 'avenue', lanesF: 2, lanesB: 2 },
  highway: { cls: 'highway', lanesF: 1, lanesB: 1 },
  motorway: { cls: 'motorway', lanesF: 2, lanesB: 2 },
} satisfies Record<string, RoadSpec>;

/**
 * Ряды и столбцы сцены (y и x начала проекта): два ряда во всю ширину, река течёт с севера на юг у восточного края.
 * Углы экрана справа (маршруты, мини-карта) — выше и ниже рядов; базы и проекты — на вкладке «Стройка» левой панели.
 */
const ROW = [1400, 1850];
const COL = [1500, 2150, 2800, 3450];
const RIVER_X = 4100;
/** Длина обычного проекта, м; подъезд к нему с базой — с севера, столько метров. */
const LEN = 450;
const ACCESS = 160;

/**
 * Тестовая сцена «Стройка» (/test/construction): партия «Со строительством» на ровной площадке с рекой, холмом и
 * горой. У каждого проекта — своя строительная база с бригадой в конце готового подъезда с севера: бригада
 * сама едет по подъезду к началу проекта и строит, видно колонну техники и этапы 🟫 отсыпка → ⬛ покрытие → ⬜
 * разметка, участок открывается после разметки. Проекты нарисованы как игроком — инструментом «Дорога» в «Авто»
 * (мост, тоннель, насыпь и выемка — по рельефу):
 *  - верхний ряд: улица 1+1, проспект 2+2, автомагистраль 2+2 — на ровном, и улица через холм (выемка и насыпь);
 *  - нижний: улица, которую режут две готовые поперечные улицы (три участка), магистраль 1+1 тоннелем через гору,
 *    проспект мостом через реку.
 * Путь ж/д проектом пока не строится (он готов сразу) — его в сцене нет. Сцена заново — перезагрузить страницу.
 * Экран: y вниз, проекты идут с запада на восток.
 */
export function buildConstructionScene(): ConstructionScene {
  const game = withoutCitizens(
    new Game({
      seed: 1,
      size: 'small',
      towns: 0,
      industries: 'few',
      money: 1_000_000_000,
      water: 'dry',
      relief: 'plains',
      construction: 'build',
      terrainVersion: TERRAIN_VERSION,
    }),
  );
  shapeLand(game);
  const sc = new SceneBuilder(game);

  // ---------- Верхний ряд: дороги разных классов на ровном и улица через холм ----------
  sc.project('street', 'Улица 1+1', { x: COL[0], y: ROW[0] }, LEN, SPECS.street);
  sc.project('avenue', 'Проспект 2+2', { x: COL[1], y: ROW[0] }, LEN, SPECS.avenue);
  sc.project('motorway', 'Автомагистраль 2+2', { x: COL[2], y: ROW[0] }, LEN + 50, SPECS.motorway);
  sc.project('hill', 'Через холм: выемка и насыпь', { x: COL[3], y: ROW[0] }, LEN, SPECS.street);

  // ---------- Нижний ряд: участки между перекрёстками, тоннель и мост ----------
  const cut = { x: COL[1], y: ROW[1] };
  // Готовые поперечные улицы: проект пересечёт их — перекрёстки разрежут его на три участка.
  for (const dx of [250, 500]) sc.finished({ free: { x: cut.x + dx, y: cut.y - 130 } }, { free: { x: cut.x + dx, y: cut.y + 130 } }, STREET);
  sc.project('junctions', 'Три участка между перекрёстками', cut, 750, SPECS.street);
  sc.project('tunnel', 'Тоннель через гору', { x: TUNNEL_X, y: ROW[1] }, LEN + 50, SPECS.highway);
  // Мост — уровнями узлов, как «Мост» в инструменте: пандус 120 м, пролёт над рекой на высоте моста, пандус вниз.
  // («Авто» узкую реку переходит полотном на земле с узлами на берегах — стройке это обычная дорога, не мост.)
  const bridgeLen = 660;
  const bridge = [70, 190, 470, 590].map((s, i) => ({ at: s / bridgeLen, level: i === 0 || i === 3 ? 0 : 1 }));
  sc.project('bridge', 'Мост через реку', { x: RIVER_X - 330, y: ROW[1] }, bridgeLen, SPECS.avenue, bridge);
  // Путь ж/д проектом пока не строится (кладётся сразу, docs/DESIGN.md — «путеукладчик» в планах): его здесь нет.

  // Стройка сцены — не расходы игрока: месяц начинается с чистого счёта.
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  return { game, view: sc.view(), lines: {}, errors: sc.errors, projects: sc.projects };
}

/** Начало тоннеля: за участками между перекрёстками. */
const TUNNEL_X = COL[2] + 300;
/** Холм под выемку и насыпь: на правой верхней улице, на полпути. */
const HILL = { x: COL[3] + 230, y: ROW[0], r: 190, h: 25 };
/** Гора под тоннель: на нижней магистрали, посередине. */
const MOUNTAIN = { x: TUNNEL_X + 250, y: ROW[1], r: 230, h: 48 };

/**
 * Местность сцены: без лесов и предприятий, площадка выровнена чуть выше воды, поперёк неё с севера на юг — река
 * (своя, а не по seed: иначе она могла бы пройти через любой проект), на ней — холм и гора. Правки рельефа — кистью
 * «Рельеф», как у игрока.
 */
function shapeLand(game: Game): void {
  const t = game.terrain;
  t.trees.length = 0;
  t.extraForests.length = 0;
  for (const ind of game.industries) game.index.remove(ind);
  game.industries = [];
  t.lakes.length = 0;
  t.rivers.length = 0;
  t.rivers.push({
    points: [
      { x: RIVER_X + 30, y: -100 },
      { x: RIVER_X - 10, y: 1000 },
      { x: RIVER_X + 15, y: ROW[0] },
      { x: RIVER_X, y: ROW[1] },
      { x: RIVER_X - 20, y: t.height + 100 },
    ],
    width: 60,
  });
  // Сетка высот и вода — заново, уже с этой рекой (то же делает clearWater для пустой карты).
  (t as unknown as { buildHeightGrid(): void }).buildHeightGrid();
  const cx = (COL[0] + RIVER_X + 330) / 2;
  const cy = (ROW[0] + ROW[1]) / 2;
  // pad: в полную силу до 0.8 радиуса и плавно к краю, а у воды — слабее (берег не обрывается).
  t.terraform({ x: cx, y: cy, r: 2400, mode: 'flatten', amount: 4, target: t.waterLevel + 3, pad: 0.8 });
  t.terraform({ x: HILL.x, y: HILL.y, r: HILL.r, mode: 'raise', amount: HILL.h });
  t.terraform({ x: MOUNTAIN.x, y: MOUNTAIN.y, r: MOUNTAIN.r, mode: 'raise', amount: MOUNTAIN.h });
  t.version++;
}

const where = (p: Vec) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

/** Строит сцену теми же действиями, что и игрок: готовые подъезды, базы у них и проекты инструментом «Дорога». */
class SceneBuilder {
  readonly errors: string[] = [];
  readonly projects: SceneProject[] = [];

  constructor(readonly game: Game) {}

  /** Готовая дорога сразу (без проекта) — подъезд или поперечная улица. */
  finished(a: End, b: End, profile: RoadOptions): void {
    const plan = roadPlan(this.game, a, b, profile);
    if (!plan.ok || !this.game.roadBuilder.apply(plan)) throw new Error(`подъезд: ${plan.reason ?? 'не построился'}`);
  }

  /**
   * Проект name с запада на восток от start длиной len: с севера к его началу — готовый подъезд, у его северного
   * конца — база с бригадой; проект рисуется от тупика подъезда инструментом «Дорога» в «Авто». Подпись — «город»
   * без домов над проектом (по нему же называется база). Что-то не построилось — ошибка в errors, остальное строится.
   */
  project(key: string, name: string, start: Vec, len: number, spec: RoadSpec, levels?: RoadOptions['levels']): void {
    const game = this.game;
    const entry: SceneProject = { key, name, project: null, base: null };
    this.projects.push(entry);
    const end = { x: start.x + len, y: start.y };
    const gate = { x: start.x, y: start.y - ACCESS };
    this.label(name, { x: start.x + len / 2, y: start.y }, gate.y - 30);
    try {
      this.finished({ free: gate }, { free: start }, STREET);
      // База — к западу от подъезда, у его северного конца: ворота — тупик подъезда, бригада едет по нему.
      const bases = new Set(game.construction.crews.bases.keys());
      const err = game.buildBase({ x: gate.x - 40, y: gate.y + 30 });
      if (err) throw new Error(`база у ${where(gate)}: ${err}`);
      entry.base = [...game.construction.crews.bases.keys()].find((id) => !bases.has(id)) ?? null;
      // На плашке базы — имя её проекта (по ближайшей подписи соседняя база могла бы назваться чужим).
      if (entry.base !== null) game.renameBase(entry.base, name);
      const id = game.construction.peekId();
      const why = levels ? this.leveled(start, end, spec, levels) : this.drawn(start, end, spec);
      if (why) throw new Error(`проект ${where(start)} → ${where(end)}: ${why}`);
      if (!game.construction.projects.has(id)) throw new Error('проект не заложился');
      entry.project = id;
    } catch (e) {
      this.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Проект прямой от тупика start до end — инструментом «Дорога» в «Авто», как игрок: причина, если не вышло. */
  private drawn(start: Vec, end: Vec, spec: RoadSpec): string | null {
    const tools = new RoadTools(() => this.game);
    tools.begin(start, 14);
    return tools.build(end, spec, 'straight', 14, false, true);
  }

  /** Проект с заданными сменами высоты по пути (мост, тоннель уровнями узлов): причина, если не вышло. */
  private leveled(start: Vec, end: Vec, spec: RoadSpec, levels: NonNullable<RoadOptions['levels']>): string | null {
    const game = this.game;
    const plan = game.roadBuilder.road(anchorOf(game, start), anchorOf(game, { free: end }), { ...profileOf(spec), kink: true, levels }, { project: true });
    if (!plan.ok) return plan.reason ?? 'не построился';
    return game.roadBuilder.apply(plan) ? null : 'не построился';
  }

  /** Подпись участка: «город» без жителей — только имя на карте, сам не растёт и улиц не прокладывает. */
  private label(name: string, center: Vec, top: number): void {
    const town: Town = {
      id: this.game.towns.length + 1,
      name,
      center,
      radius: 250,
      top,
      style: 'linear',
      population: 0,
      buildings: [],
      streets: [],
      demands: [],
      supplied: {},
      lastSupplied: {},
      tripAcc: 0,
      growthAcc: 0,
      autoStreets: false,
      labelOnly: true,
    };
    this.game.towns.push(town);
  }

  /** Рамка всей сцены: дороги, проекты и базы; сверху — место под подписи. */
  view(): TestScene['view'] {
    const pts = [...this.game.roads.net.nodes.values()].map((n) => n.pos);
    for (const b of this.game.construction.crews.bases.values()) pts.push(b.fp.center);
    if (!pts.length) return { x0: 0, y0: 0, x1: this.game.terrain.width, y1: this.game.terrain.height };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 50;
    return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad - 50, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
  }
}
