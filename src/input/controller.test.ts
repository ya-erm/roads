import { describe, expect, it } from 'vitest';
import { dropEffectFor } from './controller';

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
