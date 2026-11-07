/**
 * Где на карте снят баг-репорт: камера игры на момент снимка, видимая часть карты и участок, на который
 * жалуются, — в координатах мира (метры). Участок — рамка инструмента «Участок» на снимке, а если её нет —
 * то, что обведено пометками (прямоугольник, овал, острие стрелки), или кадр.
 *
 * Это попадает в текст отчёта строкой «Где на карте» (с готовыми параметрами `--area` / `--camera` для
 * `npm run shot`), в meta.json архива и в сохранение полем bugSpot: открытая партия показывает участок
 * рамкой (ui/bugSpotFrame.ts). Монитор задач находит участок в описании карточки (parseSpot).
 * Без DOM.
 */

import { grow, normBox, type Box, type Mark, type Pt, type Sketch } from './marks';

/** Камера на момент снимка: центр вида в мире, масштаб (точек экрана на метр), холст карты и где он на экране. */
export interface SnapCamera {
  x: number;
  y: number;
  zoom: number;
  /** Размер холста карты в точках экрана. */
  width: number;
  height: number;
  /** Левый верхний угол холста в окне. */
  left: number;
  top: number;
}

/** Прямоугольник в мире: x0 < x1, y0 < y1 (метры). */
export interface WorldBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Откуда участок: рамка «Участок», пометки или кадр снимка. */
export type SpotSource = 'frame' | 'marks' | 'crop';

/** Где на карте снимок. */
export interface MapSpot {
  /** Камера игрока: центр и масштаб — как `--camera x,y,zoom`. */
  camera: { x: number; y: number; zoom: number };
  /** Видимая на снимке часть карты. */
  view: WorldBox;
  /** Участок, на который жалуются. */
  area?: WorldBox;
  source?: SpotSource;
}

const round = (v: number, k = 1) => Math.round(v * k) / k;

/** Точка снимка (точки окна) → точка мира. */
export function toWorld(cam: SnapCamera, p: Pt): Pt {
  return {
    x: (p.x - cam.left - cam.width / 2) / cam.zoom + cam.x,
    y: (p.y - cam.top - cam.height / 2) / cam.zoom + cam.y,
  };
}

/** Рамка снимка → прямоугольник мира, в целых метрах (наружу). */
export function worldBox(cam: SnapCamera, box: Box): WorldBox {
  const a = toWorld(cam, { x: box.x, y: box.y });
  const b = toWorld(cam, { x: box.x + box.w, y: box.y + box.h });
  return { x0: Math.floor(Math.min(a.x, b.x)), y0: Math.floor(Math.min(a.y, b.y)), x1: Math.ceil(Math.max(a.x, b.x)), y1: Math.ceil(Math.max(a.y, b.y)) };
}

/** Запас вокруг острия стрелки, точек экрана: стрелка показывает на место — участок вокруг него. */
const ARROW_PAD = 40;

/**
 * Что обведено пометками: рамки прямоугольников и овалов и места вокруг острия стрелок — одной рамкой.
 * Линии и текст участка не задают; нет таких пометок — null.
 */
export function marksArea(marks: readonly Mark[]): Box | null {
  const boxes: Box[] = [];
  for (const m of marks) {
    if (m.kind === 'rect' || m.kind === 'ellipse') boxes.push(normBox(m.a, m.b));
    else if (m.kind === 'arrow') boxes.push(grow({ x: m.b.x, y: m.b.y, w: 0, h: 0 }, ARROW_PAD));
  }
  const ok = boxes.filter((b) => b.w >= 3 || b.h >= 3);
  if (!ok.length) return null;
  const x0 = Math.min(...ok.map((b) => b.x));
  const y0 = Math.min(...ok.map((b) => b.y));
  const x1 = Math.max(...ok.map((b) => b.x + b.w));
  const y1 = Math.max(...ok.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Участок снимка: рамка «Участок», иначе обведённое пометками, иначе кадр; нет ничего — null. */
export function sketchArea(sk: Sketch): { box: Box; source: SpotSource } | null {
  if (sk.area) return { box: sk.area, source: 'frame' };
  const marks = marksArea(sk.marks);
  if (marks) return { box: marks, source: 'marks' };
  if (sk.crop) return { box: sk.crop, source: 'crop' };
  return null;
}

/** Где на карте снимок W×H (точки окна) с пометками sk. */
export function mapSpot(cam: SnapCamera, sk: Sketch, W: number, H: number): MapSpot {
  const spot: MapSpot = {
    camera: { x: round(cam.x), y: round(cam.y), zoom: round(cam.zoom, 1000) },
    view: worldBox(cam, { x: 0, y: 0, w: W, h: H }),
  };
  const area = sketchArea(sk);
  return area ? { ...spot, area: worldBox(cam, area.box), source: area.source } : spot;
}

/** Камера, при которой участок целиком на экране width×height, с запасом margin (доля участка с каждой стороны). */
export function fitCamera(
  area: WorldBox,
  width: number,
  height: number,
  opts: { margin?: number; minZoom?: number; maxZoom?: number } = {},
): { x: number; y: number; zoom: number } {
  const m = opts.margin ?? 0.25;
  const w = Math.max(1, area.x1 - area.x0) * (1 + 2 * m);
  const h = Math.max(1, area.y1 - area.y0) * (1 + 2 * m);
  const z = Math.min(width / w, height / h);
  const zoom = Math.max(opts.minZoom ?? 0.08, Math.min(opts.maxZoom ?? 3, z));
  return { x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2, zoom: round(zoom, 1000) };
}

/** «1200,800,1520,980» — значение `--area`. */
export const areaArg = (a: WorldBox) => `${a.x0},${a.y0},${a.x1},${a.y1}`;
/** «1350,900,0.85» — значение `--camera`. */
export const cameraArg = (c: MapSpot['camera']) => `${c.x},${c.y},${c.zoom}`;

const SOURCE_LABEL: Record<SpotSource, string> = { frame: 'отмечен рамкой', marks: 'по пометкам', crop: 'по кадру снимка' };

/** Размер участка: «320 × 180 м». */
export function areaSize(a: WorldBox): string {
  return `${a.x1 - a.x0} × ${a.y1 - a.y0} м`;
}

/**
 * Строка отчёта: участок (если есть) и камера игрока, с готовыми параметрами для `npm run shot`:
 * «**Где на карте:** участок 320 × 180 м, по пометкам: x 1200…1520, y 800…980 · камера 1350, 900, ×0.85 ·
 * `--area 1200,800,1520,980` `--camera 1350,900,0.85`».
 */
export function spotLine(s: MapSpot): string {
  const cam = `камера ${s.camera.x}, ${s.camera.y}, ×${s.camera.zoom}`;
  const args = `\`--camera ${cameraArg(s.camera)}\``;
  if (!s.area) {
    const v = s.view;
    return `**Где на карте:** участок не отмечен, на снимке x ${v.x0}…${v.x1}, y ${v.y0}…${v.y1} · ${cam} · ${args}`;
  }
  const a = s.area;
  const how = s.source ? `, ${SOURCE_LABEL[s.source]}` : '';
  return `**Где на карте:** участок ${areaSize(a)}${how}: x ${a.x0}…${a.x1}, y ${a.y0}…${a.y1} · ${cam} · \`--area ${areaArg(a)}\` ${args}`;
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;

/** «x0,y0,x1,y1» → прямоугольник мира (углы — в любом порядке); не то — null. */
export function parseArea(s: string): WorldBox | null {
  const n = s.split(',').map((v) => Number(v.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [ax, ay, bx, by] = n;
  if (ax === bx || ay === by) return null;
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** «x,y,zoom» → камера; не то (или zoom не больше нуля) — null. */
export function parseCamera(s: string): MapSpot['camera'] | null {
  const n = s.split(',').map((v) => Number(v.trim()));
  if (n.length !== 3 || n.some((v) => !Number.isFinite(v)) || n[2] <= 0) return null;
  return { x: n[0], y: n[1], zoom: n[2] };
}

/**
 * Участок и камера из текста отчёта (описания карточки): параметры `--area` и `--camera` строки «Где на карте».
 * Берутся только числа — текст отчёта пишет посторонний. Нет ни того, ни другого — null.
 */
export function parseSpot(text: string): { area?: WorldBox; camera?: MapSpot['camera'] } | null {
  // Доска может заменить «--» типографским тире.
  const pick = (name: string, count: number) => {
    const re = new RegExp(String.raw`(?:--|—|–)${name}\s+(${NUM}(?:\s*,\s*${NUM}){${count - 1}})`);
    return re.exec(text)?.[1];
  };
  const a = pick('area', 4);
  const c = pick('camera', 3);
  const area = a ? parseArea(a) : null;
  const camera = c ? parseCamera(c) : null;
  if (!area && !camera) return null;
  return { ...(area ? { area } : {}), ...(camera ? { camera } : {}) };
}

/** Сохранение с полем bugSpot — где на карте отчёт (открытая партия покажет участок рамкой). Не JSON — как было. */
export function withSpot(save: string, spot: MapSpot): string {
  try {
    const data = JSON.parse(save) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return save;
    return JSON.stringify({ ...data, bugSpot: spot });
  } catch {
    return save;
  }
}

const isBox = (v: unknown): v is WorldBox => {
  const b = v as WorldBox | null;
  return !!b && typeof b === 'object' && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) && b.x1 > b.x0 && b.y1 > b.y0;
};

/** Участок из открытого сохранения (поле bugSpot); нет или испорчен — null. */
export function savedArea(data: unknown): WorldBox | null {
  const area = (data as { bugSpot?: { area?: unknown } } | null)?.bugSpot?.area;
  return isBox(area) ? { x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1 } : null;
}
