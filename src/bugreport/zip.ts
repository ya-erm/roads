/**
 * ZIP-архив без библиотек — для «скачать отчёт одним файлом». Файлы кладутся как есть (store) или сжатыми
 * deflate через CompressionStream браузера, если так меньше; уже сжатое (PNG, архивы) второй раз не жмётся.
 * Имена — в UTF-8 (флаг 0x0800), ZIP64 не нужен: отчёт — единицы мегабайт.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (как в ZIP и gzip). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Время и дата файла в формате MS-DOS (точность — 2 секунды, годы с 1980). */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Сырой deflate (как внутри ZIP); браузер без CompressionStream — null, файл ляжет несжатым. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Уже сжатые форматы. */
const PACKED = /\.(png|jpe?g|webp|gif|zip|gz)$/i;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Собирает архив; at — время файлов внутри (по умолчанию сейчас), compress: false — всё без сжатия. */
export async function zip(entries: ZipEntry[], opts: { at?: Date; compress?: boolean } = {}): Promise<Uint8Array> {
  const { time, date } = dosDateTime(opts.at ?? new Date());
  const enc = new TextEncoder();
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    let data = e.data;
    let method = 0;
    if (opts.compress !== false && !PACKED.test(e.name)) {
      const packed = await deflateRaw(e.data);
      if (packed && packed.length < e.data.length) {
        data = packed;
        method = 8;
      }
    }
    // Локальный заголовок файла.
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true);
    l.setUint16(8, method, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, e.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    // Запись центрального каталога.
    const cd = new Uint8Array(46 + name.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cd.set(name, 46);
    body.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, offset, true);
  return concat([...body, ...central, end]);
}
