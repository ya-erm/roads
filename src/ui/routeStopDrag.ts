import { edgeScrollStep, EDGE_PX } from './edgeScroll';

const GRIP = '[data-stop-reorder]';
const ROW = '.stop[data-i][data-line]';

interface StopDrag {
  pointer: number;
  line: number;
  from: number;
  rows: HTMLElement[];
  x: number;
  y: number;
  mark?: { row: HTMLElement; to: number };
}

/** Переставляет одну остановку за ручку мышью, касанием или стрелками с клавиатуры. */
export function bindStopReorder(side: HTMLElement, move: (line: number, from: number, to: number) => void, release: () => void): void {
  let drag: StopDrag | null = null;
  let scrollFrame = 0;

  const gripOf = (e: Event) => e.target instanceof Element ? e.target.closest<HTMLButtonElement>(GRIP) : null;
  const clearMark = () => {
    drag?.mark?.row.classList.remove('stop-drop-before', 'stop-drop-after');
    if (drag) delete drag.mark;
  };
  const markDrop = () => {
    if (!drag) return;
    clearMark();
    const bounds = side.getBoundingClientRect();
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top - EDGE_PX || drag.y > bounds.bottom + EDGE_PX) return;
    const { rows, from, y } = drag;
    const before = rows.findIndex((row) => {
      const r = row.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    const insertion = before === -1 ? rows.length : before;
    const to = insertion > from ? insertion - 1 : insertion;
    if (to === from) return;
    const after = insertion === rows.length;
    const row = rows[after ? insertion - 1 : insertion];
    row.classList.add(after ? 'stop-drop-after' : 'stop-drop-before');
    drag.mark = { row, to };
  };
  const scroll = () => {
    scrollFrame = 0;
    if (!drag) return;
    const r = side.getBoundingClientRect();
    if (drag.x < r.left || drag.x > r.right) return;
    const before = side.scrollTop;
    side.scrollTop += edgeScrollStep(drag.y, r.top, r.bottom);
    if (side.scrollTop === before) return;
    markDrop();
    scrollFrame = requestAnimationFrame(scroll);
  };
  const finish = (drop: boolean) => {
    if (!drag) return;
    const { line, from, mark, rows } = drag;
    rows[from].classList.remove('stop-dragged');
    clearMark();
    drag = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    release();
    if (drop && mark) move(line, from, mark.to);
  };

  side.addEventListener('pointerdown', (e) => {
    const grip = gripOf(e);
    const row = grip?.closest<HTMLElement>(ROW);
    const rows = row?.closest('.route')?.querySelectorAll<HTMLElement>(ROW);
    if (!grip || !row || !rows || drag || !e.isPrimary || e.button !== 0) return;
    drag = { pointer: e.pointerId, line: Number(row.dataset.line), from: Number(row.dataset.i), rows: [...rows], x: e.clientX, y: e.clientY };
    grip.setPointerCapture(e.pointerId);
    row.classList.add('stop-dragged');
  });
  side.addEventListener('pointermove', (e) => {
    if (e.pointerId !== drag?.pointer) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    markDrop();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scroll);
  });
  side.addEventListener('pointerup', (e) => {
    if (e.pointerId !== drag?.pointer) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    markDrop();
    finish(true);
  });
  const cancel = (e: PointerEvent) => {
    if (e.pointerId === drag?.pointer) finish(false);
  };
  side.addEventListener('pointercancel', cancel);
  side.addEventListener('lostpointercapture', cancel);
  side.addEventListener('click', (e) => {
    if (gripOf(e)) e.stopPropagation();
  });
  side.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const row = gripOf(e)?.closest<HTMLElement>(ROW);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const from = Number(row.dataset.i);
    move(Number(row.dataset.line), from, from + (e.key === 'ArrowUp' ? -1 : 1));
  });
}
