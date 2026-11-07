import { describe, expect, it } from 'vitest';
import { archiveEntries, archiveName, ARCHIVE_FILES, reportMeta } from './archive';
import type { ReportInfo } from './report';

const info: ReportInfo = {
  description: '  Автобус встал на перекрёстке  ',
  author: ' Ярослав ',
  at: new Date(2026, 10, 6, 16, 5, 7),
  version: '0.2.5',
  build: 'Bx3k9Q',
  saveVersion: 3,
  date: 'Мар 2001',
  seed: 42,
  screen: { width: 1440, height: 900, dpr: 2 },
  page: 'https://roads.ya-erm.ru/',
  userAgent: 'Chrome',
};

const decode = (d: Uint8Array) => new TextDecoder().decode(d);

describe('Архив отчёта: содержимое', () => {
  it('всё приложено: текст, сведения, снимок, журнал, сохранение', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const entries = archiveEntries({ info, shot: png, journal: '{"k":"stop"}', save: '{"version":3}' });
    expect(entries.map((e) => e.name)).toEqual(['report.md', 'meta.json', 'screenshot.png', 'journal.jsonl', 'save.json']);
    expect(entries[2].data).toBe(png);
    expect(decode(entries[3].data)).toBe('{"k":"stop"}');
    const md = decode(entries[0].data);
    expect(md.startsWith('**От:** Ярослав\n\nАвтобус встал на перекрёстке\n\n')).toBe(true);
    expect(md).toContain('`screenshot.png`');
    expect(md).toContain('журнал партии `journal.jsonl` · сохранение `save.json`');
    expect(md).toContain('версия 0.2.5, сохранение v3 · 1440×900 @2x · 2026-11-06 16:05 UTC');
    const meta = JSON.parse(decode(entries[1].data));
    expect(meta.localTime).toMatch(/^2026-11-06 16:05 UTC/);
    expect(meta).toMatchObject({
      app: 'razvyazka',
      author: 'Ярослав',
      description: 'Автобус встал на перекрёстке',
      game: { version: '0.2.5', build: 'Bx3k9Q', saveVersion: 3, date: 'Мар 2001', seed: 42 },
      screen: { width: 1440, height: 900, dpr: 2 },
      files: ['screenshot.png', 'journal.jsonl', 'save.json'],
    });
    expect(meta.created).toBe(info.at.toISOString());
  });

  it('без снимка и сохранения — их нет ни в архиве, ни в тексте, ни в сведениях', () => {
    const entries = archiveEntries({ info: { ...info, author: '', description: 'Идея: светофор с таймером' }, journal: '' });
    expect(entries.map((e) => e.name)).toEqual(['report.md', 'meta.json', 'journal.jsonl']);
    const md = decode(entries[0].data);
    expect(md).not.toContain('Снимок');
    expect(md).not.toContain('От:');
    expect(md).not.toContain('save.json');
    const meta = JSON.parse(decode(entries[1].data));
    expect(meta.files).toEqual([ARCHIVE_FILES.journal]);
    expect(meta).not.toHaveProperty('author');
    expect(meta.game).not.toHaveProperty('scenario');
  });

  it('место на карте — в сведениях (map) и строкой «Где на карте» в тексте', () => {
    const spot = { camera: { x: 1000, y: 500, zoom: 2 }, view: { x0: 640, y0: 275, x1: 1360, y1: 725 }, area: { x0: 900, y0: 425, x1: 1100, y1: 575 }, source: 'marks' as const };
    const entries = archiveEntries({ info: { ...info, spot }, save: '{"version":3}' });
    expect(JSON.parse(decode(entries[1].data)).map).toEqual(spot);
    expect(decode(entries[0].data)).toContain('**Где на карте:** участок 200 × 150 м, по пометкам');
    expect(reportMeta(info, [])).not.toHaveProperty('map');
  });

  it('сведения о сценарии — если партия сценарная; имя архива — по времени отчёта', () => {
    expect(reportMeta({ ...info, scenario: 'сценарий normal' }, []).game.scenario).toBe('сценарий normal');
    expect(archiveName(info.at)).toBe('razvyazka-bug-2026-11-06-160507.zip');
  });
});
