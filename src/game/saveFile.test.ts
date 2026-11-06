import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { saveFileText } from './saveFile';

describe('Файл сохранения', () => {
  const json = JSON.stringify({ version: 3, note: 'Партия — «Мар 1963»' });

  it('обычный JSON читается как есть', async () => {
    expect(await saveFileText(new Blob([json]))).toBe(json);
  });

  it('сжатый gzip (с доски задач) — распаковывается, с кириллицей', async () => {
    expect(await saveFileText(new Blob([gzipSync(Buffer.from(json))]))).toBe(json);
  });

  it('пустой и короткий файл — без ошибок', async () => {
    expect(await saveFileText(new Blob([]))).toBe('');
    expect(await saveFileText(new Blob(['{']))).toBe('{');
  });
});
