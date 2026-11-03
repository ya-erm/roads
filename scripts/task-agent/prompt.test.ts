import { describe, expect, it } from 'vitest';
import { errorComment, reportComment, type AgentReport } from './prompt';

const report = (outcome: AgentReport['outcome'], summary: string): AgentReport => ({ outcome, summary, screenshots: [], saves: [] });
const shot = { name: '01-after.png', caption: 'Остановка у перекрёстка', url: 'https://boards.test/images/1/01-after.webp' };
const save = { name: 'save.json', caption: 'Перекрёсток у вокзала', url: 'https://boards.test/images/1/save.json' };

describe('комментарий с отчётом', () => {
  it('сделано: суть, снимок с подписью, ссылка на сохранение — и больше ничего', () => {
    const text = reportComment(report('done', '- Автобус больше не стоит на перекрёстке.\n'), [shot], [save]);
    expect(text).toBe(
      [
        '- Автобус больше не стоит на перекрёстке.',
        'Остановка у перекрёстка',
        '![Остановка у перекрёстка](<https://boards.test/images/1/01-after.webp>)',
        'Сохранение: [save.json](<https://boards.test/images/1/save.json>) — Перекрёсток у вокзала',
      ].join('\n\n'),
    );
  });

  it('без вложений — только суть', () => {
    expect(reportComment(report('done', '- Готово.'), [], [])).toBe('- Готово.');
  });

  it('уточнения и неудача помечены одной строкой сверху', () => {
    expect(reportComment(report('needs_info', '- Какой класс дороги?'), [], [])).toBe('**Нужны уточнения**\n\n- Какой класс дороги?');
    expect(reportComment(report('failed', '- Нет сцены с кольцом.'), [], [])).toBe('**Не сделано**\n\n- Нет сцены с кольцом.');
  });

  it('квадратные скобки из подписи не ломают картинку', () => {
    const text = reportComment(report('done', '- Готово.'), [{ ...shot, caption: 'Кольцо [после]' }], []);
    expect(text).toContain('![Кольцо после](<');
  });

  it('ошибка — одной строкой', () => {
    expect(errorComment('превышено время работы (120 мин)', 2)).toBe('**Не сделано:** превышено время работы (120 мин) (попыток: 2)');
  });
});
