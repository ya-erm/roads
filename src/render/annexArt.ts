import { ANNEX } from '../config';
import type { IndustryKind } from '../world/cargo';
import type { Annex, Industry } from '../world/entities';
import { Art, type ArtLayer, BARK, boat, DARK, disc, hash, herd, industryGround, METAL, paintScene, shade, YELLOW } from './industryArt';

/**
 * Пристройки предприятий — свои вспомогательные здания, а не уменьшенная копия предприятия: у фермы — зерносушилка,
 * теплицы или машинный двор, у шахты — обогатительная фабрика или вентиляционный ствол, у завода — цех или склад.
 * Рисуются теми же примитивами, что и предприятия (industryArt: земля → общая тень → постройки), в цветах предприятия.
 * Вид пристройки — по группе предприятия; несколько пристроек одного предприятия не повторяют друг друга.
 */

/** Вид пристройки. */
export type AnnexVariant =
  | 'granary'
  | 'machineyard'
  | 'greenhouse'
  | 'cellar'
  | 'cowshed'
  | 'haybarn'
  | 'paddock'
  | 'logyard'
  | 'depot'
  | 'nursery'
  | 'drykilns'
  | 'lumbershed'
  | 'boilerhouse'
  | 'concentrator'
  | 'shaft'
  | 'stockpile'
  | 'crusher'
  | 'tankfarm'
  | 'wellpad'
  | 'pumpstation'
  | 'columns'
  | 'loading'
  | 'flare'
  | 'rolling'
  | 'cooling'
  | 'metalyard'
  | 'silos'
  | 'kilnshed'
  | 'pallets'
  | 'coldstore'
  | 'tanks'
  | 'packing'
  | 'assembly'
  | 'warehouse'
  | 'atelier'
  | 'vault'
  | 'smokehouse'
  | 'netshed';

type Group = 'crops' | 'livestock' | 'forest' | 'wood' | 'paper' | 'mine' | 'pit' | 'oil' | 'chem' | 'metal' | 'kiln' | 'food' | 'mill' | 'craft' | 'fish';

const GROUP: Record<IndustryKind, Group> = {
  farm: 'crops',
  flaxfarm: 'crops',
  sunflower: 'crops',
  cottonfarm: 'crops',
  ranch: 'livestock',
  sheepfarm: 'livestock',
  forest: 'forest',
  sawmill: 'wood',
  furniture: 'wood',
  papermill: 'paper',
  coalmine: 'mine',
  ironmine: 'mine',
  coppermine: 'mine',
  goldmine: 'mine',
  gemmine: 'mine',
  quarry: 'pit',
  sandpit: 'pit',
  claypit: 'pit',
  oilwell: 'oil',
  gasfield: 'oil',
  refinery: 'chem',
  gasplant: 'chem',
  steelmill: 'metal',
  smelter: 'metal',
  buildmat: 'kiln',
  cement: 'kiln',
  brickworks: 'kiln',
  glassworks: 'kiln',
  foodplant: 'food',
  meatplant: 'food',
  cannery: 'food',
  oilmill: 'food',
  factory: 'mill',
  electro: 'mill',
  linenmill: 'mill',
  woolmill: 'mill',
  cottonmill: 'mill',
  jeweler: 'craft',
  gemcutter: 'craft',
  fishery: 'fish',
};

/** Какие пристройки бывают у группы предприятий. */
const VARIANTS: Record<Group, AnnexVariant[]> = {
  crops: ['granary', 'machineyard', 'greenhouse', 'cellar'],
  livestock: ['cowshed', 'haybarn', 'paddock'],
  forest: ['logyard', 'depot', 'nursery'],
  wood: ['drykilns', 'lumbershed', 'boilerhouse'],
  paper: ['logyard', 'lumbershed', 'boilerhouse'],
  mine: ['concentrator', 'shaft', 'stockpile'],
  pit: ['crusher', 'depot', 'stockpile'],
  oil: ['tankfarm', 'wellpad', 'pumpstation'],
  chem: ['columns', 'loading', 'flare'],
  metal: ['rolling', 'cooling', 'metalyard'],
  kiln: ['silos', 'kilnshed', 'pallets'],
  food: ['coldstore', 'tanks', 'packing'],
  mill: ['assembly', 'warehouse', 'boilerhouse'],
  craft: ['atelier', 'vault'],
  fish: ['smokehouse', 'netshed', 'coldstore'],
};

/** Изгородь участка: у ферм — деревянная, у лесозаготовки — никакой, у остальных — сетка. */
const FENCE: Partial<Record<Group, string>> = {
  crops: '#8c6f4e',
  livestock: '#8c6f4e',
  wood: '#8a8f96',
  paper: '#8a8f96',
  mine: '#8a8f96',
  pit: '#8a8f96',
  oil: '#8a8f96',
  chem: '#8a8f96',
  metal: '#8a8f96',
  kiln: '#8a8f96',
  food: '#8a8f96',
  mill: '#8a8f96',
  craft: '#8a8f96',
  fish: '#8a8f96',
};

/** Какие пристройки бывают у предприятия этого вида. */
export function annexVariants(kind: IndustryKind): readonly AnnexVariant[] {
  return VARIANTS[GROUP[kind]];
}

/**
 * Вид пристройки: у каждой — свой по её id; пока у предприятия есть из чего выбрать, следующие не повторяют уже
 * стоящие (берут следующий свободный). Поставили новую — прежние не меняются.
 */
export function annexVariant(ind: Industry, annex: Annex): AnnexVariant {
  const list = annexVariants(ind.info.kind);
  const all = (1 << list.length) - 1;
  let used = 0;
  for (const x of ind.annexes ?? []) {
    let k = Math.floor(hash(x.id, 17) * list.length);
    if (used === all) used = 0;
    while (used & (1 << k)) k = (k + 1) % list.length;
    if (x.id === annex.id) return list[k];
    used |= 1 << k;
  }
  return list[Math.floor(hash(annex.id, 17) * list.length)];
}

/** Участок пристройки: сцена рисуется в локальных координатах, центр — в 0, края — L, T, R, B. */
interface Lot {
  ind: Industry;
  kind: IndustryKind;
  variant: AnnexVariant;
  roof: string;
  W: number;
  H: number;
  L: number;
  T: number;
  R: number;
  B: number;
}

/**
 * Пристройка целиком: участок в цвете предприятия, тени, постройки. zoom решает, сколько мелочей рисовать; layer —
 * как у предприятия. Ответ — нарисовано ли движущееся.
 */
export function drawAnnexArt(ctx: CanvasRenderingContext2D, ind: Industry, annex: Annex, zoom: number, time: number, layer: ArtLayer = 'all'): boolean {
  const info = ind.info;
  // Сцены нарисованы под размер пристройки этого вида; контур из сохранения впишется масштабом.
  const W = info.w * ANNEX.scale;
  const H = info.h * ANNEX.scale;
  const lot: Lot = { ind, kind: info.kind, variant: annexVariant(ind, annex), roof: info.roof, W, H, L: -W / 2, T: -H / 2, R: W / 2, B: H / 2 };
  const a = new Art(ctx, ind, zoom, time, annex.id, layer);
  paintScene(ctx, a, annex.fp, W, H, industryGround(info), scene, lot);
  return a.moved;
}

function scene(a: Art, s: Lot): void {
  SCENES[s.variant](a, s);
  const fence = FENCE[GROUP[s.kind]];
  if (fence) a.fence(s.W, s.H, fence);
}

// ---------- Цвета по виду предприятия ----------

/** Тюки и рулоны урожая. */
const BALE: Partial<Record<IndustryKind, string>> = {
  farm: '#e3c662',
  flaxfarm: '#d9c98e',
  sunflower: '#c8b26a',
  cottonfarm: '#f1efe6',
  ranch: '#e3c662',
  sheepfarm: '#d9c98e',
};

/** Что добывают и сыплют в кучи: уголь, руда, камень, песок, глина. */
const BULK: Partial<Record<IndustryKind, string>> = {
  coalmine: '#3a3d43',
  ironmine: '#a0603c',
  coppermine: '#2a7d78',
  goldmine: '#b0a78f',
  gemmine: '#a9a49c',
  quarry: '#b3aea6',
  sandpit: '#d9b77a',
  claypit: '#b8693f',
};

/** Продукция в пакетах и на поддонах: цвет, полосы, прокладки. */
const GOODS: Partial<Record<IndustryKind, [string, string, string?]>> = {
  sawmill: ['#d8b377', '#b8925a', BARK],
  furniture: ['#e2cfaa', 'rgba(0,0,0,0.12)'],
  steelmill: ['#7f95a6', '#5f7a8f'],
  smelter: ['#d9824a', '#a85a2c'],
  buildmat: ['#c4664a', '#a24e36'],
  brickworks: ['#c4664a', '#a24e36'],
  cement: ['#d9d6cf', '#b5b0a6'],
  glassworks: ['#a9d8ea', 'rgba(255,255,255,0.75)', '#6d7076'],
};

/** Ящики, контейнеры и рулоны готовой продукции (несколько цветов вперемешку). */
const CRATES: Partial<Record<IndustryKind, string[]>> = {
  foodplant: ['#e5534b', '#f2c94c', '#e07b39'],
  meatplant: ['#e9ecef', '#e5534b', '#d9d4ca'],
  cannery: ['#c9ced3', '#3d8fbf', '#e9ecef'],
  oilmill: ['#efe2b0', '#f2c94c', '#c49a1c'],
  factory: ['#2fb8b3', '#e07b39', '#4a8fe7', '#e5534b'],
  electro: ['#d9824a', '#8a5a3c', '#4a8fe7'],
  linenmill: ['#f1ede0', '#c9d6f2', '#e7dcc4'],
  woolmill: ['#7a4a8c', '#a5805c', '#5f6f8f'],
  cottonmill: ['#f6f4ee', '#8e44ad', '#4a8fe7'],
};

/** Баки и силосы пищевых заводов: корпус, кольцо на крыше, высота. */
const VATS: Partial<Record<IndustryKind, [string, string, number]>> = {
  cannery: ['#e9ecef', '#3d8fbf', 10],
  oilmill: ['#f2d36b', '#c49a1c', 10],
};

/** Стекло шедовой крыши цеха. */
const GLASS: Partial<Record<IndustryKind, string>> = { factory: '#bfe3e4', electro: '#cfe3ef' };

const bale = (s: Lot) => BALE[s.kind] ?? '#e3c662';
const bulk = (s: Lot) => BULK[s.kind] ?? '#a9a49c';
const goods = (s: Lot) => GOODS[s.kind] ?? (['#d8b377', '#b8925a', BARK] as [string, string, string]);
const crates = (s: Lot) => CRATES[s.kind] ?? ['#e5534b', '#f2c94c', '#e07b39'];
const sheep = (s: Lot) => s.kind === 'sheepfarm';

// ---------- Общие детали ----------

const tones = new Map<string, Map<number, string>>();
/**
 * Светлее или темнее, как shade, но в виде #rrggbb: такой цвет можно отдать в heap или tank — они сами считают
 * от него склоны и блики (от строки rgb(...) shade даёт мусор). Кэш — без новых строк в каждом кадре.
 */
export function tone(hex: string, k: number): string {
  let byK = tones.get(hex);
  if (!byK) tones.set(hex, (byK = new Map()));
  let v = byK.get(k);
  if (v === undefined) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c: number) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k));
    v = `#${((f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).padStart(6, '0')}`;
    byK.set(k, v);
  }
  return v;
}

/** Двор пристройки: утоптанная земля, гравий или бетон с отступом от края участка. */
function yard(a: Art, s: Lot, color: string): void {
  a.patch(s.L + 3, s.T + 3, s.W - 6, s.H - 6, color, 3);
}

/** Ворота по нижней кромке крыши (y — нижний край здания). */
function gates(a: Art, x: number, y: number, w: number, n: number): void {
  const step = w / n;
  for (let k = 0; k < n; k++) a.flat(x + step * (k + 0.5) - 2.5, y - 1.4, 5, 1.4, '#55595f');
}

/** Трактор с кабиной — только вблизи. */
function tractor(a: Art, x: number, y: number): void {
  if (!a.d) return;
  a.vehicle(x, y, 3.2, 4.6, '#3f8f4a');
  a.flat(x - 0.9, y - 0.6, 1.8, 1.6, '#2c6b37');
}

/** Рулоны сена рядами по cols штук. */
function rolls(a: Art, x: number, y: number, cols: number, n: number, color: string): void {
  for (let k = 0; k < n; k++) a.tank(x + (k % cols) * 5.6, y + Math.floor(k / cols) * 5.6, 2.3, 2, color, shade(color, -0.15));
}

/** Изгородь загона. */
function pen(a: Art, x: number, y: number, w: number, h: number): void {
  if (a.pass !== 0 || !a.lod) return;
  a.c.strokeStyle = '#8c6f4e';
  a.c.lineWidth = 0.7;
  a.c.strokeRect(x, y, w, h);
}

/** Пыль вокруг горных построек. */
function dust(a: Art, s: Lot, i: number): void {
  a.stain(0, 0, s.W * 0.42, s.H * 0.4, 'rgba(60,60,60,0.07)', i);
}

// ---------- Поля ----------

/** Зерносушилка: башня сушилки, галерея к ряду силосов, куча зерна, весовая в цвете крыши и зерновоз. */
function granary(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d8caa2');
  const r = 4.5;
  const step = 2 * r + 1.2;
  const n = Math.max(2, Math.min(3, Math.floor((R - 3 - (L + 16) + 1.2) / step)));
  const x0 = L + 16 + r;
  const y = T + 4.5 + r;
  a.box(L + 4, T + 4, 10, 13, 14, METAL, 1.6);
  for (let k = 0; k < n; k++) a.tank(x0 + k * step, y, r, 16, '#d5dadd', METAL);
  a.belt(L + 13, y, 14, x0 + (n - 1) * step, y, 16);
  a.heap(L + 24, B - 9, 4, bale(s), 1);
  a.gable(R - 17, B - 13, 14, 9, 5, s.roof);
  a.flat(R - 11.5, B - 9.5, 3, 2, '#f1e9dc');
  a.truck(L + 12, B - 8, false, '#c4662f', bale(s));
}

/** Машинный двор: металлический ангар с воротами, контора, бочка с топливом, трактор и комбайн на площадке. */
function machineyard(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d8caa2');
  const hw = s.W - 19;
  a.patch(L + 4, T + 19, hw, B - 4 - (T + 19), '#cdc8bf', 2);
  a.gable(L + 4, T + 4, hw, 15, 8, '#a9b0b6', true);
  gates(a, L + 4, T + 19, hw, 3);
  a.box(R - 11, T + 4, 8, 9, 4, s.roof, 1.4);
  a.tank(R - 7, T + 19, 2.8, 4, '#e9ecef', '#c0392b');
  tractor(a, L + 9, B - 9);
  if (a.d) {
    // Комбайн: кузов, бункер и жатка впереди.
    a.vehicle(L + 21, B - 9, 6, 7, YELLOW);
    a.flat(L + 19.6, B - 10, 2.8, 2.6, '#3d4148');
    a.flat(L + 16.5, B - 13.8, 9, 1.2, DARK);
  }
  a.tree(R - 7, B - 7, 4, '#6e9a52');
}

/** Теплицы: три стеклянных корпуса рядом, котельная в цвете крыши с трубой, водонапорный бак. */
function greenhouse(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d8caa2');
  const gw = s.W - 19;
  const gh = (s.H - 11) / 3 - 1.2;
  for (let k = 0; k < 3; k++) a.gable(L + 4, T + 4 + k * (gh + 1.6), gw, gh, 3.5, '#d4ebe4', true);
  a.box(R - 12, T + 4, 9, 9, 6, s.roof, 1.4);
  a.chimney(R - 7.5, T + 18, 1.5, 16, '#b9b4ad');
  a.tank(R - 7.5, B - 8, 3.2, 8, '#d5dadd', METAL);
  a.smoke(R - 7.5, T + 18, 1, '236,236,236', 0.7);
}

/** Хранилище урожая: длинная насыпь с травой и вентиляционными трубами, бетонный портал с воротами, ящики, грузовик. */
function cellar(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d8caa2');
  const w = s.W - 8;
  const h = 15;
  a.gable(L + 4, T + 4, w, h, 3, '#93ad62');
  for (let k = 0; k < 4; k++) a.chimney(L + 4 + (w * (k + 0.5)) / 4, T + 4 + h / 2, 0.9, 4, '#9aa3ab');
  // Портал в торце насыпи: бетонная стенка, над воротами — козырёк в цвете крыши.
  const gx = L + 4 + w * 0.3;
  a.box(gx - 6, T + 3 + h, 12, 3, 3, '#cdc8bf');
  a.box(gx - 4, T + 6 + h, 8, 1.6, 3.4, s.roof);
  for (let k = 0; k < 6; k++) a.stack(R - 19 + (k % 3) * 5.5, T + h + 9 + Math.floor(k / 3) * 5, 4.5, 4, 2, '#b98e5e', '#8d6a43');
  a.truck(gx + 3, B - 7, false, '#c4662f', bale(s));
}

// ---------- Животноводство ----------

/** Коровник (у овец — кошара): длинный корпус с вентиляцией на коньке, кормовой силос, выгул со стадом. */
function cowshed(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d4c6a0');
  const bw = s.W - 17;
  const py = T + 18;
  const ph = B - 4 - py;
  a.patch(L + 4, py, s.W - 8, ph, sheep(s) ? '#b4c27a' : '#a3bf72', 2);
  pen(a, L + 4, py, s.W - 8, ph);
  a.gable(L + 4, T + 4, bw, 11, 6, s.roof);
  for (let k = 0; k < 3; k++) a.flat(L + 4 + (bw * (k + 0.5)) / 3 - 1.5, T + 8.3, 3, 2.4, shade(s.roof, 0.3));
  a.tank(R - 6, T + 9.5, 3.6, 15, '#d5dadd', METAL);
  herd(a, L + 4, py, s.W - 8, ph, 4 + Math.floor(a.r(4) * 3), 600, sheep(s));
}

/** Сенник: дощатый навес, штабель тюков, ряд рулонов и трактор. */
function haybarn(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d4c6a0');
  const c = bale(s);
  a.gable(L + 4, T + 4, 22, 14, 6, '#8a6a4a', true);
  for (let k = 0; k < 4; k++) a.stack(L + 29 + (k % 2) * 8.5, T + 4 + Math.floor(k / 2) * 7, 7, 5.5, 3, c, shade(c, -0.22));
  rolls(a, L + 7, B - 8, 6, 6, c);
  tractor(a, R - 7, B - 8);
  a.box(L + 4, T + 19, 8, 2.4, 0.8, '#7fa9b8');
}

/** Выгон: пастбище с изгородью, навес для скота, поилка, стадо (или отара) и дерево. */
function paddock(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, sheep(s) ? '#b4c27a' : '#a3bf72', 3);
  for (let k = 0; k < 3; k++) {
    a.stain(L + 8 + a.r(10 + k) * (s.W - 30), T + 8 + a.r(20 + k) * (s.H - 16), 5, 4, 'rgba(120,150,80,0.35)', 20 + k);
  }
  pen(a, L + 4, T + 4, s.W - 8, s.H - 8);
  a.gable(R - 15, T + 5, 11, 14, 5, s.roof);
  a.box(R - 14, T + 22, 9, 2.4, 0.8, '#7fa9b8');
  herd(a, L + 4, T + 4, s.W - 22, s.H - 8, 5 + Math.floor(a.r(4) * 3), 700, sheep(s));
  a.tree(R - 7, B - 7, 4, '#6e9a52');
}

// ---------- Лес и дерево ----------

/** Лесной склад (лесная биржа): штабели брёвен, пни, погрузчик и лесовоз. */
function logyard(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdbd94');
  for (let k = 0; k < 5; k++) a.stump(L + 6 + a.r(200 + k) * (s.W - 12), T + 6 + a.r(300 + k) * (s.H - 12));
  a.logs(L + 4, T + 4, 18, 4, 0);
  a.logs(L + 4, T + 18, 18, 4, 1);
  a.logs(L + 26, T + 4, Math.min(16, R - 4 - (L + 26)), 5, 2);
  a.excavator(R - 8, T + 25, R - 13, T + 21);
  a.truck(L + 13, B - 6, false, '#c4662f', BARK);
  a.tree(R - 6, B - 6, 4.2, '#6e9a52');
}

/** Гараж техники: ангар в цвете крыши с воротами, перед ним — лесовоз и трелёвщик или экскаватор и самосвал. */
function depot(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  const hw = s.W - 8;
  a.gable(L + 4, T + 4, hw, 14, 7, s.roof, true);
  gates(a, L + 4, T + 18, hw, 3);
  const y = T + 25;
  if (s.kind === 'forest') {
    a.truck(L + 11, y, false, '#c4662f', BARK);
    if (a.d) {
      a.vehicle(L + 24, y, 4, 6.4, '#3f8f4a');
      a.flat(L + 22.6, y + 1.4, 2.8, 1.8, '#2c6b37');
    }
  } else {
    a.excavator(L + 9, y, L + 15, y + 4);
    a.truck(L + 25, y, false, YELLOW, bulk(s));
  }
  a.tank(R - 7, B - 7, 2.8, 4, '#e9ecef', '#c0392b');
}

/** Лесопитомник: грядки с саженцами, теплица и сарай. */
function nursery(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdbd94');
  const bw = s.W - 23;
  for (let b = 0; b < 3; b++) {
    const by = T + 4 + b * 10.5;
    if (by + 8 > B - 3) break;
    a.patch(L + 4, by, bw, 8, '#9c7a55', 1);
    for (let k = 0; k * 3.4 + 2 < bw; k++) {
      for (let j = 0; j < 2; j++) a.tree(L + 6 + k * 3.4, by + 2.2 + j * 3.6, 1.1 + a.r(b * 40 + k * 2 + j) * 0.5, j ? '#7aa55a' : '#5e8a46');
    }
  }
  a.gable(R - 17, T + 4, 14, 10, 3.5, '#d4ebe4', true);
  a.gable(R - 17, T + 17, 14, 9, 4, s.roof);
  a.tree(R - 7, B - 6, 4.2, '#6e9a52');
}

/** Сушильные камеры: ряд металлических камер с воротами, котельная с трубой, пакеты досок. */
function drykilns(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d8c8a2');
  const n = s.W >= 50 ? 4 : 3;
  for (let k = 0; k < n; k++) {
    const x = L + 4 + k * 9.5;
    a.box(x, T + 4, 8, 13, 6, '#a9adb1', 1.4);
    a.flat(x + 1, T + 15.6, 6, 1.4, '#55595f');
  }
  a.box(R - 11, T + 4, 8, 8, 5, s.roof, 1.4);
  a.chimney(R - 7, T + 8, 1.6, 16, '#b9b4ad');
  const [color, line, tie] = goods(s);
  const m = Math.floor((s.W - 6) / 12.5);
  for (let k = 0; k < m; k++) a.stack(L + 4 + k * 12.5, B - 12, 10.5, 8, 3, color, line, tie);
  a.smoke(R - 7, T + 8, 1, '236,232,224', 0.8);
}

/** Склад продукции: длинный навес в цвете крыши, под погрузкой — грузовик, рядом пакеты досок или рулоны бумаги. */
function lumbershed(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d8c8a2');
  a.gable(L + 4, T + 4, s.W - 8, 13, 6, s.roof, true);
  if (s.kind === 'papermill') {
    for (let k = 0; k < 8; k++) a.tank(L + 22 + (k % 4) * 6.4, B - 11.5 + Math.floor(k / 4) * 6.2, 2.8, 4, '#f4f1ea', '#d9d4ca');
    a.truck(L + 10, B - 7.5, false, s.roof, '#f4f1ea');
    return;
  }
  const [color, line, tie] = goods(s);
  for (let k = 0; k < 2; k++) a.stack(L + 19 + k * 12, B - 12, 10, 8, 3, color, line, tie);
  a.truck(L + 10, B - 7.5, false, s.roof, color);
  if (a.d && R - (L + 43) > 5) a.vehicle(R - 6, B - 8, 3, 4.4, YELLOW);
}

/** Котельная: корпус в цвете крыши, высокая труба, куча топлива (опилки, щепа или уголь) с конвейером, бак воды. */
function boilerhouse(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  const fuel = GROUP[s.kind] === 'mill' ? '#3d4148' : s.kind === 'papermill' ? '#e2cc94' : '#e6d29f';
  a.box(L + 4, T + 4, 16, 12, 7, s.roof, 1.6);
  a.heap(R - 9, B - 8.5, 6, fuel, 1);
  a.belt(R - 12, B - 11, 2, L + 18, T + 13, 7);
  a.tank(L + 9, B - 8, 3, 6, '#d5dadd', METAL);
  a.chimney(L + 25, T + 9, 2.4, 28, '#b9b4ad', '#c0392b');
  a.smoke(L + 25, T + 9, 1, '170,166,160', 1);
}

// ---------- Шахты и карьеры ----------

/** Обогатительная фабрика: высокий корпус, сгуститель с водой, куча руды с конвейером в корпус, самосвал. */
function concentrator(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  dust(a, s, 1);
  a.pipe(L + 19, T + 10, R - 15, T + 10, '#8a8f96', 1);
  a.box(L + 4, T + 4, 15, 14, 11, s.roof, 1.6);
  a.tank(R - 9, T + 10, 6, 1.5, '#b4b9be', '#8a8f96');
  a.tank(R - 9, T + 10, 4.4, 0, '#7fa9b8');
  a.heap(L + 12, B - 9, 6.5, bulk(s), 1);
  a.belt(L + 12, B - 13, 4, L + 12, T + 16, 9);
  a.truck(R - 9, B - 7, false, YELLOW, bulk(s));
}

/** Вентиляционный (вспомогательный) ствол: копёр со шкивами, подъёмная машина, вентилятор, рельсы с вагонетками. */
function shaft(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  dust(a, s, 2);
  a.track(L + 3, B - 6, R - 3, B - 6);
  a.box(L + 18, T + 4, 12, 11, 6, s.roof, 1.6);
  a.headframe(L + 10, T + 11, L + 18);
  a.tank(R - 6, T + 8, 3, 3, '#8a8f96', DARK);
  a.heap(R - 7, B - 15, 5.5, bulk(s), 1);
  for (let k = 0; k < 3; k++) a.cart(L + 8 + k * 8, B - 6, bulk(s));
}

/** Склад сырья: бункер-башня, конвейер, две кучи, погрузчик и самосвал. */
function stockpile(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  const c = bulk(s);
  dust(a, s, 3);
  a.box(L + 4, T + 4, 10, 10, 15, '#7d8088', 1.6);
  a.belt(L + 18, T + 11, 5, L + 12, T + 9, 14);
  a.heap(L + 24, T + 12, 7.5, c, 1);
  a.heap(R - 7.5, B - 10, 6, tone(c, 0.08), 2);
  if (a.d) {
    a.vehicle(L + 24, B - 7, 4, 5.6, YELLOW);
    a.flat(L + 22, B - 10.6, 4, 1.2, DARK);
  }
  a.truck(L + 10, B - 7, false, YELLOW, c);
}

/** Дробильно-сортировочная установка: дробилка, грохот, конвейеры на три кучи разной фракции, самосвал. */
function crusher(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  const c = bulk(s);
  dust(a, s, 4);
  a.box(L + 4, T + 4, 12, 12, 10, s.roof, 1.6);
  a.box(L + 5, T + 19, 10, 6, 5, '#8a8f96', 1.2);
  a.belt(L + 10, T + 16, 8, L + 10, T + 19, 5);
  a.belt(L + 16, T + 9, 8, L + 26, T + 9, 6);
  a.belt(L + 16, T + 13, 8, R - 8, T + 17, 5);
  a.belt(L + 15, T + 22, 5, L + 22, B - 9, 5);
  a.heap(L + 26, T + 9, 6, c, 1);
  a.heap(R - 8, T + 17, 5, tone(c, 0.12), 2);
  a.heap(L + 22, B - 9, 6, tone(c, -0.1), 3);
  a.truck(L + 10, B - 5.5, false, YELLOW, c);
}

// ---------- Нефть и газ ----------

/** Резервуарный парк в обваловании: ряды резервуаров с трубами к насосной в цвете крыши. */
function tankfarm(a: Art, s: Lot): void {
  const { L, T } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#c8c1b2', 3, '#b0a897');
  const cols = Math.max(2, Math.floor((s.W - 6) / 14));
  const cw = (s.W - 6) / cols;
  const r = Math.min(6.2, cw / 2 - 0.8);
  const y0 = T + 3 + (s.H - 6) * 0.25;
  const y1 = T + 3 + (s.H - 6) * 0.75;
  const ym = (y0 + y1) / 2;
  const xs = (k: number) => L + 3 + cw * (k + 0.5);
  const px = xs(cols - 1);
  a.pipe(xs(0), ym, px, ym);
  a.pipe(px, ym, px, y1);
  for (let k = 0; k < cols; k++) a.pipe(xs(k), y0, xs(k), k < cols - 1 ? y1 : ym);
  for (let k = 0; k < cols * 2 - 1; k++) a.tank(xs(k % cols), k < cols ? y0 : y1, r, 9, '#ece8df', s.roof);
  a.box(px - 5, y1 - 4, 10, 8, 4, s.roof, 1.4);
}

/** Куст скважин: две качалки и сборный резервуар (у газового промысла — четыре «ёлки» и манифольд). */
function wellpad(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#c8c1b2', 3, '#b0a897');
  if (s.kind === 'gasfield') {
    const mx = R - 10;
    const wells: [number, number][] = [
      [L + 9, T + 10],
      [L + 9, B - 10],
      [L + 22, T + 10],
      [L + 22, B - 10],
    ];
    for (const [x, y] of wells) {
      a.patch(x - 4.5, y - 4.5, 9, 9, '#bdb5a5', 1.5);
      a.pipe(x + 4, y, mx, y);
    }
    a.pipe(mx, T + 10, mx, B - 10);
    for (const [x, y] of wells) {
      a.box(x - 1.6, y - 1.6, 3.2, 3.2, 4, '#c0392b');
      a.flat(x - 2.8, y - 0.5, 5.6, 1, YELLOW);
    }
    a.box(mx - 3, -5, 8, 10, 4, s.roof, 1.6);
    return;
  }
  const x = (L + R) / 2 - 2;
  const wx = x + 15.6;
  const ys = [T + 9, T + 20];
  for (let k = 0; k < 2; k++) a.stain(wx, ys[k] + 1, 3.5, 2.6, 'rgba(40,30,50,0.18)', 10 + k);
  a.pipe(wx, ys[0], wx, B - 7.5);
  a.pipe(L + 9, B - 7.5, wx, B - 7.5);
  for (let k = 0; k < 2; k++) a.pumpjack(x, ys[k], k, s.roof);
  a.tank(L + 9, B - 8, 4, 7, '#ece8df', s.roof);
}

/** Насосная станция: корпус в цвете крыши, сепаратор, эстакада труб, автоцистерна; у газа — факел. */
function pumpstation(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  const gas = s.kind === 'gasfield';
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#c8c1b2', 3, '#b0a897');
  a.pipe(L + 18, T + 9, R - 12, T + 9);
  a.box(L + 4, T + 4, 14, 10, 6, s.roof, 1.6);
  for (let k = 0; k < 2; k++) a.flat(L + 6 + k * 6, T + 6, 3, 2.4, '#9aa3ab');
  a.tank(R - 8, T + 9, 4.2, gas ? 10 : 12, gas ? '#f0eee8' : '#e9ecef', s.roof);
  a.rack(L + 4, T + 18, s.W - 8);
  if (gas) {
    a.chimney(R - 7, B - 7, 1.2, 24, '#8f969e', '#c0392b');
    a.glow(R - 7, B - 7, 2);
  } else a.tank(R - 7, B - 7.5, 3.4, 8, '#e9ecef', s.roof);
  a.truck(L + 12, B - 7, false, s.roof, '#d9dde0');
}

/** Установка переработки: три колонны разной высоты, эстакада, печь с трубой, ёмкости. */
function columns(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#cec8bb', 3, '#b7b0a2');
  const ry = -2.5;
  const cols: [number, number, number, number][] = [
    [L + 9, T + 9, 3.6, 28],
    [L + 18, T + 8, 3, 24],
    [L + 27, T + 10, 4, 30],
  ];
  for (const [x, y] of cols) a.pipe(x, y, x, ry, '#8f969e', 1);
  a.rack(L + 4, ry, s.W - 8);
  for (const [x, y, r, z] of cols) a.tank(x, y, r, z, '#c9ccd0', '#8f969e');
  a.tank(R - 8, T + 9, 4.5, 10, '#e9ecef', s.roof);
  a.box(L + 4, B - 12, 14, 9, 6, s.roof);
  a.chimney(L + 22, B - 7, 1.6, 22, '#8f969e');
  a.tank(R - 8, B - 8, 4.5, 10, '#e9ecef', s.roof);
  a.smoke(L + 22, B - 7, 1, '140,140,146', 0.8);
}

/** Наливная эстакада: навес в цвете крыши над полосами налива с автоцистернами, мерники, операторная. */
function loading(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#cec8bb', 3, '#b7b0a2');
  const lw = s.W - 20;
  a.patch(L + 4, T + 4, lw, s.H - 8, '#b9b4aa', 2);
  a.pipe(R - 8, T + 9, L + 4 + lw, -0.5, '#8f969e', 1);
  a.pipe(R - 8, T + 19, L + 4 + lw, -0.5, '#8f969e', 1);
  for (let k = 0; k < 3; k++) {
    const x = L + 4 + (lw * (k + 0.5)) / 3;
    if (k === 1 || a.r(30 + k) < 0.75) a.truck(x, 1, true, s.roof, '#e9ecef');
    a.flat(x - 2.6, B - 7, 5.2, 0.6, 'rgba(255,255,255,0.7)');
  }
  a.box(L + 4, -3, lw, 5, 7, s.roof, 1.6);
  a.tank(R - 8, T + 9, 3.8, 9, '#ece9e2', s.roof);
  a.tank(R - 8, T + 19, 3.8, 9, '#ece9e2', s.roof);
  a.box(R - 12, B - 11, 8, 7, 4, METAL, 1.2);
}

/** Компрессорная с газгольдерами и факелом. */
function flare(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#cec8bb', 3, '#b7b0a2');
  a.pipe(L + 22, T + 10, R - 7, T + 10, '#8f969e', 1);
  a.pipe(R - 7, T + 10, R - 7, B - 8, '#8f969e', 1);
  a.box(L + 4, T + 4, 18, 12, 6, s.roof, 1.6);
  for (let k = 0; k < 3; k++) a.flat(L + 6 + k * 5.5, T + 6, 3, 2.4, '#9aa3ab');
  a.tank(L + 30, T + 10, 6, 12, '#f0eee8', s.roof);
  a.tank(L + 30, B - 10, 6, 12, '#f0eee8', s.roof);
  a.chimney(R - 7, B - 8, 1.3, 30, '#8f969e', '#c0392b');
  a.glow(R - 7, B - 8, 2.2);
  a.truck(L + 12, B - 8, false, s.roof, '#e9ecef');
}

// ---------- Металлургия ----------

/** Прокатный цех: длинный корпус с фонарями, труба, пакеты продукции на площадке. */
function rolling(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  const [color, line] = goods(s);
  a.patch(L + 3, B - 15, s.W - 6, 12, '#cdc8bf', 2);
  a.box(L + 4, T + 4, s.W - 8, 14, 9, s.roof);
  for (let k = 0; k < 2; k++) a.flat(L + 7, T + 7 + k * 5, s.W - 14, 1.6, 'rgba(220,235,245,0.45)');
  for (let k = 0; k < 3; k++) a.stack(L + 5 + k * 12, B - 12, 10, 6, 2.5, color, line);
  a.chimney(R - 8, B - 8, 2.4, 26, '#8f969e', '#c0392b');
  a.smoke(R - 8, B - 8, 1, '120,122,128', 1);
}

/** Градирня: широкая башня (сверху видно тёмное жерло, идёт пар), насосная в цвете крыши, бассейн. */
function cooling(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  const r = Math.min(12, s.H / 2 - 4);
  const cx = L + 4 + r;
  a.patch(R - 19, B - 15, 15, 11, '#86a3ad', 2, '#b4b9be');
  a.pipe(cx + r - 1, 4, R - 19, 6, '#8f969e', 1.2);
  a.pipe(R - 11, B - 15, R - 11, T + 14, '#8f969e', 1.2);
  a.tank(cx, 0, r, 30, '#c9ccd0');
  if (a.pass === 2 && a.lod) {
    // Жерло: внутренняя стенка напротив солнца освещена, ближняя к нему — в тени.
    const c = a.c;
    c.fillStyle = '#7b8187';
    disc(c, cx, 0, r * 0.76);
    c.fillStyle = '#596066';
    disc(c, cx + a.lx * r * 0.12, a.ly * r * 0.12, r * 0.64);
  }
  a.box(R - 18, T + 4, 14, 10, 5, s.roof, 1.6);
  a.smoke(cx, 0, 7, '245,245,245', 1.5);
}

/** Склад металла: пакеты продукции рядами, козловой кран над ними, контора и грузовик. */
function metalyard(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  const [color, line] = goods(s);
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#cdc8bf', 2);
  if (a.pass === 0 && a.lod) {
    // Подкрановые пути.
    const c = a.c;
    c.strokeStyle = '#575a60';
    c.lineWidth = 0.6;
    c.beginPath();
    for (const y of [T + 5.5, B - 5.5]) {
      c.moveTo(L + 4, y);
      c.lineTo(R - 14, y);
    }
    c.stroke();
  }
  for (let k = 0; k < 6; k++) a.stack(L + 6 + (k % 3) * 11, T + 9 + Math.floor(k / 3) * 10, 9, 6, 2.5, color, line);
  const cx = L + 12 + a.r(5) * (s.W - 30);
  a.box(cx - 1.6, T + 4, 3.2, s.H - 8, 12, YELLOW);
  a.flat(cx - 2.4, a.r(6) * 10 - 5, 4.8, 3.4, DARK);
  a.box(R - 11, B - 14, 8, 8, 4, s.roof, 1.2);
  a.truck(R - 7, T + 11, true, s.roof, color);
}

// ---------- Стройматериалы и стекло ----------

/** Силосы: ряд высоких силосов с галереей, отгрузочный корпус в цвете крыши, цементовоз, поддоны. */
function silos(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  const n = s.W >= 50 ? 4 : 3;
  const y = T + 9;
  for (let k = 0; k < n; k++) a.tank(L + 9 + k * 11.5, y, 5, 20, '#d9d6cf', '#b5b0a6');
  a.belt(L + 4, y, 20, L + 9 + (n - 1) * 11.5, y, 20);
  a.box(L + 4, B - 13, 12, 9, 6, s.roof, 1.6);
  a.truck(L + 26, B - 8, false, s.roof, '#d9d6cf');
  const [color, line, tie] = goods(s);
  for (let k = 0; k < 4; k++) a.stack(R - 12.5 + (k % 2) * 5.5, B - 13 + Math.floor(k / 2) * 5.5, 4.5, 4.5, 2.5, color, line, tie);
}

/** Обжиговая печь: длинная вращающаяся печь с башней, сушильный навес, труба, поддоны продукции. */
function kilnshed(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  a.kiln(L + 4, T + 5, s.W - 17, 6);
  a.box(R - 12, T + 3.5, 9, 10, 10, '#a9adb1');
  a.gable(L + 4, T + 15, s.W - 19, 8, 4, s.roof, true);
  const [color, line, tie] = goods(s);
  const n = Math.floor((s.W - 19) / 7);
  for (let k = 0; k < n; k++) a.stack(L + 4 + k * 7, B - 7.5, 5.5, 4.5, 2.5, color, line, tie);
  a.chimney(R - 7.5, B - 8, 2, 24, '#b9b4ad', '#9a4a36');
  a.smoke(R - 7.5, B - 8, 1, '178,172,164');
}

/** Склад готовой продукции: поддоны рядами, контора в цвете крыши, погрузчик и грузовик. */
function pallets(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  a.box(L + 4, T + 4, 13, 10, 5, s.roof, 1.6);
  const [color, line, tie] = goods(s);
  const x0 = L + 20;
  const cols = Math.floor((R - 3 - x0 + 1.5) / 6.5);
  const rows = Math.floor((B - 3 - (T + 4) + 1.5) / 6.5);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (a.r(50 + i * 7 + j) < 0.15) continue;
      a.stack(x0 + j * 6.5, T + 4 + i * 6.5, 5, 5, 2.5, color, line, tie);
    }
  }
  if (a.d) {
    a.vehicle(L + 10, T + 19, 3, 4.4, YELLOW);
    a.flat(L + 9, T + 16, 2, 1.2, DARK);
  }
  a.truck(L + 10, B - 6, false, s.roof, color);
}

// ---------- Пищевые заводы ----------

/** Холодильный склад: белый корпус с агрегатами на крыше, рампа с рефрижераторами, контора в цвете крыши. */
function coldstore(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, B - 13, s.W - 6, 10, '#cdc8bf', 2);
  a.rows(L + 3, B - 13, s.W - 6, 10, 8, 'rgba(255,255,255,0.55)', true, 0.5);
  const bw = s.W - 16;
  const n = Math.min(3, Math.floor(bw / 9));
  a.box(L + 4, T + 4, bw, 13, 6, '#d5dde2', 2);
  for (let k = 0; k < 3; k++) a.flat(L + 7 + k * 9, T + 5.5, 4, 2.4, '#9aa3ab');
  gates(a, L + 4, T + 17, bw, n);
  a.box(R - 10, T + 4, 7, 9, 4, s.roof, 1.2);
  for (let k = 0; k < n; k++) if (k === 0 || a.r(30 + k) < 0.7) a.truck(L + 4 + (bw * (k + 0.5)) / n, T + 23, true, s.roof, '#f4f1ea');
}

/** Баки: силосы зерна (у рыбозавода — рассол, у маслозавода — масло), приёмка в цвете крыши, автоцистерна. */
function tanks(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  const [body, cap, z] = VATS[s.kind] ?? ['#ebe7df', '#b8b2a6', 16];
  const r = Math.min(5.4, (s.H - 10) / 4 - 0.4);
  const xs = [L + 4 + r, L + 6 + 3 * r];
  const ys = [T + 4 + r, B - 4 - r];
  a.pipe(xs[0], 0, L + 28, 0);
  for (const x of xs) for (const y of ys) a.tank(x, y, r, z, body, cap);
  a.box(L + 28, T + 4, R - 4 - (L + 28), 12, 6, s.roof, 1.6);
  a.truck(R - 9, B - 7, false, s.roof, body);
}

/** Цех фасовки: корпус в цвете крыши с фонарями и трубой, ящики продукции, фургоны. */
function packing(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, B - 11, s.W - 6, 8, '#cdc8bf', 2);
  const bw = s.W - 18;
  a.box(L + 4, T + 4, bw, 15, 7, s.roof);
  for (let k = 0; k < 2; k++) a.flat(L + 12, T + 7.5 + k * 5, bw - 10, 2, 'rgba(255,255,255,0.22)');
  a.chimney(L + 8, T + 9, 1.8, 14, '#d9d4ca');
  const palette = crates(s);
  for (let k = 0; k < 6; k++) {
    a.stack(R - 12 + (k % 2) * 5, T + 4 + Math.floor(k / 2) * 5.5, 4, 4.5, 2, palette[Math.floor(a.r(80 + k) * palette.length)], 'rgba(0,0,0,0.15)');
  }
  for (let k = 0; k < 2; k++) a.truck(L + 10 + k * 13, B - 7, false, s.roof, '#f4f1ea');
  a.smoke(L + 8, T + 9, 1, '248,248,248');
}

// ---------- Заводы и фабрики ----------

/** Цех с шедовой крышей, бытовой корпус и стоянка машин. */
function assembly(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, B - 9, s.W - 6, 6, '#d0d5d9', 1);
  a.rows(L + 3, B - 9, s.W - 6, 6, 4.5, 'rgba(255,255,255,0.6)', true, 0.4);
  a.shed(L + 4, T + 4, s.W - 16, s.H - 15, 7, s.roof, GLASS[s.kind] ?? '#e8eef2', 5);
  a.box(R - 10, T + 4, 7, 10, 4, '#7a8791', 1.2);
  a.flat(R - 9, T + 15, 5, 1.2, '#55595f');
  if (!a.d) return;
  const cars = ['#e5534b', '#4a8fe7', '#f2c94c', '#f4f1ea', '#5c6470'];
  for (let k = 0; k < Math.floor((s.W - 10) / 4.5); k++) {
    if (a.r(60 + k) < 0.35) continue;
    a.vehicle(L + 6 + k * 4.5, B - 6, 2.6, 4.2, cars[Math.floor(a.r(70 + k) * cars.length)]);
  }
}

/** Склад с рампами: корпус, навес в цвете крыши, фуры у ворот, контейнеры (тюки, рулоны) на площадке. */
function warehouse(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 17, s.W - 6, B - 3 - (T + 17), '#d0d5d9', 2);
  a.box(L + 4, T + 4, s.W - 8, 11, 6, '#b9c2c9', 2);
  a.box(L + 4, T + 15, s.W - 8, 2.2, 4.5, s.roof);
  for (let k = 0; k < 3; k++) a.truck(L + 8 + k * 7.5, T + 23, true, s.roof, '#f4f1ea');
  const palette = crates(s);
  for (let k = 0; k < 2; k++) {
    const color = palette[Math.floor(a.r(40 + k) * palette.length)];
    a.stack(R - 14, T + 19.5 + k * 5, 11, 4.4, 3, color, shade(color, -0.2));
  }
}

/** Флигель мастерской: дом в цвете крыши в саду, мастерская со стеклянной крышей, пруд, дорожка. */
function atelier(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  a.patch(L + 3, T + 3, s.W - 6, s.H - 6, '#b8cf96', 3);
  a.patch(L + 3, T + 18, s.W - 6, 3.4, '#d9d4ca');
  a.gable(L + 4, T + 4, 19, 12, 6, s.roof);
  a.box(L + 24, T + 5, 8, 8, 3.5, '#cfe3ef', 1.2);
  a.tank(L + 10, B - 7, 3.4, 0.4, '#8cc3e6');
  a.tree(R - 5, T + 8, 2.8, '#8fb46a');
  a.tree(R - 6, B - 6, 4, '#6e9a52');
  a.tree(L + 22, B - 6, 3.5, '#7aa55a');
}

/** Хранилище: бетонный корпус, проходная в цвете крыши, инкассаторская машина, деревья. */
function vault(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#cdc8bf');
  a.box(L + 4, T + 4, 16, 13, 5, '#9aa3ab', 1.4);
  a.flat(L + 7, T + 9.5, 10, 2, '#6d7076');
  a.gable(L + 23, T + 4, 11, 8, 4, s.roof);
  a.truck(L + 12, B - 7, false, '#5c6470', '#8a8f96');
  a.tree(R - 6, B - 6, 4, '#6e9a52');
  a.tree(R - 6, T + 17.5, 3.2, '#7aa55a');
}

// ---------- Рыболовы ----------

/** Коптильня: дом в цвете крыши с дымящей трубой, поленница, ящики рыбы, грузовик. */
function smokehouse(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d9cfb4');
  a.gable(L + 4, T + 4, 18, 12, 6, s.roof);
  a.chimney(L + 19, T + 8, 1.6, 14, '#b9b4ad');
  a.logs(L + 4, T + 20, 13, 3, 0);
  for (let k = 0; k < 6; k++) a.stack(L + 24 + (k % 3) * 4.5, T + 5 + Math.floor(k / 3) * 5.5, 3.8, 4.5, 2, '#e9ecef', '#3d8fbf');
  a.truck(R - 9, B - 7, false, s.roof, '#e9ecef');
  a.smoke(L + 19, T + 8, 1, '200,200,206', 0.8);
}

/** Сетевой склад: сарай, вешала с сетями, лодки на кильблоках, бочки. */
function netshed(a: Art, s: Lot): void {
  const { L, T, R, B } = s;
  yard(a, s, '#d9cfb4');
  a.gable(L + 4, T + 4, 16, 11, 5, '#7b6a58');
  if (a.pass === 2 && a.d) {
    const c = a.c;
    c.strokeStyle = '#6d5a44';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      c.moveTo(R - 17, T + 5 + k * 5);
      c.lineTo(R - 4, T + 5 + k * 5);
    }
    c.stroke();
    c.strokeStyle = 'rgba(70,90,110,0.55)';
    c.lineWidth = 1.6;
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      c.moveTo(R - 16, T + 6 + k * 5);
      c.lineTo(R - 5, T + 6 + k * 5);
    }
    c.stroke();
  }
  const hulls = [s.roof, '#c0392b', '#e9b52f', '#f2efe8'];
  for (let k = 0; k < 2; k++) {
    const x = L + 9 + k * 9;
    const y = B - 9;
    a.box(x - 2, y - 3.5, 4, 7, 1.2, '#8a6a4a');
    if (a.pass === 1) {
      a.c.moveTo(x + a.sx * 2 + 3, y + a.sy * 2);
      a.c.ellipse(x + a.sx * 2, y + a.sy * 2, 3, 4.5, 0, 0, Math.PI * 2);
    }
    boat(a, x, y, 9, hulls[Math.floor(a.r(90 + k) * hulls.length)]);
  }
  for (let k = 0; k < 3; k++) a.tank(R - 12 + k * 4, B - 7, 1.7, 2.5, '#8a6a4a', '#5e4a36');
}

const SCENES: Record<AnnexVariant, (a: Art, s: Lot) => void> = {
  granary,
  machineyard,
  greenhouse,
  cellar,
  cowshed,
  haybarn,
  paddock,
  logyard,
  depot,
  nursery,
  drykilns,
  lumbershed,
  boilerhouse,
  concentrator,
  shaft,
  stockpile,
  crusher,
  tankfarm,
  wellpad,
  pumpstation,
  columns,
  loading,
  flare,
  rolling,
  cooling,
  metalyard,
  silos,
  kilnshed,
  pallets,
  coldstore,
  tanks,
  packing,
  assembly,
  warehouse,
  atelier,
  vault,
  smokehouse,
  netshed,
};
