import { describe, expect, it } from 'vitest';
import { stageLayout } from './constructionWork';

describe('Стройка на карте: где рисовать отсыпку и когда этап доходит до площадки узла', () => {
  const L = 280;

  it('отсыпка — только по своему у полотна, не по площадке перекрёстка', () => {
    // Примыкание к готовой дороге у конца a: площадка — первые 38 м.
    expect(stageLayout([20, 0, 0], L, false, 38, 0).earth).toBeNull();
    expect(stageLayout([120, 80, 40], L, false, 38, 0).earth).toEqual([38, 120]);
    // Стройка от конца b к перекрёстку у a: отсыпка доходит до площадки и не заходит на неё.
    expect(stageLayout([L, L - 40, L - 80], L, true, 38, 0).earth).toEqual([38, L]);
    expect(stageLayout([100, 60, 20], L, true, 38, 0).earth).toEqual([L - 100, L]);
    // Без перекрёстков — как раньше, от начала заполнения.
    expect(stageLayout([50, 10, 0], L, false, 0, 0).earth).toEqual([0, 50]);
    expect(stageLayout([0, 0, 0], L, false, 0, 0).earth).toBeNull();
  });

  it('у начала заполнения этап на площадке — как только начат, у дальнего конца — когда дошёл до неё', () => {
    expect(stageLayout([0, 0, 0], L, false, 38, 20).reach).toEqual({ a: -1, b: -1 });
    expect(stageLayout([10, 0, 0], L, false, 38, 20).reach).toEqual({ a: 0, b: -1 });
    expect(stageLayout([60, 20, 0], L, false, 38, 20).reach).toEqual({ a: 1, b: -1 });
    expect(stageLayout([100, 60, 20], L, false, 38, 20).reach).toEqual({ a: 2, b: -1 });
    // Отсыпка дошла до площадки у b (L − 20), покрытие — ещё нет.
    expect(stageLayout([L - 20, L - 60, L - 100], L, false, 38, 20).reach).toEqual({ a: 2, b: 0 });
    expect(stageLayout([L, L, L], L, false, 38, 20).reach).toEqual({ a: 2, b: 2 });
    // От конца b — зеркально: начало — у b, дальний конец — a со своей площадкой.
    expect(stageLayout([10, 0, 0], L, true, 38, 20).reach).toEqual({ a: -1, b: 0 });
    expect(stageLayout([L - 38, L - 78, L - 118], L, true, 38, 20).reach).toEqual({ a: 0, b: 2 });
  });
});
