/**
 * Баг-репорт: файлы отчёта (снимок с пометками, журнал партии, сохранение), загрузка их в публичный загрузчик
 * доски задач и текст отчёта в Markdown со ссылками. Без DOM: fetch передаётся снаружи — в тестах подделка.
 *
 * Загрузчик доски (см. её /api/docs, раздел «Файлы и изображения»): POST ?action=create с манифестом файлов
 * и настройками сжатия → batch; затем каждый файл исходными байтами: POST ?batch=…&file=i → url и markdown.
 * Токен не нужен и не передаётся: игра публичная, токен в её коде увидел бы каждый.
 */

import { BUG_REPORT } from '../config';

export type AttachKind = 'shot' | 'journal' | 'save';

/** Файл отчёта. */
export interface Attachment {
  kind: AttachKind;
  name: string;
  type: string;
  data: Blob;
}

/** Файл на доске. */
export interface Uploaded {
  kind: AttachKind;
  name: string;
  url: string;
  /** Исходный размер, байт. */
  size: number;
  /** Сколько занял на доске после сжатия (если сжался). */
  stored?: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Имена файлов отчёта: латиницей и по времени, чтобы отчёты не путались и не ломались на доске. */
export function attachmentNames(at: Date): Record<AttachKind, string> {
  const p = (n: number) => String(n).padStart(2, '0');
  const stem = `razvyazka-bug-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return { shot: `${stem}.png`, journal: `${stem}-journal.jsonl`, save: `${stem}-save.json` };
}

/** Манифест пакета: картинки — в WebP без уменьшения, текстовые файлы (.json, .jsonl) — gzip, если так меньше. */
export function uploadManifest(files: { name: string; size: number }[], quality = BUG_REPORT.imageQuality) {
  return {
    files: files.map((f) => ({ name: f.name, size: f.size })),
    compression: { enabled: true, format: 'webp', quality, maxWidth: 0, retinaScale: 1 },
    textCompression: { enabled: true },
  };
}

type Json = Record<string, unknown>;

/** id пакета из ответа на создание. */
export function batchId(json: Json): string {
  const b = json.batch;
  const id = typeof b === 'string' ? b : b && typeof b === 'object' ? (b as Json).id : json.id;
  if (typeof id !== 'string' && typeof id !== 'number') throw new UploadError('Доска не выдала номер загрузки');
  return String(id);
}

/** Ответ на загрузку файла: публичная ссылка и размеры (ответ может быть и вложен в file). */
export function parseUploaded(json: Json): { url: string; size: number; stored?: number } {
  const f = (json.file && typeof json.file === 'object' ? json.file : json) as Json;
  const url = typeof f.url === 'string' ? f.url : undefined;
  if (!url) throw new UploadError('Доска не вернула ссылку на файл');
  const size = typeof f.size === 'number' ? f.size : 0;
  const stored = typeof f.storedSize === 'number' ? f.storedSize : undefined;
  return stored === undefined || stored === size ? { url, size } : { url, size, stored };
}

async function readJson(r: Response): Promise<Json> {
  let json: Json = {};
  try {
    json = (await r.json()) as Json;
  } catch {
    // Тело не JSON — ниже хватит кода ответа.
  }
  if (!r.ok) throw new UploadError(typeof json.error === 'string' ? json.error : `Доска ответила ${r.status}`, r.status);
  return json;
}

export interface UploadOptions {
  fetch: typeof fetch;
  /** Адрес сервиса досок и путь загрузчика (по умолчанию — из BUG_REPORT). */
  base?: string;
  path?: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Загружает файлы отчёта одним пакетом. Сеть недоступна или доска не пускает с этого сайта — fetch бросает
 * TypeError, отказ доски — UploadError с её объяснением.
 */
export async function uploadAttachments(files: Attachment[], opts: UploadOptions): Promise<Uploaded[]> {
  const base = (opts.base ?? BUG_REPORT.boardBase).replace(/\/+$/, '');
  const api = `${base}${opts.path ?? BUG_REPORT.uploadPath}`;
  const big = files.find((f) => f.data.size > BUG_REPORT.maxFileBytes);
  if (big) throw new UploadError(`Файл ${big.name} больше ${Math.round(BUG_REPORT.maxFileBytes / 2 ** 20)} МБ`);
  // Куки доски загрузчику не нужны: он анонимный.
  const created = await readJson(
    await opts.fetch(`${api}?action=create`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadManifest(files.map((f) => ({ name: f.name, size: f.data.size })))),
    }),
  );
  const batch = batchId(created);
  const out: Uploaded[] = [];
  opts.onProgress?.(0, files.length);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const json = await readJson(
      await opts.fetch(`${api}?batch=${encodeURIComponent(batch)}&file=${i}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f.data,
      }),
    );
    out.push({ kind: f.kind, name: f.name, ...parseUploaded(json) });
    opts.onProgress?.(i + 1, files.length);
  }
  return out;
}

/** Что известно о партии и окружении — последней строкой отчёта. */
export interface ReportInfo {
  description: string;
  /** Игровая дата. */
  date: string;
  seed: number;
  /** Сценарий: сложность и регион, если партия сценарная. */
  scenario?: string;
  /** Окно игры: «1440×900 @2x». */
  screen: string;
  page: string;
  userAgent: string;
}

/** Файл в тексте отчёта: на доске — ссылка, нет — имя файла, который приложат вручную. */
export interface ReportFile {
  kind: AttachKind;
  name: string;
  url?: string;
}

const FILE_LABEL: Record<AttachKind, string> = { shot: 'Снимок экрана', journal: 'журнал партии', save: 'сохранение' };

/** Текст отчёта для карточки задачи (Markdown): описание, снимок, файлы для воспроизведения и окружение. */
export function reportMarkdown(info: ReportInfo, files: ReportFile[]): string {
  const desc = info.description.trim() || '_Без описания — смотрите снимок._';
  const parts = [desc];
  const shot = files.find((f) => f.kind === 'shot');
  if (shot) parts.push(shot.url ? `![${FILE_LABEL.shot}](<${shot.url}>)` : `${FILE_LABEL.shot}: \`${shot.name}\` (приложен файлом)`);
  const rest = files.filter((f) => f.kind !== 'shot');
  if (rest.length) {
    const list = rest.map((f) => (f.url ? `[${FILE_LABEL[f.kind]}](<${f.url}>)` : `${FILE_LABEL[f.kind]} \`${f.name}\``)).join(' · ');
    const howTo = rest.some((f) => f.kind === 'save') ? ' — сохранение открывается через «Меню → Загрузить → Открыть из файла»' : '';
    const local = rest.some((f) => !f.url) ? ' (приложены файлами)' : '';
    parts.push(`**Для воспроизведения:** ${list}${local}${howTo}.`);
  }
  const env = [info.date, `seed ${info.seed}`, info.scenario, info.screen, info.page, info.userAgent].filter(Boolean).join(' · ');
  parts.push(`<sub>${env}</sub>`);
  return parts.join('\n\n');
}

/** Доска задач игры — для кнопки «Открыть доску» (пусто, если доска не задана). */
export function boardUrl(): string {
  return BUG_REPORT.boardSlug ? `${BUG_REPORT.boardBase}/b/${encodeURIComponent(BUG_REPORT.boardSlug)}/tasks/` : '';
}

/** «12 КБ», «1,4 МБ». */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
