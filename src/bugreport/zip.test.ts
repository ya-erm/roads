import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, dosDateTime, zip } from './zip';

/** Простое чтение ZIP по центральному каталогу — чтобы проверить архив независимо от писателя. */
function unzip(buf: Uint8Array): { name: string; method: number; data: Uint8Array; crc: number; flags: number; time: number; date: number }[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = buf.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  expect(p + v.getUint32(end + 12, true)).toBe(end);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    // Локальный заголовок совпадает с каталогом.
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint32(local + 14, true)).toBe(crc);
    expect(v.getUint16(local + 26, true)).toBe(nameLen);
    const start = local + 30 + nameLen + v.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    expect(data.length).toBe(size);
    out.push({ name, method, data, crc, flags, time, date });
    p += 46 + nameLen;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

describe('ZIP-архив отчёта', () => {
  it('CRC-32 — стандартная (проверочное значение «123456789»)', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('дата и время в формате MS-DOS', () => {
    const { time, date } = dosDateTime(new Date(2026, 10, 6, 16, 5, 31));
    expect(time).toBe((16 << 11) | (5 << 5) | 15);
    expect(date).toBe(((2026 - 1980) << 9) | (11 << 5) | 6);
    // Раньше 1980 формат не умеет — берём 1980.
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });

  it('текст жмётся deflate, PNG лежит как есть; имена по-русски, содержимое и CRC сходятся', async () => {
    const journal = text(Array.from({ length: 200 }, (_, i) => `{"m":${i},"k":"stop","note":"рейс"}`).join('\n'));
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);
    const at = new Date(2026, 10, 6, 9, 30, 0);
    const buf = await zip(
      [
        { name: 'журнал.jsonl', data: journal },
        { name: 'screenshot.png', data: png },
        { name: 'empty.txt', data: new Uint8Array() },
      ],
      { at },
    );
    const files = unzip(buf);
    expect(files.map((f) => f.name)).toEqual(['журнал.jsonl', 'screenshot.png', 'empty.txt']);
    expect(files[0].method).toBe(8);
    expect(files[1].method).toBe(0);
    expect(files[2].method).toBe(0);
    expect(files[0].data).toEqual(journal);
    expect(files[1].data).toEqual(png);
    for (const f of files) {
      expect(f.crc).toBe(crc32(f.data));
      expect(f.flags & 0x0800).toBe(0x0800);
      expect(f.date).toBe(dosDateTime(at).date);
    }
    // Сжатый архив заметно меньше исходного журнала.
    expect(buf.length).toBeLessThan(journal.length / 3);
  });

  it('compress: false — всё без сжатия; пустой архив — только конец каталога', async () => {
    const data = text('a'.repeat(1000));
    const [f] = unzip(await zip([{ name: 'a.txt', data }], { compress: false }));
    expect(f.method).toBe(0);
    expect(f.data).toEqual(data);
    const empty = await zip([]);
    expect(empty.length).toBe(22);
    expect(unzip(empty)).toEqual([]);
  });
});
