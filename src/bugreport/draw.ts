/**
 * Отрисовка пометок баг-репорта на canvas — одна и та же в редакторе и в итоговой картинке (renderSketch).
 * Без DOM: на вход — 2D-контекст, в тестах — записывающая подделка.
 */

import { arrowHead, LINE_HEIGHT, normBox, outputBox, type Box, type Mark, type Measure, type Sketch } from './marks';

/** Цвет участка карты — как у рамки копирования развязки в игре. */
export const AREA_COLOR = '#2f80ed';
/** Сторона ярлыка с булавкой у участка, точек экрана. */
export const AREA_TAG = 22;

/**
 * Участок карты, на который жалуются: синяя пунктирная рамка с лёгкой заливкой (как рамка копирования развязки)
 * и ярлык с булавкой у левого верхнего угла — над рамкой, а если сверху нет места — внутри.
 */
export function drawArea(ctx: CanvasRenderingContext2D, box: Box): void {
  ctx.save();
  ctx.fillStyle = 'rgba(47, 128, 237, 0.12)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([10, 6]);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = AREA_COLOR;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  const s = AREA_TAG;
  const x = box.x;
  const y = box.y >= s + 3 ? box.y - s - 3 : box.y + 3;
  ctx.fillStyle = AREA_COLOR;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.fill();
  ctx.stroke();
  // Булавка: круглая головка и острие вниз.
  const cx = x + s / 2;
  const cy = y + s * 0.42;
  const r = s * 0.22;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.95, cy + r * 0.3);
  ctx.lineTo(cx, y + s * 0.86);
  ctx.lineTo(cx + r * 0.95, cy + r * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = AREA_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Шрифт текста пометок. */
export const markFont = (size: number) => `600 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

/** Яркость цвета #rgb / #rrggbb от 0 до 1 (неизвестный формат — как средний). */
export function luminance(color: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return 0.5;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Обводка вокруг букв, чтобы текст читался и на карте, и на панелях: у светлого текста тёмная, у тёмного — светлая. */
export function haloFor(color: string): string {
  return luminance(color) > 0.6 ? 'rgba(20, 26, 32, 0.8)' : 'rgba(255, 255, 255, 0.92)';
}

/** Ширина строки в браузере: меряет скрытый canvas тем же шрифтом, что рисует. */
export function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (line, size) => {
    ctx.font = markFont(size);
    return ctx.measureText(line).width;
  };
}

export function drawMark(ctx: CanvasRenderingContext2D, m: Mark): void {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (m.kind === 'text') {
    ctx.font = markFont(m.size);
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, m.size * 0.16);
    ctx.strokeStyle = haloFor(m.color);
    m.text.split('\n').forEach((line, i) => {
      const y = m.at.y + i * m.size * LINE_HEIGHT;
      ctx.strokeText(line, m.at.x, y);
      ctx.fillText(line, m.at.x, y);
    });
    ctx.restore();
    return;
  }
  ctx.lineWidth = m.width;
  ctx.beginPath();
  if (m.kind === 'rect') {
    const b = normBox(m.a, m.b);
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.stroke();
  } else if (m.kind === 'ellipse') {
    const b = normBox(m.a, m.b);
    ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (m.kind === 'line') {
    ctx.moveTo(m.a.x, m.a.y);
    ctx.lineTo(m.b.x, m.b.y);
    ctx.stroke();
  } else {
    const head = arrowHead(m.a, m.b, m.width);
    // Линия — до основания наконечника: толстая линия не вылезает из-под острия.
    const end = head ? head.base : m.b;
    ctx.moveTo(m.a.x, m.a.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    if (head) {
      ctx.beginPath();
      ctx.moveTo(head.tip.x, head.tip.y);
      ctx.lineTo(head.left.x, head.left.y);
      ctx.lineTo(head.right.x, head.right.y);
      ctx.closePath();
      ctx.lineWidth = Math.max(1, m.width * 0.6);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Пометки по порядку (последняя — сверху); skip — пропустить одну (текст, который сейчас правят в поле ввода). */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: readonly Mark[], skip: number | null = null): void {
  for (const m of marks) if (m.id !== skip) drawMark(ctx, m);
}

/** Размер итоговой картинки в пикселях: кадр × scale (плотность пикселей снимка). */
export function outputSize(sk: Sketch, W: number, H: number, scale: number): { width: number; height: number } {
  const box = outputBox(sk, W, H);
  return { width: Math.max(1, Math.round(box.w * scale)), height: Math.max(1, Math.round(box.h * scale)) };
}

/**
 * Итоговая картинка: снимок W×H (в точках экрана; image — в пикселях, scale на точку) с пометками, по кадру.
 * ctx — контекст canvas размером outputSize.
 */
export function renderSketch(ctx: CanvasRenderingContext2D, image: CanvasImageSource, sk: Sketch, W: number, H: number, scale: number): void {
  const box = outputBox(sk, W, H);
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  ctx.drawImage(image, 0, 0, W, H);
  // Участок — под пометками: обведённое поверх него остаётся видно.
  if (sk.area) drawArea(ctx, sk.area);
  drawMarks(ctx, sk.marks);
  ctx.restore();
}
