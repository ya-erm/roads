import { plotPoint as toWorld, yardPaths } from '../world/yardPaths';
import { FOOTPATH, WALK_W, footpathBounds, footpathPoints, type Footpath } from '../game/footpaths';
import type { Vec } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import type { Game } from '../game/game';
import type { LaneNet } from '../lanes/model';
import { curbGap } from '../world/worldgen';
import { LOT_SETBACK } from '../world/houseAccess';
import { inPolygon, polyDist } from '../world/lotClear';
import { LOT } from '../world/parkingLots';
import { LOT_ASPHALT } from './lotArt';
import { isDirt, ROAD_ASPHALT, ROAD_DIRT } from '../world/roadTypes';
import { footprintCorners, FootprintIndex, type Footprint } from '../world/spatial';
import { townTier } from '../world/townForms';
import { houseAccess, type HouseDriveColor } from './houseArt';
import { Art } from './industryArt';
import { parkGates } from './parkArt';
import { drawSidewalks, SIDEWALK, type Sidewalk, WALK_LOOK } from './sidewalks';
import { type Box, grow } from './tileCache';
import { paths } from './townDecor';

/**
 * Дорожки и съезды города вне участков домов рисуются под дорогами и домами. Пешеходы и инструмент
 * прокладки дорожек используют те же оси проходов между домами, что и карта:
 * - между соседними домами одного ряда — по промежутку от тротуара в глубину квартала (к дворам, огородам, домам
 *   второго ряда; где позади ничего нет — у части промежутков, по хешу);
 * - к дому второго ряда — от тротуара по промежутку рядом с передним домом и вдоль его задней стороны к крыльцу;
 * - от входов парка или сквера — до тротуара ближней улицы;
 * - от участка через газон и тротуар до полотна — дорожки к крыльцам и съезды к стоянкам и гаражам (houseArt.houseAccess):
 *   край у полотна закрывает асфальт дороги, а не съезд ложится поверх неё.
 * Дорожки — непрозрачные, цветом тротуара (sidewalks.WALK_LOOK), и слоем под ним (drawTownWalks).
 * Считается раз на список домов и парков города (renderer), а не в каждой плитке.
 */

export interface TownWalks {
  townId: number;
  /** Ломаные дорожек (x, y по очереди). */
  paths: number[][];
  /** ID редактируемых городских проходов в начале paths; следом идут подходы к паркам. */
  pathIds?: number[];
  /** Дорожки к крыльцам от участка до тротуара: отрезок (x0, y0, x1, y1) и ширина; цвет — тротуара города. */
  fronts: { pts: number[]; w: number }[];
  /**
   * Съезды от участка до полотна: многоугольник (x, y по очереди) и цвет; mouth — понижение бордюра: раструб у кромки,
   * рисуется поверх полотна (drawDriveMouths).
   */
  drives: { pts: number[]; color: string; mouth?: number[] }[];
  /** Расцветка выездов на участке, в тех же координатах, что и в сцене дома. */
  driveColors?: ReadonlyMap<number, readonly HouseDriveColor[]>;
  /** Мощёные (город) или утоптанные (село). */
  paved: boolean;
  box: Box;
  sig: string;
}

const townCache = new WeakMap<Town, {
  net: LaneNet; version: number; roads: string; layout: number; tier: ReturnType<typeof townTier>;
  buildings: Town['buildings']; count: number; parks: Town['parks']; parkCount: number; lots: Town['lots'];
  hidden: ReadonlySet<number>; walks: TownWalks | null;
}>();

/** Геометрия одного города для карты, привязки и пешего графа. Далёкую правку сети можно пропустить. */
export function gameTownWalks(game: Game, town: Town): TownWalks | null {
  const net = game.roads.net;
  const old = townCache.get(town);
  const tier = townTier(town);
  const samePlots = old && old.hidden === game.hiddenYardPaths && old.layout === game.layoutRev && old.tier === tier &&
    old.buildings === town.buildings && old.count === town.buildings.length &&
    old.parks === town.parks && old.parkCount === (town.parks?.length ?? 0) && old.lots === town.lots;
  if (samePlots && old.net === net && old.version === net.version) return old.walks;
  const { x, y } = town.center;
  const r = (town.extent ?? town.radius) + 60;
  const roads = net.corridorsInBox(x - r, y - r, x + r, y + r).sort((a, b) => a.id - b.id)
    .map(c => `${c.id}:${c.rev}:${c.build ? 1 : 0}`).join(',');
  if (samePlots && old.roads === roads) {
    old.net = net;
    old.version = net.version;
    return old.walks;
  }
  const nearest = (p: Vec) => {
    let best = { gap: Infinity, dirt: false };
    for (const c of net.corridorsNear(p, 30)) {
      if (c.build) continue;
      if ((!net.isFlat(c) || net.node(c.a).level !== 0) && Math.abs(net.heightAt(c, c.lut.closest(p).s)) > 0.25) continue;
      const gap = curbGap(c, p);
      if (gap < best.gap) best = { gap, dirt: isDirt(c.cls) };
    }
    return best;
  };
  const walks = townWalks(town, p => nearest(p).gap, p => nearest(p).dirt ? 'dirt' : 'asphalt', game.townFootpaths(town));
  townCache.set(town, { net, version: net.version, roads, layout: game.layoutRev, tier, buildings: town.buildings,
    count: town.buildings.length, parks: town.parks, parkCount: town.parks?.length ?? 0, lots: town.lots, hidden: game.hiddenYardPaths, walks });
  return walks;
}

/** Проверка кроны у съездов по видимому контуру, включая понижение бордюра. */
export function driveClearance(walks: Iterable<TownWalks>, lots: Iterable<Footprint> = []): (p: Vec, radius: number) => boolean {
  const index = new FootprintIndex<{ fp: Footprint; poly: Vec[] }>(48);
  for (const fp of lots) index.add({ fp, poly: footprintCorners(fp) });
  for (const walk of walks) for (const d of walk.drives) {
    for (const coords of d.mouth ? [d.pts, d.mouth] : [d.pts]) {
      const poly: Vec[] = [];
      for (let i = 0; i < coords.length; i += 2) poly.push({ x: coords[i], y: coords[i + 1] });
      const box = poly.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      index.add({ poly, fp: { center: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, angle: 0, w: box.x1 - box.x0, h: box.y1 - box.y0 } });
    }
  }
  return (p, radius) => index.near(p, radius).some(({ poly }) => inPolygon(p, poly) || polyDist(p, poly) < radius);
}

/** Ширина дорожки, м. */
export { WALK_W };

/** Расстояние до кромки полотна (curbGap) и его покрытие. */
export interface WalkRoads {
  gap(p: Vec): number;
  surface(p: Vec): 'asphalt' | 'dirt';
}

/**
 * Раструб съезда у полотна: начинается за столько метров до кромки и шире съезда на столько с каждой стороны; у
 * широкого съезда (ряд мест с улицы, карман) — уже: между соседними кусками кармана остаётся проход к дорожке.
 */
const FLARE = { from: 1.6, wide: 1.2, row: 0.4, rowFrom: 10 };
/** Съезд заходит под асфальт полотна на столько; понижение бордюра — на столько в асфальт поверх его кромки. */
const UNDER = 0.6;
const LIP = 0.4;

/**
 * Съезд в осях участка f (x — середина, w — ширина) с края участка edge к улице со стороны side — через газон и тротуар
 * до кромки полотна (по roads: и тогда, когда участок отступил от улицы дальше LOT_SETBACK — ужат полосой стоянки,
 * поставлен дальше тротуара); у кромки — раструб и понижение бордюра (mouth — поверх полотна, его бордюр закрыт
 * асфальтом съезда: машина выезжает на улицу по съезду, а не из-под бордюра).
 */
function driveTo(f: Footprint, x: number, w: number, edge: number, side: 1 | -1, color: string, roads: WalkRoads): TownWalks['drives'][number] & { roadColor?: string } {
  const [ex, ey] = toWorld(f, x, edge);
  const end = { x: ex, y: ey };
  const gap = roads.gap(end);
  // Полотна рядом нет (снесли) — съезд обычной длины, без понижения бордюра.
  const connected = gap > -0.5 && gap < 15;
  const near = connected && gap > 0.5;
  const asphalt = connected && roads.surface(end) === 'asphalt';
  const road = edge + side * (near ? gap : LOT_SETBACK);
  const hw = w / 2;
  const at = (pts: number[][]) => pts.flatMap(([px, py]) => toWorld(f, px, py));
  const flare = road - side * FLARE.from;
  const fw = hw + (w >= FLARE.rowFrom ? FLARE.row : FLARE.wide);
  const pts = at([
    [x - hw, edge],
    [x + hw, edge],
    [x + hw, flare],
    [x + fw, road + side * UNDER],
    [x - fw, road + side * UNDER],
    [x - hw, flare],
  ]);
  const roadColor = connected ? (asphalt ? ROAD_ASPHALT : ROAD_DIRT) : undefined;
  const drive: TownWalks['drives'][number] & { roadColor?: string } = { pts, color: roadColor ?? color, roadColor };
  if (near && asphalt) {
    drive.mouth = at([
      [x - hw, flare],
      [x + hw, flare],
      [x + fw, road],
      [x + fw, road + side * LIP],
      [x - fw, road + side * LIP],
      [x - fw, road],
    ]);
  }
  return drive;
}

/** Выходы дома к улице (дорожки к крыльцам, съезды) — в мире, от края участка через газон и тротуар. */
function accessOf(b: TownBuilding, reach: number, fronts: TownWalks['fronts'], drives: TownWalks['drives'], roads: WalkRoads): HouseDriveColor[] {
  // Оси сцены дома: дом с face = 1 повёрнут на пол-оборота (как в houseArt).
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const f: Footprint = { center: b.fp.center, w: b.fp.w, h: b.fp.h, angle };
  const colors: HouseDriveColor[] = [];
  for (const a of houseAccess(b)) {
    const edge = a.side * (b.fp.h / 2);
    if (a.kind === 'path') {
      fronts.push({ pts: [...toWorld(f, a.x, edge), ...toWorld(f, a.x, edge + a.side * reach)], w: a.w });
      continue;
    }
    const drive = driveTo(f, a.x, a.w, edge, a.side, a.color, roads);
    drives.push(drive);
    if (drive.roadColor) colors.push({ x: a.x, side: a.side, color: drive.roadColor });
  }
  return colors;
}

/** Заезды к воротам площадок-стоянок без тупика-выезда (у большой заезд — сама дорога): от края площадки до полотна. */
function lotAccess(town: Town, roads: WalkRoads, drives: TownWalks['drives']): void {
  for (const l of town.lots ?? []) {
    if (l.removed || l.nodes?.length) continue;
    for (const g of l.gates) drives.push(driveTo(l.fp, g.x, LOT.gateW, -l.fp.h / 2, -1, LOT_ASPHALT, roads));
  }
}

/**
 * Дорожки и съезды города town. curb — сколько метров от точки до края ближнего полотна (∞ — далеко): по нему
 * дорожка от входа в парк доходит до тротуара, а съезд — до полотна. Покрытие определяет цвет съезда,
 * у асфальта ещё есть понижение бордюра.
 */
export function townWalks(town: Town, curb: (p: Vec) => number, surface: WalkRoads['surface'] = () => 'asphalt', yards = yardPaths(town, 0)): TownWalks | null {
  const paved = townTier(town) !== 'village';
  const side = paved ? SIDEWALK.paved : SIDEWALK.path;
  // До тротуара от участка: LOT_SETBACK − (from + w) — газон; дорожка заходит на тротуар на полметра.
  const reach = LOT_SETBACK - side.from - side.w + 0.5;
  const out = yards.map(path => footpathPoints(path).flatMap(p => [p.x, p.y]));
  const fronts: TownWalks['fronts'] = [];
  const drives: TownWalks['drives'] = [];
  const driveColors = new Map<number, HouseDriveColor[]>();
  const roads: WalkRoads = { gap: curb, surface };
  // Дом второго ряда выходит к улице дорожкой в обход переднего (ниже), не напрямую.
  for (const b of town.buildings) {
    if (b.kind === 'landmark' || b.rear) continue;
    const colors = accessOf(b, reach, fronts, drives, roads);
    if (colors.length) driveColors.set(b.id, colors);
  }
  lotAccess(town, roads, drives);
  // Участок отступил от улицы дальше обычного (полоса стоянки ужала его — world/curbSqueeze.ts, угловой — с двух
  // улиц): дорожка к крыльцу тянется дальше, до тротуара.
  const onWalk = side.from + side.w - 0.5;
  for (const f of fronts) {
    const gap = curb({ x: f.pts[2], y: f.pts[3] });
    if (!(gap > onWalk + 0.5 && gap < 15)) continue;
    const dx = f.pts[2] - f.pts[0];
    const dy = f.pts[3] - f.pts[1];
    const l = Math.hypot(dx, dy) || 1;
    f.pts[2] += (dx / l) * (gap - onWalk);
    f.pts[3] += (dy / l) * (gap - onWalk);
  }
  // От входов парка — до тротуара ближней улицы, не дальше 16 м.
  for (const p of town.parks ?? []) {
    for (const g of parkGates(p)) {
      const start = { x: g.x, y: g.y };
      for (let d = 0; d <= 16; d += 1) {
        const q = { x: g.x + g.ux * d, y: g.y + g.uy * d };
        if (curb(q) <= side.from + side.w * 0.6) {
          if (d > 0.5) out.push([start.x, start.y, q.x, q.y]);
          break;
        }
      }
    }
  }
  if (!out.length && !fronts.length && !drives.length) return null;
  let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const all = [...out, ...fronts.map((f) => f.pts), ...drives.flatMap((d) => (d.mouth ? [d.pts, d.mouth] : [d.pts]))];
  for (const p of all) for (let i = 0; i < p.length; i += 2) box = { x0: Math.min(box.x0, p[i]), y0: Math.min(box.y0, p[i + 1]), x1: Math.max(box.x1, p[i]), y1: Math.max(box.y1, p[i + 1]) };
  const sig = `${paved}|${all.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(';')}|${drives.map((d) => d.color).join(';')}`;
  return { townId: town.id, paths: out, pathIds: yards.map(path => path.id), fronts, drives, driveColors, paved, box: grow(box, 2), sig };
}

/**
 * Тротуары (sidewalks — render/sidewalks.ts), дорожки кварталов, дорожки к крыльцам и съезды в рамке view — под
 * дорогами и домами; издали (lod 0) их не видно. Дорожки — цветом тротуара (WALK_LOOK) и слоем под ним: сначала все
 * кромки (дорожек, потом тротуаров), потом заливки дорожек, поверх — заливка тротуаров. Скруглённый конец и кромка
 * дорожки не ложатся на тротуар, а его кромку на стыке закрывает заливка дорожки — одно покрытие. Съезды (асфальт) —
 * поверх тротуара: пересекают его.
 */
export function drawTownWalks(ctx: CanvasRenderingContext2D, list: readonly TownWalks[], view: Box, zoom: number, sidewalks: readonly Sidewalk[] = [], footpaths: readonly Footpath[] = []): void {
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  if (!a.lod) return;
  a.pass = 0;
  const c = ctx;
  const seen = list.filter((w) => !(w.box.x1 < view.x0 || w.box.x0 > view.x1 || w.box.y1 < view.y0 || w.box.y0 > view.y1));
  const groups = { manual: [] as number[][], paved: seen.filter(w => w.paved).flatMap(w => w.paths), path: seen.filter(w => !w.paved).flatMap(w => w.paths) };
  for (const path of footpaths) {
    const box = footpathBounds(path);
    if (box.x1 + 2 < view.x0 || box.x0 - 2 > view.x1 || box.y1 + 2 < view.y0 || box.y0 - 2 > view.y1) continue;
    groups[path.surface ?? 'manual'].push(footpathPoints(path).flatMap(p => [p.x, p.y]));
  }
  const walkPaths = (part: 'edge' | 'fill') => {
    if (groups.manual.length) paths(a, groups.manual, FOOTPATH.width, WALK_LOOK.paved.fill, WALK_LOOK.paved.edge, part);
    for (const kind of ['paved', 'path'] as const) {
      if (groups[kind].length) paths(a, groups[kind], WALK_W[kind], WALK_LOOK[kind].fill, WALK_LOOK[kind].edge, part);
    }
  };
  walkPaths('edge');
  drawSidewalks(ctx, sidewalks, view, zoom, 'edge');
  walkPaths('fill');
  c.lineCap = 'butt';
  for (const w of seen) {
    // За участком — цветом тротуара города (в селе — утоптанная), а не дорожки в участке: с тротуаром одно покрытие.
    c.strokeStyle = w.paved ? WALK_LOOK.paved.fill : WALK_LOOK.path.fill;
    for (const f of w.fronts) {
      c.lineWidth = f.w;
      c.beginPath();
      c.moveTo(f.pts[0], f.pts[1]);
      c.lineTo(f.pts[2], f.pts[3]);
      c.stroke();
    }
  }
  drawSidewalks(ctx, sidewalks, view, zoom, 'fill');
  for (const w of seen) {
    for (const d of w.drives) {
      c.fillStyle = d.color;
      poly(c, d.pts);
      c.fill();
    }
  }
}

function poly(c: CanvasRenderingContext2D, pts: readonly number[]): void {
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}

/**
 * Понижение бордюра у съездов в рамке view — поверх полотен (после сети, LaneRenderer): бордюр полотна лежит снаружи
 * его асфальта, и без этого съезд упирался бы в него. В проёме асфальт съезда сходится с асфальтом улицы.
 */
export function drawDriveMouths(ctx: CanvasRenderingContext2D, list: readonly TownWalks[], view: Box, zoom: number): void {
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  if (!a.lod) return;
  for (const w of list) {
    if (w.box.x1 < view.x0 || w.box.x0 > view.x1 || w.box.y1 < view.y0 || w.box.y0 > view.y1) continue;
    for (const d of w.drives) {
      const m = d.mouth;
      if (!m) continue;
      ctx.fillStyle = d.color;
      poly(ctx, m);
      ctx.fill();
    }
  }
}
