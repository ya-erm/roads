/**
 * Графика режима «Строит игрок» (docs/INDUSTRIES.md): месторождения на земле (выходы руды и угля, нефтяные пятна
 * с вышкой, карьерные откосы, поля, лесные делянки, сети рыбаков) — размер по площади и густоте; копоть земли у
 * вредных предприятий; заброшенные (ржавчина, выбитые окна, трава); стройплощадка (котлован, леса, кран, штабеля,
 * здание растёт по готовности). Всё неподвижное рисуется в плитки кэша карты; мелочи — только вблизи.
 */
import { ENTERPRISE } from '../config';
import { dist } from '../core/vec';
import { CARGO, INDUSTRY_TYPES, type IndustryKind } from '../world/cargo';
import { harmClass, harmReach, isActive } from '../world/enterprise';
import type { Deposit, Industry, TownBuilding } from '../world/entities';
import { type Footprint, footprintRadius } from '../world/spatial';
import { disc, drawIndustryArt, hash, shade, YELLOW } from './industryArt';

/** Как выглядит месторождение вида: выходы породы, карьер, нефть, поле, лес, рыбное место. */
type Look = 'rock' | 'pit' | 'oil' | 'gas' | 'field' | 'meadow' | 'wood' | 'fish';

const LOOK: Partial<Record<IndustryKind, Look>> = {
  coalmine: 'rock',
  ironmine: 'rock',
  coppermine: 'rock',
  goldmine: 'rock',
  gemmine: 'rock',
  quarry: 'pit',
  sandpit: 'pit',
  claypit: 'pit',
  oilwell: 'oil',
  gasfield: 'gas',
  farm: 'field',
  flaxfarm: 'field',
  sunflower: 'field',
  cottonfarm: 'field',
  ranch: 'meadow',
  sheepfarm: 'meadow',
  forest: 'wood',
  fishery: 'fish',
};

/** Цвет породы или посевов месторождения. */
const TINT: Partial<Record<IndustryKind, string>> = {
  coalmine: '#3d4148',
  ironmine: '#9a5a3a',
  coppermine: '#2f8a7f',
  goldmine: '#c9a227',
  gemmine: '#7b4fbf',
  quarry: '#a7adb3',
  sandpit: '#e2cc95',
  claypit: '#c4784e',
  farm: '#d9b84a',
  flaxfarm: '#7d96d6',
  sunflower: '#e8c02a',
  cottonfarm: '#f2f0e6',
};

/** Радиус пятна месторождения: по размеру (малое — меньше). */
export function depositRadius(d: Pick<Deposit, 'size'>): number {
  return ENTERPRISE.deposits.radius * (0.7 + 0.15 * d.size);
}

/** Рамка месторождения на карте — для кэша плиток (с запасом под значок). */
export function depositBox(d: Deposit): { x0: number; y0: number; x1: number; y1: number } {
  const r = depositRadius(d) + 30;
  return { x0: d.center.x - r, y0: d.center.y - r, x1: d.center.x + r, y1: d.center.y + r };
}

/** Подпись месторождения для кэша плиток: где, какое, занято ли (занятое не рисуется — на нём предприятие). */
export const depositSig = (d: Deposit): string => `${d.kind}|${d.size}|${d.center.x},${d.center.y}|${d.used ?? ''}`;

/** Неровное пятно по кругу с «шумом» (как кучи и карьеры у предприятий). */
function blob(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, seed: number, jit: number): void {
  const k = 10;
  const pts: number[] = [];
  for (let j = 0; j < k; j++) {
    const a = (j / k) * Math.PI * 2;
    const m = 1 + (hash(seed, j) - 0.5) * 2 * jit;
    pts.push(x + Math.cos(a) * rx * m, y + Math.sin(a) * ry * m);
  }
  c.moveTo((pts[2 * k - 2] + pts[0]) / 2, (pts[2 * k - 1] + pts[1]) / 2);
  for (let j = 0; j < k; j++) {
    const n = (j + 1) % k;
    c.quadraticCurveTo(pts[2 * j], pts[2 * j + 1], (pts[2 * j] + pts[2 * n]) / 2, (pts[2 * j + 1] + pts[2 * n + 1]) / 2);
  }
  c.closePath();
}

/** Точки внутри круга радиуса r — по зерну, равномерно по площади. */
function scatter(seed: number, n: number, r: number, f: (x: number, y: number, i: number) => void): void {
  for (let i = 0; i < n; i++) {
    const a = hash(seed, i * 3) * Math.PI * 2;
    const rr = Math.sqrt(hash(seed, i * 3 + 1)) * r;
    f(Math.cos(a) * rr, Math.sin(a) * rr, i);
  }
}

/**
 * Месторождение на земле (в плитках кэша). zoom — сколько мелочей. Значок груза с точками размера — подписью
 * поверх, в каждом кадре (renderer, drawLabels). Занятое (used) не рисуется: на нём стоит предприятие.
 */
export function drawDeposit(c: CanvasRenderingContext2D, d: Deposit, zoom: number): void {
  if (d.used !== undefined) return;
  const look = LOOK[d.kind] ?? 'rock';
  const tint = TINT[d.kind] ?? CARGO[INDUSTRY_TYPES[d.kind].produces].color;
  const R = depositRadius(d);
  const seed = d.id * 7919;
  const near = zoom > 0.3;
  const n = (base: number) => Math.round(base * (1 + d.size * 0.6));
  c.save();
  c.translate(d.center.x, d.center.y);
  c.rotate(d.angle);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  // Подложка: пятно земли цвета ресурса, мягкая кайма пунктиром — «здесь что-то есть».
  c.beginPath();
  blob(c, 0, 0, R, R * 0.82, seed, 0.18);
  c.fillStyle = look === 'field' || look === 'meadow' ? 'rgba(170,190,110,0.28)' : look === 'oil' ? 'rgba(60,50,70,0.12)' : `${hexA(tint, 0.14)}`;
  c.fill();
  if (near) {
    c.setLineDash([6, 5]);
    c.strokeStyle = hexA(shade(tint, -0.3), 0.55);
    c.lineWidth = 1.4;
    c.stroke();
    c.setLineDash([]);
  }
  switch (look) {
    case 'rock':
      // Выходы породы: камни цвета руды с гранями света и тени, у золота и самоцветов — блёстки.
      scatter(seed, n(near ? 9 : 5), R * 0.75, (x, y, i) => {
        const s = 4 + hash(seed, i + 50) * 7;
        c.beginPath();
        blob(c, x, y, s, s * 0.75, seed + i, 0.35);
        c.fillStyle = shade(tint, (hash(seed, i + 70) - 0.5) * 0.4);
        c.fill();
        if (near) {
          c.strokeStyle = shade(tint, -0.45);
          c.lineWidth = 0.8;
          c.stroke();
          c.fillStyle = 'rgba(255,255,255,0.22)';
          disc(c, x - s * 0.3, y - s * 0.3, s * 0.3);
          if (d.kind === 'goldmine' || d.kind === 'gemmine') {
            c.fillStyle = d.kind === 'goldmine' ? '#fff3a6' : '#e6d4ff';
            disc(c, x + s * 0.2, y - s * 0.1, 1.2);
          }
        }
      });
      break;
    case 'pit':
      // Карьерные откосы: уступы неровными кольцами, на дне — светлее; рядом — пара куч.
      for (let k = 3; k >= 1; k--) {
        c.beginPath();
        blob(c, 0, 0, (R * 0.7 * k) / 3, (R * 0.55 * k) / 3, seed + k, 0.15);
        c.fillStyle = shade(tint, -0.12 + k * 0.06);
        c.fill();
        if (near) {
          c.strokeStyle = shade(tint, -0.35);
          c.lineWidth = 0.9;
          c.stroke();
        }
      }
      scatter(seed + 3, n(2), R * 0.8, (x, y, i) => {
        c.beginPath();
        blob(c, x, y, 5 + i, 4 + i, seed + 30 + i, 0.25);
        c.fillStyle = shade(tint, 0.1);
        c.fill();
      });
      break;
    case 'oil':
    case 'gas': {
      // Нефть — тёмные лужи с радужной кромкой и вышка-заглушка; газ — сухая трава, вентили и колечки выхода.
      if (look === 'oil')
        scatter(seed, n(3), R * 0.6, (x, y, i) => {
          c.beginPath();
          blob(c, x, y, 7 + hash(seed, i + 9) * 9, 5 + hash(seed, i + 19) * 6, seed + i, 0.3);
          c.fillStyle = '#2b2533';
          c.fill();
          if (near) {
            c.strokeStyle = 'rgba(140,110,190,0.6)';
            c.lineWidth = 1.2;
            c.stroke();
          }
        });
      else
        scatter(seed, n(4), R * 0.65, (x, y) => {
          c.strokeStyle = 'rgba(80,120,200,0.45)';
          c.lineWidth = 1;
          for (const r of [3, 6]) {
            c.beginPath();
            c.arc(x, y, r, 0, Math.PI * 2);
            c.stroke();
          }
        });
      if (near) {
        // Старая вышка-заглушка: треугольник ферм с распорками.
        c.strokeStyle = '#5c5f66';
        c.lineWidth = 1.4;
        c.beginPath();
        c.moveTo(-8, 8);
        c.lineTo(0, -12);
        c.lineTo(8, 8);
        c.moveTo(-5, 1);
        c.lineTo(5, 1);
        c.moveTo(-6.5, 5);
        c.lineTo(6.5, 5);
        c.stroke();
        c.fillStyle = '#c0392b';
        disc(c, 0, -12, 1.6);
      }
      break;
    }
    case 'field':
    case 'meadow': {
      // Поля: полосы посевов разного оттенка; луг — изгородь и стадо точками.
      const w = R * 1.4;
      const h = R * 1.0;
      if (look === 'field') {
        const strips = 2 + d.size;
        for (let k = 0; k < strips; k++) {
          const y0 = -h / 2 + (k * h) / strips;
          c.fillStyle = shade(tint, (hash(seed, k) - 0.5) * 0.25);
          c.fillRect(-w / 2, y0 + 1, w, h / strips - 2);
          if (near) {
            c.strokeStyle = shade(tint, -0.25);
            c.lineWidth = 0.6;
            c.beginPath();
            for (let x = -w / 2 + 3; x < w / 2; x += 4) {
              c.moveTo(x, y0 + 2);
              c.lineTo(x, y0 + h / strips - 2);
            }
            c.stroke();
          }
        }
      } else {
        c.strokeStyle = '#8d6a43';
        c.lineWidth = 1;
        c.strokeRect(-w / 2, -h / 2, w, h);
        scatter(seed, n(near ? 7 : 3), R * 0.55, (x, y) => {
          c.fillStyle = d.kind === 'sheepfarm' ? '#f4f1e8' : '#6b4a33';
          disc(c, x, y, 1.8);
        });
      }
      break;
    }
    case 'wood':
      // Лесная делянка: деревья вокруг уже растут (лес на карте); метки — особые тёмные ели и пни с вешками.
      scatter(seed, n(near ? 6 : 3), R * 0.7, (x, y, i) => {
        c.fillStyle = shade('#2f5a34', (hash(seed, i + 3) - 0.5) * 0.3);
        disc(c, x, y, 5 + hash(seed, i + 8) * 3);
        if (near) {
          c.fillStyle = 'rgba(255,255,255,0.12)';
          disc(c, x - 1.5, y - 1.5, 2);
        }
      });
      if (near)
        scatter(seed + 5, 3, R * 0.5, (x, y) => {
          c.fillStyle = '#c4a271';
          disc(c, x, y, 2);
          c.fillStyle = '#e8483f';
          c.fillRect(x + 2, y - 5, 1, 5);
        });
      break;
    case 'fish':
      // Рыбное место у берега: сети на вешалах и буйки.
      if (near) {
        c.strokeStyle = 'rgba(90,70,50,0.7)';
        c.lineWidth = 0.6;
        for (let k = 0; k < 2 + d.size; k++) {
          const x0 = -R * 0.5 + k * 14;
          c.beginPath();
          for (let j = 0; j <= 4; j++) {
            c.moveTo(x0, -10 + j * 5);
            c.lineTo(x0 + 10, -10 + j * 5);
            c.moveTo(x0 + j * 2.5, -10);
            c.lineTo(x0 + j * 2.5, 10);
          }
          c.stroke();
        }
      }
      scatter(seed, n(3), R * 0.7, (x, y, i) => {
        c.fillStyle = i % 2 ? '#e8483f' : '#f4f1e8';
        disc(c, x, y, 2.4);
      });
      break;
  }
  c.restore();
}

/** #rrggbb → rgba с прозрачностью a. */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- Вред: копоть земли и дома ----------

/** Радиус копоти вокруг работающего вредного предприятия; 0 — не коптит. */
export function sootRadius(ind: Industry): number {
  const cls = harmClass(ind.info.kind);
  return cls && isActive(ind) ? footprintRadius(ind.fp) + 30 + cls * 35 : 0;
}

/** Потемневшая, пожухлая земля вокруг вредного предприятия — по классу вредности. */
export function drawSoot(c: CanvasRenderingContext2D, ind: Industry): void {
  const r = sootRadius(ind);
  if (!r) return;
  const cls = harmClass(ind.info.kind);
  const p = ind.fp.center;
  const g = c.createRadialGradient(p.x, p.y, footprintRadius(ind.fp) * 0.6, p.x, p.y, r);
  g.addColorStop(0, `rgba(70,62,45,${0.12 + 0.09 * cls})`);
  g.addColorStop(0.6, `rgba(120,105,60,${0.06 + 0.05 * cls})`);
  g.addColorStop(1, 'rgba(120,105,60,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(p.x, p.y, r, 0, Math.PI * 2);
  c.fill();
}

/** Вредные работающие предприятия: от них сереют дома (houseGrime). */
export const dirtyIndustries = (list: readonly Industry[]): Industry[] => list.filter((i) => harmClass(i.info.kind) && isActive(i));

/** Насколько посерел дом от вредных предприятий рядом: 0…1 (по ближайшему, класс 3 вплотную — 1). */
export function houseGrime(b: TownBuilding, dirty: readonly Industry[]): number {
  let g = 0;
  for (const ind of dirty) {
    const cls = harmClass(ind.info.kind);
    const gap = dist(b.fp.center, ind.fp.center) - footprintRadius(ind.fp) / 2;
    const reach = harmReach(cls);
    if (gap >= reach) continue;
    g = Math.max(g, Math.min(1, (cls / 2.5) * (1 - Math.max(0, gap) / reach) ** 0.6));
  }
  return g;
}

/** Серый налёт на крыше дома в зоне вреда и пара тёмных подтёков. */
export function drawGrime(c: CanvasRenderingContext2D, b: TownBuilding, grime: number, near: boolean): void {
  if (grime < 0.05) return;
  const fp = b.fp;
  c.save();
  c.translate(fp.center.x, fp.center.y);
  c.rotate(fp.angle);
  c.fillStyle = `rgba(78,74,66,${(0.55 * grime).toFixed(3)})`;
  c.fillRect(-fp.w / 2, -fp.h / 2, fp.w, fp.h);
  if (near && grime > 0.3) {
    c.fillStyle = `rgba(50,46,40,${(0.35 * grime).toFixed(3)})`;
    const k = hash(b.id, 1);
    c.fillRect(-fp.w / 2 + fp.w * k * 0.6, -fp.h / 2, 1.4, fp.h * 0.6);
    c.fillRect(-fp.w / 2 + fp.w * (0.3 + k * 0.5), -fp.h / 2, 1, fp.h * 0.4);
  }
  c.restore();
}

// ---------- Заброшенное и стройка ----------

/** Заброшенное: обесцвеченное, ржавые пятна, выбитые окна-дыры, трава по участку. Поверх обычной сцены. */
export function drawRuinOverlay(c: CanvasRenderingContext2D, ind: Industry, zoom: number): void {
  const fp = ind.fp;
  const seed = ind.id * 131;
  c.save();
  c.translate(fp.center.x, fp.center.y);
  c.rotate(fp.angle);
  c.beginPath();
  c.roundRect(-fp.w / 2, -fp.h / 2, fp.w, fp.h, 3);
  c.clip();
  // Краски сошли: серо-бурая вуаль.
  c.fillStyle = 'rgba(128,118,100,0.5)';
  c.fillRect(-fp.w / 2, -fp.h / 2, fp.w, fp.h);
  // Ржавчина.
  scatter(seed, 7, Math.min(fp.w, fp.h) * 0.45, (x, y, i) => {
    c.beginPath();
    blob(c, x, y, 5 + hash(seed, i) * 6, 3 + hash(seed, i + 7) * 4, seed + i, 0.4);
    c.fillStyle = 'rgba(150,80,40,0.35)';
    c.fill();
  });
  if (zoom > 0.3) {
    // Выбитые окна — тёмные квадратики рядами.
    c.fillStyle = 'rgba(30,28,26,0.7)';
    for (let i = 0; i < 10; i++) {
      if (hash(seed, i + 40) < 0.45) continue;
      c.fillRect(-fp.w * 0.35 + (i % 5) * fp.w * 0.15, -fp.h * 0.18 + Math.floor(i / 5) * fp.h * 0.3, 3, 2.2);
    }
    // Проросшая трава кустиками.
    scatter(seed + 9, 18, Math.max(fp.w, fp.h) * 0.5, (x, y, i) => {
      c.fillStyle = i % 3 ? 'rgba(110,150,70,0.75)' : 'rgba(90,125,55,0.8)';
      disc(c, x, y, 1.6 + hash(seed, i + 90) * 1.8);
    });
    // Трещина в крыше.
    c.strokeStyle = 'rgba(40,36,32,0.6)';
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(-fp.w * 0.2, -fp.h * 0.3);
    c.lineTo(-fp.w * 0.05, -fp.h * 0.05);
    c.lineTo(-fp.w * 0.12, fp.h * 0.2);
    c.stroke();
  }
  c.restore();
}

/** Шаг готовности стройки для кэша плиток: картинка меняется раз в 5%. */
export const siteStep = (ind: Industry): number => (ind.build ? Math.floor(ind.build.done * 20) : -1);

/**
 * Стройплощадка: участок с разметкой, котлован, штабеля стройматериалов, здание по готовности (часть сцены —
 * с запада на восток), строительные леса по краю готового, кран над стройкой.
 */
export function drawSiteArt(c: CanvasRenderingContext2D, ind: Industry, zoom: number, time: number): void {
  const fp = ind.fp;
  const done = Math.max(0, Math.min(1, ind.build?.done ?? 1));
  const W = fp.w;
  const H = fp.h;
  const near = zoom > 0.3;
  c.save();
  c.translate(fp.center.x, fp.center.y);
  c.rotate(fp.angle);
  // Площадка: утоптанная земля, разметка углов и пунктир по периметру.
  c.fillStyle = '#c9b48f';
  c.beginPath();
  c.roundRect(-W / 2, -H / 2, W, H, 3);
  c.fill();
  c.setLineDash([5, 4]);
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 1.2;
  c.stroke();
  c.setLineDash([]);
  // Котлован — под тем, что ещё не построено.
  const edge = -W / 2 + W * done;
  if (done < 1) {
    c.fillStyle = '#a88c63';
    c.fillRect(edge + 4, -H * 0.32, W / 2 - edge - 10, H * 0.64);
    if (near) {
      c.strokeStyle = '#8a7150';
      c.lineWidth = 0.8;
      c.strokeRect(edge + 4, -H * 0.32, W / 2 - edge - 10, H * 0.64);
    }
  }
  c.restore();
  // Готовая часть здания — обычной сценой, обрезанной по готовности.
  if (done > 0.02) {
    c.save();
    c.translate(fp.center.x, fp.center.y);
    c.rotate(fp.angle);
    c.beginPath();
    c.rect(-W / 2 - 2, -H / 2 - 40, W * done + 2, H + 80);
    c.rotate(-fp.angle);
    c.translate(-fp.center.x, -fp.center.y);
    c.clip();
    drawIndustryArt(c, { ...ind, producedMonth: 0, producedLast: 0 }, zoom, time, 'still');
    c.restore();
  }
  c.save();
  c.translate(fp.center.x, fp.center.y);
  c.rotate(fp.angle);
  if (near) {
    // Строительные леса по краю готового: стойки и настилы.
    c.strokeStyle = '#b08a3e';
    c.lineWidth = 0.9;
    c.beginPath();
    for (let y = -H * 0.36; y <= H * 0.36; y += 6) {
      c.moveTo(edge - 2, y);
      c.lineTo(edge + 3, y);
    }
    c.moveTo(edge - 2, -H * 0.36);
    c.lineTo(edge - 2, H * 0.36);
    c.moveTo(edge + 3, -H * 0.36);
    c.lineTo(edge + 3, H * 0.36);
    c.stroke();
    // Штабеля: доски, кирпич, металл — в углу участка.
    const piles: [string, number][] = [
      ['#c99a5b', 0],
      ['#b5543c', 1],
      ['#7f95a6', 2],
    ];
    for (const [color, k] of piles) {
      c.fillStyle = color;
      c.fillRect(W / 2 - 14, -H / 2 + 4 + k * 7, 10, 5);
      c.strokeStyle = shade(color, -0.35);
      c.lineWidth = 0.5;
      c.strokeRect(W / 2 - 14, -H / 2 + 4 + k * 7, 10, 5);
    }
  }
  // Башенный кран: опора у края работ, стрела над недостроенным.
  const base = { x: Math.min(W / 2 - 10, edge + 8), y: H / 2 - 8 };
  const swing = Math.sin(time * 0.3 + ind.id) * 0.25;
  c.fillStyle = '#5c5f66';
  c.fillRect(base.x - 3, base.y - 3, 6, 6);
  c.strokeStyle = YELLOW;
  c.lineWidth = near ? 2.2 : 3;
  c.beginPath();
  c.moveTo(base.x, base.y);
  const jib = { x: base.x + Math.cos(-Math.PI / 2 - 0.3 + swing) * H * 0.95, y: base.y + Math.sin(-Math.PI / 2 - 0.3 + swing) * H * 0.95 };
  c.lineTo(jib.x, jib.y);
  c.stroke();
  if (near) {
    c.strokeStyle = shade(YELLOW, -0.3);
    c.lineWidth = 0.7;
    c.beginPath();
    c.moveTo((base.x + jib.x) / 2, (base.y + jib.y) / 2);
    c.lineTo((base.x + jib.x) / 2, (base.y + jib.y) / 2 + 9);
    c.stroke();
    c.fillStyle = '#5c5f66';
    c.fillRect((base.x + jib.x) / 2 - 2, (base.y + jib.y) / 2 + 9, 4, 3);
  }
  c.restore();
}

/** Подпись предприятия для кэша плиток с учётом режима «Строит игрок»: стройка по шагам, заброшенное. */
export const enterpriseSig = (ind: Industry): string => `${ind.ruin ? 'R' : ''}${ind.build ? `B${siteStep(ind)}` : ''}`;

/** Рамка, где картинка предприятия влияет на соседей: копоть и посеревшие дома в радиусе вреда. */
export function enterpriseReach(ind: Industry): number {
  const cls = harmClass(ind.info.kind);
  return cls ? harmReach(cls) + footprintRadius(ind.fp) : 0;
}

/** Предпросмотр зоны вреда участка fp вида kind: полупрозрачное оранжевое пятно и кайма. */
export function drawHarmZone(c: CanvasRenderingContext2D, kind: IndustryKind, fp: Footprint, zoom: number): void {
  const cls = harmClass(kind);
  if (!cls) return;
  const r = harmReach(cls) + footprintRadius(fp) / 2;
  const p = fp.center;
  const g = c.createRadialGradient(p.x, p.y, footprintRadius(fp) * 0.5, p.x, p.y, r);
  g.addColorStop(0, 'rgba(230,120,40,0.22)');
  g.addColorStop(1, 'rgba(230,120,40,0.05)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(p.x, p.y, r, 0, Math.PI * 2);
  c.fill();
  c.setLineDash([10 / zoom, 6 / zoom]);
  c.strokeStyle = 'rgba(214,110,30,0.85)';
  c.lineWidth = 2 / zoom;
  c.stroke();
  c.setLineDash([]);
}
