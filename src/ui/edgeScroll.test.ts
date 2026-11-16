import { describe, expect, it } from 'vitest';
import { EDGE_MAX_STEP, edgeScrollStep } from './edgeScroll';

describe('автопрокрутка панели при перетаскивании', () => {
  const top = 100;
  const bottom = 700;

  it('посередине панели — стоит', () => {
    expect(edgeScrollStep(400, top, bottom)).toBe(0);
    expect(edgeScrollStep(top + 56, top, bottom)).toBe(0);
  });

  it('у верхнего края — вверх, у нижнего — вниз', () => {
    expect(edgeScrollStep(top + 10, top, bottom)).toBeLessThan(0);
    expect(edgeScrollStep(bottom - 10, top, bottom)).toBeGreaterThan(0);
  });

  it('чем ближе к краю, тем быстрее; у края и за ним — быстрее всего', () => {
    expect(Math.abs(edgeScrollStep(top + 5, top, bottom))).toBeGreaterThan(Math.abs(edgeScrollStep(top + 40, top, bottom)));
    expect(edgeScrollStep(top, top, bottom)).toBe(-EDGE_MAX_STEP);
    expect(edgeScrollStep(top - 30, top, bottom)).toBe(-EDGE_MAX_STEP);
    expect(edgeScrollStep(bottom + 30, top, bottom)).toBe(EDGE_MAX_STEP);
  });

  it('в полосе у края — хоть понемногу, но едет', () => {
    expect(edgeScrollStep(top + 55, top, bottom)).toBe(-1);
  });

  it('далеко за краем — стоит', () => {
    expect(edgeScrollStep(top - 200, top, bottom)).toBe(0);
    expect(edgeScrollStep(bottom + 200, top, bottom)).toBe(0);
  });

  it('у низкой панели полоса не больше трети высоты: посередине не едет', () => {
    expect(edgeScrollStep(150, 100, 200)).toBe(0);
    expect(edgeScrollStep(105, 100, 200)).toBeLessThan(0);
  });
});
