import { describe, expect, it } from 'vitest';
import { dropEffectFor, isNodeDoubleClick } from './controller';

describe('«Двигать»: двойной клик по узлу — излом ↔ гладкий', () => {
  it('второй клик подряд по тому же узлу — двойной; по дороге, где узел встал первым кликом, — нет', () => {
    expect(isNodeDoubleClick({ node: 7, at: 1000 }, 7, 2, 1250)).toBe(true);
    // Первый клик был по дороге (узел только что встал) — прежнего клика по узлу нет.
    expect(isNodeDoubleClick(null, 7, 2, 1250)).toBe(false);
    // Другой узел, одиночный клик или слишком долго — не двойной.
    expect(isNodeDoubleClick({ node: 3, at: 1000 }, 7, 2, 1250)).toBe(false);
    expect(isNodeDoubleClick({ node: 7, at: 1000 }, 7, 1, 1250)).toBe(false);
    expect(isNodeDoubleClick({ node: 7, at: 1000 }, 7, 2, 1800)).toBe(false);
  });
});

describe('Знак скорости отпускают тем действием, что разрешено', () => {
  it('без клавиш — копировать; с Cmd на macOS — переместить, с Ctrl — ссылка', () => {
    expect(dropEffectFor('all')).toBe('copy');
    expect(dropEffectFor('uninitialized')).toBe('copy');
    expect(dropEffectFor('copyMove')).toBe('copy');
    expect(dropEffectFor('move')).toBe('move');
    expect(dropEffectFor('linkMove')).toBe('move');
    expect(dropEffectFor('link')).toBe('link');
  });
});
