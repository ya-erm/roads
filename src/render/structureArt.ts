/**
 * Стройка мостов и тоннелей на карте — своя, не как у дороги на земле (src/render/constructionArt.ts рисует этапы,
 * а здесь — что у сооружений своё):
 * - мост (участок слоя выше земли, пандусы тоже): вместо отсыпки 🟫 растёт конструкция — впереди опоры (сначала
 *   фундамент, потом опора с ригелем, bridgePiers), за ними балки пролёта до края работ, за балками — плита настила
 *   (slabTo); дальше покрытие и разметка, как у дороги. Техника этапа — автокран со стрелой над пролётом и бетоновоз;
 * - тоннель (участок слоя под землёй): машины въезжают в портал и уходят под землю (tunnelSight, drawInSight: у
 *   портала кузов по линии портала делится — снаружи как есть, за линией призраком; глубже видны сквозь землю
 *   полупрозрачными и приглушёнными, ghostly, как машины в готовом тоннеле), у входного портала — проходческое хозяйство (entryPortal,
 *   drawPortalGear), а ход работ виден сквозь землю: пройденная часть — тёмной выработкой с кольцами обделки (в
 *   плитках, constructionArt), у края каждого этапа — огонёк (drawWorkLights), у щита — крупный и мерцающий.
 * Статичное (опоры, балки, настил, выработка) — в плитках кэша карты по шагам drawStep (их подпись — projectSig),
 * движущееся (техника, огоньки, хозяйство у портала) — в динамическом проходе кадра.
 */
import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { convoyGap, spansOf } from '../game/constructionWork';
import type { Corridor, LaneNet } from '../lanes/model';
import { corridorLayer } from '../lanes/speedDisplay';
import { type Portal, tunnelPortals } from '../lanes/tunnel';
import { corridorHalf } from '../world/worldgen';

/** Что строят на участке: дорогу на земле, мост (эстакаду, пандус к ним) или тоннель (и спуск в него). */
export type SiteKind = 'road' | 'bridge' | 'tunnel';

/** Вид стройки участка c — по слою, в котором его рисует отрисовка дорог. */
export function siteKind(net: LaneNet, c: Corridor): SiteKind {
  const l = corridorLayer(net, c);
  return l < 0 ? 'tunnel' : l > 0 ? 'bridge' : 'road';
}

// ---------- Мост ----------

/** Шаг опор моста по оси, м. */
export const PIER_STEP = 30;
/** Опоры ставят впереди пролёта: на столько метров дальше края балок — уже опора целиком, ещё на столько — фундамент. */
export const PIER_LEAD = 30;
/** У пандуса ниже стольких метров над землёй опор нет: там пролёт ложится на насыпь у устоя. */
const PIER_MIN = 1.5;

export interface Pier {
  /** Метров по оси от узла a. */
  s: number;
  /** Опора целиком (столб с ригелем), иначе — только фундамент. */
  full: boolean;
}

/**
 * Опоры участка-моста длиной L: через PIER_STEP по оси, где полотно выше PIER_MIN (deck(s) — высота, м). Видны те,
 * до которых дошли: целиком — до края балок beams (метров от начала заполнения; fromB — от конца b) и ещё PIER_LEAD
 * за ним, фундаментом — на PIER_LEAD дальше. Не начатый участок — без опор.
 */
export function bridgePiers(L: number, deck: (s: number) => number, beams: number, fromB: boolean): Pier[] {
  const out: Pier[] = [];
  if (!(beams > 0)) return out;
  for (let s = PIER_STEP / 2; s < L; s += PIER_STEP) {
    if (deck(s) < PIER_MIN) continue;
    const u = fromB ? L - s : s;
    if (u > beams + 2 * PIER_LEAD) continue;
    out.push({ s, full: u <= beams + PIER_LEAD });
  }
  return out;
}

/**
 * Докуда (метров от начала заполнения) лежит плита настила, когда балки дошли до beams на участке длиной L: отстаёт
 * от балок, но не больше чем на половину интервала колонны (покрытие идёт за ней), и к концу участка плавно догоняет.
 */
export function slabTo(beams: number, L: number): number {
  const lag = Math.min(12, convoyGap(L) / 2);
  if (!(lag > 0) || beams <= 0) return Math.max(0, Math.min(L, beams));
  if (beams >= L) return L;
  return Math.max(0, beams - lag * Math.min(1, (L - beams) / lag));
}

// ---------- Тоннель: что под землёй ----------

interface Underground {
  version: number;
  portals: Portal[];
  tunnels: Corridor[];
}

const underCache = new WeakMap<LaneNet, Underground>();

/** Порталы и полотна тоннелей сети (и готовых, и строящихся) — кэш по версии сети. */
export function undergroundOf(net: LaneNet): Underground {
  const hit = underCache.get(net);
  if (hit && hit.version === net.version) return hit;
  const tunnels = [...net.corridors.values()].filter((c) => corridorLayer(net, c) < 0);
  const res = { version: net.version, portals: tunnelPortals(net, tunnels), tunnels };
  underCache.set(net, res);
  return res;
}

/**
 * Точка p — под землёй: на полотне тоннеля (в его полосе с запасом), не за порталом (конец полотна на уровне земли).
 * Конец в глубине (стык двух полотен тоннеля) — тоже под землёй.
 */
export function buried(net: LaneNet, p: Vec): boolean {
  for (const c of undergroundOf(net).tunnels) {
    const q = c.curve;
    const pad = 40;
    if (p.x < Math.min(q.p0.x, q.p1.x, q.p2.x, q.p3.x) - pad || p.x > Math.max(q.p0.x, q.p1.x, q.p2.x, q.p3.x) + pad) continue;
    if (p.y < Math.min(q.p0.y, q.p1.y, q.p2.y, q.p3.y) - pad || p.y > Math.max(q.p0.y, q.p1.y, q.p2.y, q.p3.y) + pad) continue;
    const hit = c.lut.closest(p);
    if (hit.d > corridorHalf(c) + 6) continue;
    const deepA = net.node(c.a).level < -0.25;
    const deepB = net.node(c.b).level < -0.25;
    if ((hit.s > 0.5 || deepA) && (hit.s < c.length - 0.5 || deepB)) return true;
  }
  return false;
}

/** Полуплоскость у линии портала p (с запасом в стороны на обочины): side −1 — снаружи, перед линией; 1 — за ней, под землёй. */
function portalSide(p: Portal, side: 1 | -1): Vec[] {
  const n = rightNormal(p.dir);
  const a = add(p.pos, scale(n, p.left - 40));
  const b = add(p.pos, scale(n, p.right + 40));
  const d = scale(p.dir, side * 80);
  return [a, b, add(b, d), add(a, d)];
}

/** Снаружи портала p: полуплоскость перед его линией (с запасом в стороны на обочины) — кусок, где кузов виден как есть. */
export const outsideOf = (p: Portal): Vec[] => portalSide(p, -1);

/** За линией портала p (под землёй): кусок, где кузов виден призраком сквозь землю. */
export const insideOf = (p: Portal): Vec[] => portalSide(p, 1);

/**
 * Как рисовать машину стройки у тоннеля: как есть, призраком (под землёй, сквозь неё — ghostly) или у портала по
 * частям — снаружи (out) как есть, за линией (under) призраком.
 */
export type Sight = 'show' | 'ghost' | { out: Vec[]; under: Vec[] };

/** Непрозрачность техники под землёй (сквозь землю, поверх выработки) — как у машин в готовом тоннеле. */
export const GHOST_ALPHA = 0.4;
/** Под землёй техника ещё и чуть приглушённая: блёклее и темнее (где canvas filter есть). */
const GHOST_FILTER = 'saturate(0.55) brightness(0.85)';

/**
 * Видна ли машина длиной length с носом в nose (смотрит по dir): у портала (на его проезде или обочине рядом, кузов
 * у линии) — по частям по линии портала, так что въезжает под землю постепенно, без скачка; глубже в тоннеле —
 * призраком; иначе — как есть.
 */
export function tunnelSight(net: LaneNet, nose: Vec, dir: Vec, length: number): Sight {
  const u = undergroundOf(net);
  if (!u.tunnels.length) return 'show';
  for (const p of u.portals) {
    const rel = sub(nose, p.pos);
    const along = dot(rel, p.dir);
    const lat = dot(rel, rightNormal(p.dir));
    if (lat < p.left - 12 || lat > p.right + 12) continue;
    // Кузов тянется от носа назад — у портала он, если нос чуть за линией (въезжает) или чуть перед ней (выезжает
    // задом наперёд не бывает, но нос перед линией — значит, весь кузов снаружи).
    if (along > -2 && along < length + 4 && dot(dir, p.dir) > -0.2) return { out: outsideOf(p), under: insideOf(p) };
    if (along < 2 && along > -(length + 4) && dot(dir, p.dir) < 0.2) return { out: outsideOf(p), under: insideOf(p) };
  }
  return buried(net, nose) ? 'ghost' : 'show';
}

/** Рисует draw призраком: полупрозрачно (GHOST_ALPHA от текущей) и приглушённо — так видно технику сквозь землю. */
export function ghostly(ctx: CanvasRenderingContext2D, draw: () => void): void {
  ctx.save();
  ctx.globalAlpha *= GHOST_ALPHA;
  ctx.filter = GHOST_FILTER;
  draw();
  ctx.restore();
}

/** Рисует машину стройки draw так, как велит sight (tunnelSight): как есть, призраком или по частям у портала. */
export function drawInSight(ctx: CanvasRenderingContext2D, sight: Sight, draw: () => void): void {
  if (sight === 'show') return draw();
  if (sight === 'ghost') return ghostly(ctx, draw);
  const clipped = (poly: Vec[], fn: () => void) => {
    ctx.save();
    ctx.beginPath();
    poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.clip();
    fn();
    ctx.restore();
  };
  clipped(sight.out, draw);
  clipped(sight.under, () => ghostly(ctx, draw));
}

/**
 * Входной портал тоннеля для участка c — через него техника въезжает под землю: позади начала заполнения (против
 * хода стройки), смотрит внутрь по ходу, ближайший. Нет такого (участок в глубине без портала позади) — null.
 */
export function entryPortal(net: LaneNet, c: Corridor): Portal | null {
  const b = c.build;
  if (!b) return null;
  const s = b.fromB ? c.length : 0;
  const start = c.lut.pointAt(s);
  const t = c.lut.tangentAt(s);
  const dir = b.fromB ? scale(t, -1) : t;
  let best: Portal | null = null;
  let bd = 2500;
  for (const p of undergroundOf(net).portals) {
    if (dot(sub(p.pos, start), dir) > 1 || dot(p.dir, dir) < 0.3) continue;
    const d = dist(p.pos, start);
    if (d < bd) [best, bd] = [p, d];
  }
  return best;
}

/** Где под землёй края работ участка-тоннеля: у каждого начатого и не кончившего этапа — точка оси и этап. */
export function workLights(c: Corridor): { pos: Vec; stage: 0 | 1 | 2 }[] {
  const b = c.build;
  if (!b) return [];
  const L = c.length;
  return spansOf(b, L).flatMap((f, k) => (f > 0 && f < L - 1e-6 ? [{ pos: c.lut.pointAt(b.fromB ? L - f : f), stage: k as 0 | 1 | 2 }] : []));
}

/**
 * Огоньки работ под землёй (сквозь неё, поверх карты): у щита — крупный оранжевый, мерцает, пока работают; у
 * покрытия — жёлтый, у разметки — белый, поменьше. t — время игры, с.
 */
export function drawWorkLights(ctx: CanvasRenderingContext2D, c: Corridor, t: number, working: boolean): void {
  const looks = [
    { r: 9, core: 1.8, color: '255, 136, 40', hot: '#ffd27a' },
    { r: 5, core: 1.2, color: '255, 206, 84', hot: '#fff0b8' },
    { r: 4, core: 1, color: '235, 240, 255', hot: '#ffffff' },
  ];
  ctx.save();
  for (const { pos, stage } of workLights(c)) {
    const look = looks[stage];
    const pulse = working ? 1 + 0.18 * Math.sin(t * 7 + stage * 2) : 0.8;
    const r = look.r * pulse;
    const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
    g.addColorStop(0, `rgba(${look.color}, ${working ? 0.75 : 0.45})`);
    g.addColorStop(1, `rgba(${look.color}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.hot;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, look.core, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Хозяйство у входного портала p, пока тоннель строят: на обочине слева — вентиляционная установка с трубой в портал
 * (вентилятор крутится, пока работают), отвал вынутого грунта и ленточный транспортёр к нему.
 */
export function drawPortalGear(ctx: CanvasRenderingContext2D, p: Portal, t: number, working: boolean): void {
  const n = rightNormal(p.dir);
  const at = (lat: number, along: number) => add(add(p.pos, scale(n, lat)), scale(p.dir, along));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Отвал грунта — справа от портала, транспортёр к нему из зева.
  const heap = at(p.right + 9, -10);
  ctx.strokeStyle = '#4d4f55';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const belt0 = at(p.right - 1.5, 1);
  ctx.moveTo(belt0.x, belt0.y);
  ctx.lineTo(heap.x, heap.y);
  ctx.stroke();
  ctx.fillStyle = '#8a6a48';
  ctx.strokeStyle = '#6e5236';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.ellipse(heap.x, heap.y, 6, 4.5, Math.atan2(p.dir.y, p.dir.x), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#a3825c';
  ctx.beginPath();
  ctx.ellipse(heap.x - 1, heap.y - 1, 3, 2.2, Math.atan2(p.dir.y, p.dir.x), 0, Math.PI * 2);
  ctx.fill();
  // Вентиляционная труба — вдоль левой стенки в портал.
  const duct0 = at(p.left - 5, -8);
  const duct1 = at(p.left + 0.8, 0);
  const duct2 = at(p.left + 0.8, 6);
  ctx.strokeStyle = '#f2b81d';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(duct0.x, duct0.y);
  ctx.lineTo(duct1.x, duct1.y);
  ctx.lineTo(duct2.x, duct2.y);
  ctx.stroke();
  // Вентиляционная установка: короб и вентилятор с лопастями.
  ctx.save();
  const box = at(p.left - 7, -11);
  ctx.translate(box.x, box.y);
  ctx.rotate(Math.atan2(p.dir.y, p.dir.x));
  ctx.fillStyle = '#9aa1a8';
  ctx.strokeStyle = '#5f666d';
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.rect(-3.5, -2.5, 7, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#3d4148';
  ctx.beginPath();
  ctx.arc(0, 0, 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#d6d9dd';
  ctx.lineWidth = 0.45;
  const a0 = working ? t * 9 : 0;
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * 1.7, Math.sin(a) * 1.7);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

// ---------- Техника сооружений (в координатах машины: нос в 0, ход по +x; рисует drawMachines) ----------

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke = '#6b5410'): void {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
}

/**
 * Мост, этап конструкции: автокран на опорах-выносных с поворотной стрелой вперёд, над пролётом (качается, подавая
 * балку), за ним бетоновоз с вращающимся барабаном. Ответ — где на машине маячок (x).
 */
export function drawCraneSet(ctx: CanvasRenderingContext2D, t: number): number {
  // Бетоновоз: шасси, кабина впереди, барабан с полосами, что бегут по кругу.
  box(ctx, -16.5, -1.3, 5.5, 2.6, '#d8dbe0', '#7b8189');
  box(ctx, -12.4, -1.2, 1.4, 2.4, '#f2b81d');
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(-14.4, 0, 2.2, 1.15, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#e8743b';
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = '#f6c29a';
  ctx.lineWidth = 0.45;
  for (let i = 0; i < 3; i++) {
    const x = -16.8 + ((t * 2.2 + i * 1.6) % 4.8);
    ctx.beginPath();
    ctx.moveTo(x, -1.3);
    ctx.lineTo(x + 0.9, 1.3);
    ctx.stroke();
  }
  ctx.restore();
  // Автокран: выносные опоры, шасси, поворотная платформа.
  ctx.strokeStyle = '#4d4f55';
  ctx.lineWidth = 0.45;
  for (const x of [-9.2, -4.3]) {
    ctx.beginPath();
    ctx.moveTo(x, -2.8);
    ctx.lineTo(x, 2.8);
    ctx.stroke();
  }
  box(ctx, -10, -1.5, 6.5, 3, '#f2b81d');
  ctx.fillStyle = '#e0a81a';
  ctx.beginPath();
  ctx.arc(-6.6, 0, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Стрела: вперёд над пролётом, качается; на крюке — балка поперёк.
  const a = 0.32 * Math.sin(t * 0.7);
  const tip = { x: -6.6 + Math.cos(a) * 13, y: Math.sin(a) * 13 };
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#6b5410';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-6.6, 0);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.strokeStyle = '#f2b81d';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.save();
  ctx.translate(tip.x, tip.y);
  ctx.rotate(a * 0.4);
  box(ctx, -0.6, -3, 1.2, 6, '#9c968b', '#5f5a52');
  ctx.restore();
  return -5;
}

/**
 * Тоннель, этап проходки: щит — цилиндр с режущим ротором впереди (резцы бегут по кругу), за ним тележка с
 * оборудованием. Под землёй он виден призраком сквозь землю (drawInSight). Ответ — где маячок (x).
 */
export function drawShieldSet(ctx: CanvasRenderingContext2D, t: number): number {
  // Тележка с оборудованием.
  box(ctx, -17, -1.8, 5, 3.6, '#c9ccd1', '#6f757c');
  ctx.strokeStyle = '#6f757c';
  ctx.lineWidth = 0.3;
  for (const x of [-15.5, -14, -12.5]) {
    ctx.beginPath();
    ctx.moveTo(x, -1.8);
    ctx.lineTo(x, 1.8);
    ctx.stroke();
  }
  // Корпус щита с кольцами.
  box(ctx, -11.5, -2.6, 10, 5.2, '#e8b53a');
  ctx.strokeStyle = '#b8892a';
  for (const x of [-9, -6.5, -4]) {
    ctx.beginPath();
    ctx.moveTo(x, -2.6);
    ctx.lineTo(x, 2.6);
    ctx.stroke();
  }
  // Ротор: тёмный диск поперёк, резцы — бегущими точками.
  box(ctx, -1.5, -2.9, 1.5, 5.8, '#55585e', '#2f3237');
  ctx.fillStyle = '#c9ccd1';
  for (let i = 0; i < 4; i++) {
    const y = -2.6 + ((t * 3 + i * 1.3) % 5.2);
    ctx.fillRect(-1.2, y, 0.9, 0.4);
  }
  return -6;
}
