import { describe, expect, it } from 'vitest';
import { BUG_REPORT } from '../config';
import {
  attachmentNames,
  batchId,
  boardUrl,
  buildLabel,
  localStamp,
  parseUploaded,
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
    expect(md.split('\n').at(-1)).toBe(
      '<sub>Мар 1963 · seed 42 · сценарий: normal · сборка Bx3k9Q, сохранение v3 · 1440×900 @2x · 2026-11-06 16:05 · https://roads.ya-erm.ru/ · Chrome</sub>',
    );
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
    expect(localStamp(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04');
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
