import { describe, expect, it } from 'vitest';
import { BUG_REPORT } from '../config';
import {
  attachmentNames,
  batchId,
  boardReport,
  boardUrl,
  buildLabel,
  cutBytes,
  localStamp,
  zoneLabel,
  newReportKey,
  parseReceipt,
  parseUploaded,
  PUBLIC_LIMITS,
  UNTITLED_REPORT,
  submitReport,
  submitUrl,
  reportMarkdown,
  sizeLabel,
  uploadAttachments,
  uploadManifest,
  UploadError,
  type Attachment,
  type ReportInfo,
} from './report';

const files = (): Attachment[] => [
  { kind: 'shot', name: 'a.png', type: 'image/png', data: new Blob([new Uint8Array(10)]) },
  { kind: 'journal', name: 'a-journal.jsonl', type: 'application/x-ndjson', data: new Blob(['{"k":"x"}\n{"k":"y"}']) },
  { kind: 'save', name: 'a-save.json', type: 'application/json', data: new Blob(['{"version":1}']) },
];

/** Подделка fetch: отвечает как загрузчик доски (ответы взяты с настоящего) и запоминает запросы. */
function fakeBoard(fail?: { at: number; status: number; error?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const n = calls.length - 1;
    if (fail && fail.at === n) return new Response(JSON.stringify(fail.error ? { error: fail.error } : {}), { status: fail.status });
    if (url.endsWith('?action=create')) return new Response(JSON.stringify({ batch: 'b-1', files: [] }), { status: 201 });
    const i = Number(new URL(url).searchParams.get('file'));
    const name = ['01-a.webp', '02-a-journal.jsonl.gz', '03-a-save.json.gz'][i];
    return new Response(JSON.stringify({ url: `https://board/images/x/${name}`, size: 100 + i, storedSize: i ? 50 : 100, status: 'complete' }), {
      status: 201,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('Загрузка файлов отчёта на доску', () => {
  it('один пакет: манифест со сжатием картинок и текстов, затем каждый файл байтами, без токена и кук', async () => {
    const board = fakeBoard();
    const progress: string[] = [];
    const out = await uploadAttachments(files(), { fetch: board.fetch, base: 'https://board/', path: '/api/image-upload', onProgress: (d, t) => progress.push(`${d}/${t}`) });
    expect(board.calls.map((c) => c.url)).toEqual([
      'https://board/api/image-upload?action=create',
      'https://board/api/image-upload?batch=b-1&file=0',
      'https://board/api/image-upload?batch=b-1&file=1',
      'https://board/api/image-upload?batch=b-1&file=2',
    ]);
    const manifest = JSON.parse(String(board.calls[0].init.body));
    expect(manifest.files).toEqual([
      { name: 'a.png', size: 10 },
      { name: 'a-journal.jsonl', size: 19 },
      { name: 'a-save.json', size: 13 },
    ]);
    expect(manifest.compression).toMatchObject({ enabled: true, format: 'webp', maxWidth: 0 });
    expect(manifest.textCompression).toEqual({ enabled: true });
    for (const c of board.calls) {
      expect(c.init.credentials).toBe('omit');
      expect(JSON.stringify(c.init.headers)).not.toMatch(/authorization/i);
    }
    expect((board.calls[2].init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect(board.calls[2].init.body).toBeInstanceOf(Blob);
    expect(out).toEqual([
      { kind: 'shot', name: 'a.png', url: 'https://board/images/x/01-a.webp', size: 100 },
      { kind: 'journal', name: 'a-journal.jsonl', url: 'https://board/images/x/02-a-journal.jsonl.gz', size: 101, stored: 50 },
      { kind: 'save', name: 'a-save.json', url: 'https://board/images/x/03-a-save.json.gz', size: 102, stored: 50 },
    ]);
    expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3']);
  });

  it('отказ доски — ошибка с её объяснением; слишком большой файл не отправляется вовсе', async () => {
    const denied = fakeBoard({ at: 0, status: 403, error: 'Доступ с другого сайта запрещён.' });
    await expect(uploadAttachments(files(), { fetch: denied.fetch })).rejects.toThrow('Доступ с другого сайта запрещён.');
    const broken = fakeBoard({ at: 2, status: 500 });
    await expect(uploadAttachments(files(), { fetch: broken.fetch })).rejects.toMatchObject({ status: 500, message: 'Доска ответила 500' });
    const huge = files();
    huge[2].data = { size: BUG_REPORT.maxFileBytes + 1 } as Blob;
    const quiet = fakeBoard();
    await expect(uploadAttachments(huge, { fetch: quiet.fetch })).rejects.toBeInstanceOf(UploadError);
    expect(quiet.calls).toHaveLength(0);
  });

  it('ответы загрузчика: id пакета и ссылка — и во вложенном виде', () => {
    expect(batchId({ batch: 'x' })).toBe('x');
    expect(batchId({ batch: { id: 'y' } })).toBe('y');
    expect(() => batchId({})).toThrow(UploadError);
    expect(parseUploaded({ file: { url: 'u', size: 5, storedSize: 5 } })).toEqual({ url: 'u', size: 5 });
    expect(() => parseUploaded({ status: 'pending' })).toThrow('ссылку');
    expect(uploadManifest([{ name: 'n', size: 1 }], 80).compression.quality).toBe(80);
  });
});

describe('Текст отчёта', () => {
  const info: ReportInfo = {
    description: 'Автобус стоит на перекрёстке\nи не едет',
    author: 'Ярослав',
    at: new Date(2026, 10, 6, 16, 5, 7),
    version: '0.2.5',
    build: 'Bx3k9Q',
    saveVersion: 3,
    date: 'Мар 1963',
    seed: 42,
    scenario: 'сценарий: normal',
    screen: { width: 1440, height: 900, dpr: 2 },
    page: 'https://roads.ya-erm.ru/',
    userAgent: 'Chrome',
  };

  it('с доски: имя, снимок — картинкой, журнал и сохранение — ссылками, окружение — мелко в конце', () => {
    const md = reportMarkdown(info, [
      { kind: 'shot', name: 'a.png', url: 'https://b/1.webp' },
      { kind: 'journal', name: 'j', url: 'https://b/2.jsonl.gz' },
      { kind: 'save', name: 's', url: 'https://b/3.json.gz' },
    ]);
    expect(md.startsWith('**От:** Ярослав\n\nАвтобус стоит на перекрёстке\nи не едет\n\n')).toBe(true);
    expect(md).toContain('![Снимок экрана](<https://b/1.webp>)');
    expect(md).toContain('[журнал партии](<https://b/2.jsonl.gz>) · [сохранение](<https://b/3.json.gz>)');
    expect(md).toContain('Открыть из файла');
    expect(md).not.toContain('приложен');
    // Сведения — обычной строкой в конце: версия игры (не хеш сборки), время с часовым поясом.
    expect(md.split('\n').at(-1)).toBe(
      `Мар 1963 · seed 42 · сценарий: normal · версия 0.2.5, сохранение v3 · 1440×900 @2x · 2026-11-06 16:05 ${zoneLabel(info.at.getTimezoneOffset())} · https://roads.ya-erm.ru/ · Chrome`,
    );
    expect(md).not.toContain('<sub>');
    expect(md).not.toContain('Bx3k9Q');
  });

  it('без доски — имена файлов, которые приложат вручную; без описания — подсказка смотреть снимок', () => {
    const md = reportMarkdown({ ...info, description: '  ', author: ' ', scenario: undefined }, [
      { kind: 'shot', name: 'a.png' },
      { kind: 'journal', name: 'a-journal.jsonl' },
    ]);
    expect(md).toContain('Без описания — смотрите снимок');
    expect(md).not.toContain('От:');
    expect(md).toContain('Снимок экрана: `a.png` (приложен файлом)');
    expect(md).toContain('журнал партии `a-journal.jsonl` (приложены файлами).');
    expect(md).not.toContain('Открыть из файла');
    expect(md).not.toContain('undefined');
  });

  it('без снимка — о снимке ни слова; сборка по адресу модуля', () => {
    const md = reportMarkdown({ ...info, description: '' }, [{ kind: 'save', name: 's.json' }]);
    expect(md).not.toContain('Снимок');
    expect(md).not.toContain('снимок');
    expect(md).toContain('_Без описания._');
    expect(buildLabel('https://roads.ya-erm.ru/assets/index-Bx3k9Q_a.js')).toBe('Bx3k9Q_a');
    expect(buildLabel('http://localhost:4800/src/ui/bugReport.ts')).toBe('dev');
    expect(buildLabel('http://localhost:4800/src/ui/bugReport.ts?t=1730900000')).toBe('dev');
    expect(localStamp(new Date(2026, 0, 2, 3, 4), -60)).toBe('2026-01-02 03:04 UTC+1');
    expect(zoneLabel(0)).toBe('UTC');
    expect(zoneLabel(-180)).toBe('UTC+3');
    expect(zoneLabel(-330)).toBe('UTC+5:30');
    expect(zoneLabel(240)).toBe('UTC−4');
  });

  it('место на карте — строкой после файлов, до сведений; на доске — тоже', () => {
    const spot = { camera: { x: 1000, y: 500, zoom: 2 }, view: { x0: 640, y0: 275, x1: 1360, y1: 725 }, area: { x0: 900, y0: 425, x1: 1100, y1: 575 }, source: 'frame' as const };
    const parts = reportMarkdown({ ...info, spot }, [{ kind: 'save', name: 's', url: 'https://b/3.json.gz' }]).split('\n\n');
    const at = parts.findIndex((p) => p.startsWith('**Где на карте:**'));
    expect(parts[at]).toBe('**Где на карте:** участок 200 × 150 м, отмечен рамкой: x 900…1100, y 425…575 · камера 1000, 500, ×2 · `--area 900,425,1100,575` `--camera 1000,500,2`');
    expect(parts[at - 1]).toMatch(/^\*\*Для воспроизведения:\*\*/);
    expect(at).toBe(parts.length - 2);
    expect(boardReport({ ...info, spot }, [], 'k').description).toContain('`--area 900,425,1100,575`');
    expect(reportMarkdown(info, [])).not.toContain('Где на карте');
  });

  it('имена файлов — латиницей по времени; доска и размеры', () => {
    const names = attachmentNames(new Date(2026, 10, 6, 9, 5, 7));
    expect(names).toEqual({
      shot: 'razvyazka-bug-2026-11-06-090507.png',
      journal: 'razvyazka-bug-2026-11-06-090507-journal.jsonl',
      save: 'razvyazka-bug-2026-11-06-090507-save.json',
    });
    expect(boardUrl()).toBe(`${BUG_REPORT.boardBase}/b/${BUG_REPORT.boardSlug}/tasks/`);
    expect(sizeLabel(900)).toBe('900 Б');
    expect(sizeLabel(12_300)).toBe('12 КБ');
    expect(sizeLabel(1_468_006)).toBe('1,4 МБ');
  });
});

describe('Публичная отправка на доску', () => {
  const info: ReportInfo = {
    description: '  Автобус встал на перекрёстке  \nи не уезжает',
    author: '  Ярослав  ',
    at: new Date(2026, 10, 6, 18, 0, 0),
    version: '0.2.0-dev',
    build: 'dev',
    saveVersion: 3,
    date: 'Мар 2001',
    seed: 7,
    screen: { width: 1440, height: 900, dpr: 1 },
    page: 'https://roads.ya-erm.ru/',
    userAgent: 'Chrome',
  };
  const utf8 = (s: string) => new TextEncoder().encode(s).length;

  it('имя — отдельным полем как есть, названия нет; файлы с доски — ссылками, не загрузившиеся — строкой', () => {
    const r = boardReport(
      info,
      [
        { kind: 'shot', name: 'a.png' },
        { kind: 'journal', name: 'j', url: 'https://b/j.jsonl.gz' },
        { kind: 'save', name: 's' },
      ],
      'razvyazka-bug:k1',
    );
    // Название по описанию придумает агент доски; «Гость: » к имени добавляет сама доска, не игра.
    expect(r).not.toHaveProperty('title');
    expect(r.author).toBe('Ярослав');
    expect(JSON.stringify(r)).not.toContain('Гость');
    expect(r.sourceKey).toBe('razvyazka-bug:k1');
    expect(r.description).not.toContain('От:');
    expect(r.description).toContain('[журнал партии](<https://b/j.jsonl.gz>)');
    expect(r.description).toContain('_Не загрузились на доску: снимок экрана, сохранение._');
    expect(r.description).not.toContain('приложен');
    expect(r.description).not.toContain('a.png');
    // На доску уходят только разрешённые поля.
    expect(Object.keys(r).sort()).toEqual(['author', 'description', 'sourceKey']);
  });

  it('без описания (только снимок) — короткое название, чтобы запрос не был пустым', () => {
    const r = boardReport({ ...info, description: ' \n ' }, [{ kind: 'shot', name: 'a.png', url: 'https://b/1.webp' }], 'k');
    expect(r.title).toBe(UNTITLED_REPORT);
    expect(r.title!.length).toBeLessThanOrEqual(PUBLIC_LIMITS.title);
    expect(r.description).toContain('![Снимок экрана](<https://b/1.webp>)');
  });

  it('пределы доски: имя до 32 символов, без имени — поля нет', () => {
    const r = boardReport({ ...info, author: 'Я'.repeat(50) }, [], 'k');
    expect(r.author).toHaveLength(PUBLIC_LIMITS.author);
    expect(boardReport({ ...info, author: '   ' }, [], 'k')).not.toHaveProperty('author');
  });

  it('огромное описание обрезается: описание ≤ 12 КиБ, весь запрос ≤ 16 КиБ — и с переносами строк', () => {
    for (const text of ['Ж'.repeat(20_000), 'в\n'.repeat(6_000), 'a\n'.repeat(9_000)]) {
      const r = boardReport({ ...info, description: text }, [{ kind: 'journal', name: 'j', url: 'https://b/j' }], 'k');
      expect(utf8(r.description)).toBeLessThanOrEqual(PUBLIC_LIMITS.description);
      expect(utf8(JSON.stringify(r))).toBeLessThanOrEqual(PUBLIC_LIMITS.request);
      expect(r.description).toContain('описание обрезано');
      // Ссылки и окружение не теряются.
      expect(r.description).toContain('[журнал партии](<https://b/j>)');
      expect(r.description).toContain('seed 7');
    }
    expect(cutBytes('ёжик', 5)).toBe('ёж');
    expect(cutBytes('abc', 10)).toBe('abc');
  });

  it('ключ отчёта и адрес — публичный маршрут доски без токена', () => {
    expect(newReportKey(() => 'uuid')).toBe('razvyazka-bug:uuid');
    expect(newReportKey()).not.toBe(newReportKey());
    expect(submitUrl()).toBe(`${BUG_REPORT.boardBase}/api/boards/${BUG_REPORT.boardSlug}/tasks`);
    expect(submitUrl('https://x/', 'my board')).toBe('https://x/api/boards/my%20board/tasks');
  });

  it('отправка: POST без кук и авторизации, ответ — квитанция {id, number, url}', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'task-1', number: 42, url: 'https://board/b/roads/tasks/?task=task-1' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const report = boardReport(info, [], 'k-1');
    const receipt = await submitReport(report, { fetch, url: 'https://board/api/boards/roads/tasks' });
    expect(receipt).toEqual({ id: 'task-1', number: 42, url: 'https://board/b/roads/tasks/?task=task-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('omit');
    expect(JSON.stringify(calls[0].init.headers)).not.toMatch(/authorization/i);
    expect(JSON.parse(String(calls[0].init.body))).toEqual(report);
  });

  it('отказы доски — понятные ошибки: частые отправки (Retry-After), выключено, слишком большой', async () => {
    const reply = (status: number, body: object = {}, headers: Record<string, string> = {}) =>
      (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof globalThis.fetch;
    const report = boardReport(info, [], 'k');
    await expect(submitReport(report, { fetch: reply(429, {}, { 'Retry-After': '30' }) })).rejects.toMatchObject({ status: 429, message: expect.stringContaining('30 с') });
    await expect(submitReport(report, { fetch: reply(401, { error: 'Требуется вход' }) })).rejects.toThrow('Требуется вход');
    await expect(submitReport(report, { fetch: reply(413) })).rejects.toMatchObject({ status: 413 });
    await expect(submitReport(report, { fetch: reply(201, { ok: true }) })).rejects.toThrow('номер задачи');
    expect(parseReceipt({ id: 5 })).toEqual({ id: '5' });
  });
});
