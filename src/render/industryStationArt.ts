import { CARGO, type CargoType } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { industryServiceRoads, sitePoint } from '../world/industrySites';
import { Art, METAL } from './industryArt';
import type { Footprint } from '../world/spatial';
import { type Circuit, type Equipment, paintEquipment, type WorkPoint } from './industryEquipment';
import { drawIndustrialGate, drawIndustrialRoads, industryRoadSurface } from './industryRoadArt';

const BULK = new Set<CargoType>(['ore', 'copperore', 'coal', 'stone', 'sand', 'clay', 'gold', 'gems']);
const SILO = new Set<CargoType>(['grain', 'sunflower']);
const TIMBER = new Set<CargoType>(['logs', 'planks']);

/** +y — выезд маршрутов, −y — технологические ворота со стороны предприятия. */
function rearRoad(st: Station): Circuit {
  const depth = st.fp.h / 2;
  return [[0, -depth - 5], [0, -depth * 0.39], [8, -depth * 0.39]];
}

export function drawIndustryYard(c: CanvasRenderingContext2D, st: Station, ind?: Industry): void {
  const { w, h } = st.fp;
  const left = -w / 2 + 2;
  const right = w / 2 - 2;
  const back = -h / 2;
  c.fillStyle = '#b6b4a9';
  c.fillRect(left, back + 1, w - 4, h / 2);
  // Технологический въезд пересекает кромку площадки посередине, открытое полотно тянется до края предприятия.
  c.fillStyle = '#777c7c';
  c.fillRect(left, back + 1, -4 - left, 1.1);
  c.fillRect(4, back + 1, right - 4, 1.1);
  drawIndustrialRoads(c, [rearRoad(st)], industryRoadSurface(ind?.info.kind));
  drawIndustrialGate(c, 0, back, Math.PI / 2);
}

/** Складские ячейки на задней половине двора, заполняются по запасам станции. */
export function drawIndustryYardStock(c: CanvasRenderingContext2D, st: Station, ind: Industry, zoom: number, time: number): boolean {
  const a = new Art(c, st, zoom, time);
  const { w, h } = st.fp;
  const out = ind.info.produces;
  const style = [{ cargo: out, side: -1 }, { cargo: ind.info.accepts[0] ?? out, side: 1 }];
  const depth = h / 2 - 2;
  const width = w / 2 - 14;
  if (width < 4 || depth < 5) return false;
  a.pass = 0;
  for (const { cargo, side } of style) {
    const x = side < 0 ? -w / 2 + 3 : 11;
    a.patch(x, -depth, width, depth - 2, BULK.has(cargo) ? '#aca597' : '#c7c5bc', 1, '#94918a');
  }
  a.pass = 2;
  for (const { cargo, side } of style) {
    const x = side * (11 + width / 2);
    const y = -(depth + 2) / 2;
    const fill = Math.min(1, (st.cargo[cargo] ?? 0) / 80);
    const tone = CARGO[cargo].color;
    const radius = Math.min(depth / 2 - 1.5, width / 3.5, 7);
    if (BULK.has(cargo)) {
      a.box(x - width / 2, -depth - 0.5, width, 1.5, 2, '#878680');
      if (radius > 1.4) {
        a.heap(x - radius * 0.7, y, radius * (0.6 + 0.4 * fill), tone, side + 77);
        if (width > 17) a.heap(x + radius, y + 0.7, radius * (0.44 + 0.36 * fill), tone, side + 88);
      }
    } else if (CARGO[cargo].tank || SILO.has(cargo)) {
      for (const offset of width > 19 ? [-radius - 1, radius + 1] : [0]) {
        a.tank(x + offset, y, radius, SILO.has(cargo) ? 11 : 6, '#e2e3dd', tone);
      }
    } else if (TIMBER.has(cargo)) {
      if (cargo === 'logs') a.logs(x, y, Math.min(20, width - 2), Math.min(depth - 3, 3 + 5 * fill), side + 145);
      else a.stack(x - width / 3, y - 2, width * 0.66, 3 + 3 * fill, 2.5, '#d0b17d', '#987549');
    } else if (cargo === 'livestock') {
      c.strokeStyle = '#866e55';
      c.lineWidth = 0.8;
      c.strokeRect(x - width / 2 + 1, -depth + 1, width - 2, depth - 4);
      a.gable(x - width / 2 + 1, y - 3, width * 0.42, 6, 4, '#92745d');
      a.animal(x + width / 4, y, side, 21);
    } else {
      const colors = [tone, '#d3b067', '#5e8896', '#a57363'];
      const count = Math.max(1, Math.floor((width - 1) / 6));
      if (st.fp.h >= 48) {
        // Крытый склад с рампой вдоль технологического двора. Контейнеры стоят перед рампой.
        a.gable(x - width / 2 + 0.5, -depth + 0.6, width - 1, 9, 6, '#8799a0', true);
        a.box(x - width / 2 + 1, -depth + 9, width - 2, 2.4, 1.5, '#b3bec1');
      }
      for (let i = 0; i < count; i++) {
        const color = colors[i % colors.length];
        const left = x + (i - count / 2) * 6;
        const y0 = st.fp.h >= 48 ? -depth + 14 : -depth + 1;
        a.box(left, y0, 4.7, Math.min(8, -y0 - 2), 3, color, 1.3);
        if (fill > 0.4 && depth > 15 && st.fp.h < 48) a.box(left, y + 2, 4.7, 6, 3, METAL, 1.3);
      }
    }
  }
  if (st.industryAccess || zoom <= 0.5 || !working(ind)) return false;
  paintEquipment(c, yardTruck(out, rearRoad(st)), 0, 0, st.id, time);
  return true;
}

function working(ind: Industry): boolean {
  return !ind.ruin && !ind.build && (ind.producedMonth > 0 || ind.producedLast > 0);
}

function yardTruck(cargo: CargoType, route: Circuit): Equipment {
  return {
    kind: 'haul', route, color: BULK.has(cargo) ? '#e9b52f' : '#649392', load: CARGO[cargo].color, incoming: true,
    body: CARGO[cargo].tank ? 'tank' : TIMBER.has(cargo) ? 'flatbed' : !BULK.has(cargo) && !SILO.has(cargo) ? 'box' : undefined,
  };
}

const transferPaths = new WeakMap<Station, { station: Footprint; plant: Footprint; front: number; route: Circuit }>();

function transferPath(st: Station, ind: Industry, front: 1 | -1): Circuit {
  const cached = transferPaths.get(st);
  if (cached?.station === st.fp && cached.plant === ind.fp && cached.front === front) return cached.route;
  const main = industryServiceRoads(ind.info.kind, ind.fp).main;
  const route: WorkPoint[] = main.map((corner) => {
    const p = sitePoint(ind.fp, corner);
    return [p.x, p.y];
  });
  const { fp } = st;
  const cos = Math.cos(fp.angle);
  const sin = Math.sin(fp.angle);
  for (const [x, offset] of rearRoad(st).slice(1)) {
    const y = offset * front;
    route.push([fp.center.x + x * cos - y * sin, fp.center.y + x * sin + y * cos]);
  }
  transferPaths.set(st, { station: fp, plant: ind.fp, front, route });
  return route;
}

/** Один рейс по дороге предприятия и через задние ворота на разгрузку. */
export function drawIndustryTransfer(c: CanvasRenderingContext2D, st: Station, ind: Industry, front: 1 | -1, zoom: number, time: number): boolean {
  if (!st.industryAccess || zoom <= 0.5 || !working(ind)) return false;
  paintEquipment(c, yardTruck(ind.info.produces, transferPath(st, ind, front)), 0, 0, st.id, time);
  return true;
}
