import { describe, expect, it } from 'vitest';
import { AMBIENT_FPS, INPUT_TAIL_MS, MAX_FPS, RedrawGate } from './redraw';

/** Сколько кадров нарисовано за ms миллисекунд на экране hz (кадры requestAnimationFrame — по развёртке). */
function drawn(g: RedrawGate, hz: number, ms: number, frame: (now: number) => Parameters<RedrawGate['need']>): number {
  let n = 0;
  for (let i = 1; i <= Math.round((ms * hz) / 1000); i++) {
    const now = 1000 + i * (1000 / hz);
    if (g.need(...frame(now))) n++;
  }
  return n;
}

describe('Кадр без изменений не перерисовывается', () => {
  it('первый кадр — всегда; потом без изменений и движения — нет', () => {
    const g = new RedrawGate();
    expect(g.need(0, [1, 'a'], [0], 'none')).toBe(true);
    expect(g.need(16, [1, 'a'], [0], 'none')).toBe(false);
    expect(g.need(32, [1, 'a'], [0], 'none')).toBe(false);
  });

  it('поменялся вид (камера, партия…) — рисуем сразу; та же партия — объект сравнивается сам по себе', () => {
    const g = new RedrawGate();
    const game = {};
    g.need(0, [game, 1], [], 'none');
    expect(g.need(4, [game, 1.5], [], 'none')).toBe(true);
    expect(g.need(8, [game, 1.5], [], 'none')).toBe(false);
    expect(g.need(12, [{}, 1.5], [], 'none')).toBe(true);
    expect(g.need(16, [game, 1.5, 'ещё'], [], 'none')).toBe(true);
  });

  it('поменялось состояние партии — рисуем, но не чаще MAX_FPS, и изменение не теряется', () => {
    const g = new RedrawGate();
    g.need(0, [1], [0], 'none');
    // Через 8 мс (экран 120 Гц) — рано: ждёт.
    expect(g.need(8, [1], [1], 'none')).toBe(false);
    // Следующий кадр — уже можно, хотя подпись больше не менялась.
    expect(g.need(16.7, [1], [1], 'none')).toBe(true);
    expect(g.need(33.4, [1], [1], 'none')).toBe(false);
  });

  it('живое движение: на 60 Гц — каждый кадр, на 120 Гц — каждый второй (не больше MAX_FPS)', () => {
    expect(MAX_FPS).toBe(60);
    const live = (now: number): Parameters<RedrawGate['need']> => [now, [1], [now], 'live'];
    expect(drawn(new RedrawGate(), 60, 1000, live)).toBe(60);
    expect(drawn(new RedrawGate(), 120, 1000, live)).toBe(60);
    // 144 Гц и выше — в среднем те же 60.
    expect(Math.abs(drawn(new RedrawGate(), 144, 1000, live) - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(drawn(new RedrawGate(), 1000, 1000, live) - 60)).toBeLessThanOrEqual(1);
  });

  it('движется только фон (дым, качалки) — AMBIENT_FPS на любом экране; движения нет — кадров нет', () => {
    expect(AMBIENT_FPS).toBe(30);
    const ambient = (now: number): Parameters<RedrawGate['need']> => [now, [1], [0], 'ambient'];
    expect(drawn(new RedrawGate(), 60, 1000, ambient)).toBe(30);
    expect(drawn(new RedrawGate(), 120, 1000, ambient)).toBe(30);
    const g = new RedrawGate();
    g.need(0, [1], [0], 'none');
    expect(drawn(g, 120, 1000, (now) => [now, [1], [0], 'none'])).toBe(0);
  });

  it('прокрутка и зум (вид меняется каждый кадр) — с частотой экрана, без ограничения', () => {
    expect(drawn(new RedrawGate(), 120, 1000, (now) => [now, [now], [0], 'live'])).toBe(120);
  });

  it('после ввода рисуем ещё INPUT_TAIL_MS (не чаще MAX_FPS)', () => {
    const g = new RedrawGate();
    g.need(0, [1], [0], 'none');
    g.poke(100);
    expect(g.need(116, [1], [0], 'none')).toBe(true);
    expect(g.need(100 + INPUT_TAIL_MS - 1, [1], [0], 'none')).toBe(true);
    expect(g.need(100 + INPUT_TAIL_MS + 20, [1], [0], 'none')).toBe(false);
  });
});
