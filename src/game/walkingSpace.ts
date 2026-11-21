import type { Vec } from '../core/vec';

/** На самой узкой дорожке (2 м) два человека шириной около 0,9 м могут разойтись плечом к плечу. */
const PASS_OFFSET = 0.53;
const GAP = 1.15;
const LOOK = 6.5;

/** Положение на оси дорожки и направление движения. pace и side — решения до следующего шага. */
export interface WalkIntent {
  pos: Vec;
  dir: Vec;
  speed: number;
  crossing: boolean;
  seed: number;
  offset: Vec;
  pace: number;
  side: number;
}

/** Не проходить за один шаг больше свободного места перед человеком. */
function limit(person: WalkIntent, room: number, dt: number): void {
  if (person.speed > 0) person.pace = Math.min(person.pace, Math.max(0, room) / (person.speed * dt));
}

function meet(a: WalkIntent, b: WalkIntent, dt: number): void {
  const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
  if (dx * dx + dy * dy > LOOK * LOOK) return;
  const alongA = dx * a.dir.x + dy * a.dir.y;
  const alongB = -(dx * b.dir.x + dy * b.dir.y);
  const acrossA = dx * a.dir.y - dy * a.dir.x;
  const acrossB = dx * b.dir.y - dy * b.dir.x;
  const alignment = a.dir.x * b.dir.x + a.dir.y * b.dir.y;
  if (Math.abs(alignment) > 0.82 && Math.min(Math.abs(acrossA), Math.abs(acrossB)) < GAP) {
    if (alignment > 0) {
      // Попутный держит дистанцию и ждёт вместе с очередью перед занятой зеброй.
      if (alongA > 0 || (alongA === 0 && a.seed > b.seed)) limit(a, alongA - GAP, dt);
      else limit(b, alongB - GAP, dt);
    } else if (alongA > -GAP && alongB > -GAP) {
      // Встречные держатся каждый своей правой стороны, в том числе сразу после разворота в тупике.
      a.side = b.side = PASS_OFFSET;
      if (alongA >= 0 && alongB >= 0) {
        const lateral = Math.abs((dx + b.offset.x - a.offset.x) * a.dir.y - (dy + b.offset.y - a.offset.y) * a.dir.x);
        const gap = Math.sqrt(Math.max(0, 1 - lateral * lateral));
        if (gap > 0) {
          limit(a, (alongA - gap) / 2, dt);
          limit(b, (alongB - gap) / 2, dt);
        }
      }
    }
    return;
  }

  // На развилке уступают до пересечения линий. Тот, кто уже проходит узел или зебру, завершает движение.
  const sin = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
  if (Math.abs(sin) < 0.15) return;
  const toA = (dx * b.dir.y - dy * b.dir.x) / sin;
  const toB = (dx * a.dir.y - dy * a.dir.x) / sin;
  const clearance = GAP / Math.abs(sin);
  if (toA < -clearance || toB < -clearance) return;
  if (!a.speed || !b.speed) return;
  const etaA = toA / a.speed, etaB = toB / b.speed;
  if (Math.abs(etaA - etaB) > (clearance + GAP) / Math.min(a.speed, b.speed) || Math.min(etaA, etaB) > 1.1) return;
  const aFirst = a.crossing !== b.crossing ? a.crossing : etaA === etaB ? a.seed < b.seed : etaA < etaB;
  if (aFirst) limit(b, toB - clearance, dt);
  else limit(a, toA - clearance, dt);
}

/** Сетка ограничивает поиск ближайшими прохожими; каждая пара сравнивается один раз за шаг решений. */
export function leaveWalkingSpace(people: WalkIntent[], dt: number): void {
  const columns = new Map<number, Map<number, WalkIntent[]>>();
  for (const p of people) {
    const cx = Math.floor(p.pos.x / LOOK), cy = Math.floor(p.pos.y / LOOK);
    for (let x = cx - 1; x <= cx + 1; x++) {
      const column = columns.get(x);
      if (!column) continue;
      for (let y = cy - 1; y <= cy + 1; y++) {
        const neighbors = column.get(y);
        if (neighbors) for (const other of neighbors) meet(p, other, dt);
      }
    }
    let column = columns.get(cx);
    if (!column) columns.set(cx, column = new Map());
    const here = column.get(cy);
    if (here) here.push(p);
    else column.set(cy, [p]);
  }
}
