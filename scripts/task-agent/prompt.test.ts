import { describe, expect, it } from 'vitest';
import { errorComment, firstLine, linksIn, parseReport, reportComment, spotSection, type AgentReport } from './prompt';

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

describe('report.json из чата', () => {
  it('принимает отчёт, недостающие списки — пустые, название — без пробелов', () => {
    expect(parseReport('{"outcome":"done","summary":"- Готово.","screenshots":[{"file":"a.png"}],"title":" Подсветка грузовиков "}')).toEqual({
      outcome: 'done',
      summary: '- Готово.',
      screenshots: [{ file: 'a.png', caption: '' }],
      saves: [],
      title: 'Подсветка грузовиков',
    });
  });

  it('не принимает отчёт без итога, сути или с битыми вложениями', () => {
    expect(() => parseReport('{"outcome":"ok","summary":"- Готово."}')).toThrow(/outcome/);
    expect(() => parseReport('{"outcome":"done","summary":"  "}')).toThrow(/summary/);
    expect(() => parseReport('{"outcome":"done","summary":"- Готово.","saves":[{"caption":"x"}]}')).toThrow(/saves/);
    expect(() => parseReport('{"outcome":"done",')).toThrow();
  });
});

describe('где на карте из баг-репорта', () => {
  const line = '**Где на карте:** участок 200 × 150 м, отмечен рамкой: x 900…1100, y 425…575 · камера 1000, 500, ×2 · `--area 900,425,1100,575` `--camera 1000,500,2`';

  it('участок — готовая команда с приложенным сохранением и --area', () => {
    const text = spotSection(`Машины стоят\n\n${line}`, [
      { file: '.task-agent/runs/x/input/01-a.webp', where: 'описание' },
      { file: '.task-agent/runs/x/input/03-a-save.json.gz', where: 'описание' },
    ]);
    expect(text).toContain('## Где на карте');
    expect(text).toContain('участок 200 × 150 м (x 900…1100, y 425…575)');
    expect(text).toContain('npm run shot -- --save .task-agent/runs/x/input/03-a-save.json.gz --area 900,425,1100,575 --speed 0');
  });

  it('схема участка среди вложений — упомянута; сохранение — другой файл, даже если схема раньше', () => {
    const text = spotSection(line, [
      { file: '.task-agent/runs/x/input/02-razvyazka-bug-2026-11-08-021205-area.json.gz', where: 'описание' },
      { file: '.task-agent/runs/x/input/03-razvyazka-bug-2026-11-08-021205-save.json.gz', where: 'описание' },
    ]);
    expect(text).toContain('--save .task-agent/runs/x/input/03-razvyazka-bug-2026-11-08-021205-save.json.gz --area');
    expect(text).toContain('Схема участка');
    expect(text).toContain('`.task-agent/runs/x/input/02-razvyazka-bug-2026-11-08-021205-area.json.gz` (в gzip');
    expect(text).toContain('«Развязки → Шаблон → Открыть шаблоны из файла»');
    expect(spotSection(line, [{ file: 'in/03-a-save.json', where: 'описание' }])).not.toContain('Схема участка');
  });

  it('без участка — камера автора; без строки — ничего', () => {
    expect(spotSection('`--camera 1000,500,2`', [])).toContain('--save <сохранение> --camera 1000,500,2');
    expect(spotSection('Просто идея', [])).toBe('');
  });
});

describe('название-заглушка', () => {
  it('первая строка с текстом: картинка и ссылка в начале описания пропускаются', () => {
    const text = '![image.png](<https://boards.test/images/1/image.webp> =582x131)\nhttps://boards.test/x\nДавай тут при наведении на **график** показывать значение';
    expect(firstLine(text)).toBe('Давай тут при наведении на график показывать значение');
    expect(firstLine('![a](<https://boards.test/a.png>)')).toBe('Задача без описания');
  });
});

describe('ссылки из текста задачи', () => {
  it('картинка, экранированные подчёркивания и точка после ссылки', () => {
    const text = [
      'Не могу удалить полосу',
      '![image.png](<https://boards.test/images/2026-11-04_15-31/image.webp>)',
      'https://boards.test/images/2026-11-04\\_15-32\\_MSK/%D0%9C%D0%BE%D1%8F%20%281%29.json',
      'Ещё вот: https://boards.test/images/a/b.png.',
    ].join('\n');
    expect(linksIn(text)).toEqual([
      'https://boards.test/images/2026-11-04_15-31/image.webp',
      'https://boards.test/images/2026-11-04_15-32_MSK/%D0%9C%D0%BE%D1%8F%20%281%29.json',
      'https://boards.test/images/a/b.png',
    ]);
  });
});
