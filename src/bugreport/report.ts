/**
 * Баг-репорт: файлы отчёта (снимок с пометками, журнал партии, сохранение, схема участка — шаблоном развязки,
 * bugreport/areaTemplate.ts), загрузка их в публичный загрузчик
 * доски задач, текст отчёта в Markdown со ссылками и публичная отправка карточки на доску (внизу файла).
 * Без DOM: fetch передаётся снаружи — в тестах подделка.
 *
 * Загрузчик доски (см. её /api/docs, раздел «Файлы и изображения»): POST ?action=create с манифестом файлов
 * и настройками сжатия → batch; затем каждый файл исходными байтами: POST ?batch=…&file=i → url и markdown.
 * Токен не нужен и не передаётся: игра публичная, токен в её коде увидел бы каждый.
 */

import { BUG_REPORT } from '../config';
import { spotLine, type MapSpot } from './spot';

/** Файлы отчёта; area — дороги и пути участка файлом шаблона развязки (вставляется в любую партию). */
export type AttachKind = 'shot' | 'journal' | 'save' | 'area';

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

/** Ошибка «доска молчит»: запрос оборван по BUG_REPORT.stallMs. */
export function stalled(ms: number): UploadError {
  return new UploadError(`Доска не отвечает дольше ${Math.round(ms / 1000)} с`);
}

/**
 * Запрос не дольше ms: не уложился — сигнал обрывает его, промис отклоняется ошибкой stalled. Таймер — сам по
 * себе, а не только через signal: подделка fetch в тестах (и зависший браузерный запрос) сигнал может не слушать.
 */
export function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(stalled(ms));
      ctl.abort();
    }, ms);
    const stop = () => clearTimeout(timer);
    Promise.resolve()
      .then(() => run(ctl.signal))
      .then(
        (v) => {
          stop();
          resolve(v);
        },
        (e: unknown) => {
          stop();
          reject(e);
        },
      );
  });
}

/** Имена файлов отчёта: латиницей и по времени, чтобы отчёты не путались и не ломались на доске. */
export function attachmentNames(at: Date): Record<AttachKind, string> {
  const stem = reportStem(at);
  return { shot: `${stem}.png`, journal: `${stem}-journal.jsonl`, save: `${stem}-save.json`, area: `${stem}-area.json` };
}

/** Общее начало имён файлов отчёта: «razvyazka-bug-2026-11-06-090507». */
export function reportStem(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `razvyazka-bug-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
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

/**
 * Отправка одного файла (POST байтами) с прогрессом: sent(доля 0…1) — по мере ухода байтов. У fetch прогресса
 * отправки нет, поэтому в браузере — XMLHttpRequest (xhrPost).
 */
export type PostFile = (url: string, body: Blob, sent: (fraction: number) => void) => Promise<Response>;

/**
 * Какую долю полоски файла занимает отправка байтов: остаток — ответ загрузчика (картинку он ещё пережимает
 * в WebP), иначе полоска стояла бы полной, пока файл на самом деле не принят.
 */
export const UPLOAD_SENT_SHARE = 0.9;

export interface UploadOptions {
  fetch: typeof fetch;
  /** Отправка файла с прогрессом; нет — файлы уходят через fetch, полоска прыгает от 0 сразу к 1. */
  post?: PostFile;
  /** Адрес сервиса досок и путь загрузчика (по умолчанию — из BUG_REPORT). */
  base?: string;
  path?: string;
  onProgress?: (done: number, total: number) => void;
  /** Прогресс каждого файла: 0 — пошёл, 1 — загрузчик принял и вернул ссылку. */
  onFile?: (kind: AttachKind, fraction: number) => void;
  /**
   * Сколько ждать ответа на запрос через fetch (создание пакета, файл без post), мс; по умолчанию —
   * BUG_REPORT.stallMs. У post свой счёт — от последнего ушедшего байта (xhrPost).
   */
  stallMs?: number;
}

/** Ответ XMLHttpRequest как Response: дальше он разбирается так же, как ответ fetch. */
export function xhrResponse(status: number, text: string): Response {
  // У 204/205/304 тела быть не может — конструктор Response на нём падает.
  return new Response(status === 204 || status === 205 || status === 304 ? null : text, { status });
}

/**
 * Отправка файла через XMLHttpRequest — ради upload.onprogress. Как у fetch с credentials: 'omit' — без кук
 * (withCredentials выключен); сеть или CORS не пустили — TypeError, как бросил бы fetch.
 *
 * Промис завершается всегда: stallMs без признаков жизни (ни байтов отправки, ни ответа) — запрос обрывается
 * с ошибкой stalled; ошибка внутри обработчика или loadend без load/error — тоже отказ, а не вечное ожидание.
 */
export function xhrPost(Xhr: { new (): XMLHttpRequest } = XMLHttpRequest, stallMs = BUG_REPORT.stallMs): PostFile {
  return (url, body, sent) =>
    new Promise<Response>((resolve, reject) => {
      const xhr = new Xhr();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done();
      };
      const fail = (e: unknown) => settle(() => reject(e));
      // Каждый признак жизни откладывает обрыв: медленная, но идущая загрузка не обрывается.
      const alive = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          fail(stalled(stallMs));
          xhr.abort();
        }, stallMs);
      };
      try {
        xhr.open('POST', url);
        xhr.withCredentials = false;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
          alive();
          const total = e.lengthComputable && e.total > 0 ? e.total : body.size;
          if (total > 0) sent(Math.min(1, e.loaded / total));
        };
        xhr.onprogress = alive;
        xhr.onload = () => {
          try {
            const r = xhrResponse(xhr.status, xhr.responseText);
            settle(() => resolve(r));
          } catch (e) {
            fail(e);
          }
        };
        xhr.onerror = () => fail(new TypeError('Сеть не пустила файл'));
        xhr.ontimeout = () => fail(stalled(stallMs));
        xhr.onabort = () => fail(new TypeError('Загрузка файла прервана'));
        // Конец запроса без load и error (так не должно быть, но тогда промис висел бы вечно).
        xhr.onloadend = () => fail(new TypeError('Загрузка файла оборвалась'));
        alive();
        xhr.send(body);
      } catch (e) {
        fail(e);
      }
    });
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
  const stallMs = opts.stallMs ?? BUG_REPORT.stallMs;
  // Куки доски загрузчику не нужны: он анонимный.
  const created = await withDeadline(stallMs, async (signal) =>
    readJson(
      await opts.fetch(`${api}?action=create`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadManifest(files.map((f) => ({ name: f.name, size: f.data.size })))),
        signal,
      }),
    ),
  );
  const batch = batchId(created);
  const out: Uploaded[] = [];
  opts.onProgress?.(0, files.length);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const url = `${api}?batch=${encodeURIComponent(batch)}&file=${i}`;
    opts.onFile?.(f.kind, 0);
    const post = opts.post;
    const json = post
      ? await readJson(await post(url, f.data, (p) => opts.onFile?.(f.kind, p * UPLOAD_SENT_SHARE)))
      : await withDeadline(stallMs, async (signal) =>
          readJson(
            await opts.fetch(url, {
              method: 'POST',
              credentials: 'omit',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: f.data,
              signal,
            }),
          ),
        );
    out.push({ kind: f.kind, name: f.name, ...parseUploaded(json) });
    opts.onFile?.(f.kind, 1);
    opts.onProgress?.(i + 1, files.length);
  }
  return out;
}

/** Что известно об отчёте, партии и окружении: описание и имя — в начале текста, остальное — мелко в конце. */
export interface ReportInfo {
  description: string;
  /** Кто сообщает — поле «Ваше имя» (может быть пустым). */
  author?: string;
  /** Момент отчёта — когда снят экран и взяты журнал и сохранение. */
  at: Date;
  /** Версия игры (semver, src/version.ts) — в текст отчёта. */
  version: string;
  /** Сборка игры (хеш файла сборки; на локальном сервере — dev) — только в сведения архива. */
  build: string;
  /** Версия формата сохранения. */
  saveVersion: number;
  /** Игровая дата. */
  date: string;
  seed: number;
  /** Сценарий: сложность, если партия сценарная. */
  scenario?: string;
  /** Окно игры в точках экрана и плотность пикселей. */
  screen: { width: number; height: number; dpr: number };
  /** Где на карте снимок: камера и участок, на который жалуются (bugreport/spot.ts). */
  spot?: MapSpot;
  page: string;
  userAgent: string;
}

/** Сборка игры по адресу её модуля: в сборке у файла хеш (index-Bx3k9Q.js), на локальном сервере — dev. */
export function buildLabel(moduleUrl: string): string {
  const m = /-([\w-]{6,})\.js(?:\?.*)?$/.exec(moduleUrl);
  return m ? m[1] : 'dev';
}

/**
 * «2026-11-06 16:05 UTC+1» — местное время с часовым поясом. offset — как у Date.getTimezoneOffset():
 * минуты до UTC (у UTC+1 это −60).
 */
export function localStamp(d: Date, offset = d.getTimezoneOffset()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${zoneLabel(offset)}`;
}

/** Часовой пояс по Date.getTimezoneOffset(): «UTC+3», «UTC+5:30», «UTC−4», «UTC». */
export function zoneLabel(offset: number): string {
  const east = -offset;
  if (!east) return 'UTC';
  const abs = Math.abs(east);
  const m = abs % 60;
  return `UTC${east > 0 ? '+' : '−'}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** «1440×900 @2x». */
export function screenLabel(s: ReportInfo['screen']): string {
  return `${s.width}×${s.height} @${Math.round(s.dpr * 100) / 100}x`;
}

/** Файл в тексте отчёта: на доске — ссылка, нет — имя файла, который приложат вручную. */
export interface ReportFile {
  kind: AttachKind;
  name: string;
  url?: string;
}

const FILE_LABEL: Record<AttachKind, string> = { shot: 'Снимок экрана', journal: 'журнал партии', save: 'сохранение', area: 'схема участка' };

/** Как открыть файлы в игре: сохранение — партией, схему участка — своим шаблоном развязки. */
const HOW_TO: Partial<Record<AttachKind, string>> = {
  save: 'сохранение открывается через «Меню → Загрузить → Открыть из файла»',
  area: 'схема участка — шаблон развязки: «Развязки → Шаблон → Открыть шаблоны из файла», вставляется в любую партию',
};

/**
 * Текст отчёта (Markdown): кто, описание, снимок, файлы для воспроизведения и окружение. Файл без ссылки —
 * «приложен файлом» (текст для ручной отправки и архива); unsent — в карточку на доске, где таких файлов нет:
 * тогда о них одна строка «не загрузились на доску».
 */
export function reportMarkdown(info: ReportInfo, files: ReportFile[], opts: { unsent?: boolean } = {}): string {
  const shot = files.find((f) => f.kind === 'shot');
  const desc = info.description.trim() || (shot ? '_Без описания — смотрите снимок._' : '_Без описания._');
  const author = info.author?.trim();
  const parts = author ? [`**От:** ${author}`, desc] : [desc];
  const missing = opts.unsent ? files.filter((f) => !f.url) : [];
  if (shot?.url) parts.push(`![${FILE_LABEL.shot}](<${shot.url}>)`);
  else if (shot && !opts.unsent) parts.push(`${FILE_LABEL.shot}: \`${shot.name}\` (приложен файлом)`);
  const rest = files.filter((f) => f.kind !== 'shot' && (f.url || !opts.unsent));
  if (rest.length) {
    const list = rest.map((f) => (f.url ? `[${FILE_LABEL[f.kind]}](<${f.url}>)` : `${FILE_LABEL[f.kind]} \`${f.name}\``)).join(' · ');
    const how = rest.flatMap((f) => HOW_TO[f.kind] ?? []);
    const howTo = how.length ? ` — ${how.join('; ')}` : '';
    const local = rest.some((f) => !f.url) ? ' (приложены файлами)' : '';
    parts.push(`**Для воспроизведения:** ${list}${local}${howTo}.`);
  }
  if (info.spot) {
    // Схема участка — и в строке места: дороги именно этой рамки.
    const area = rest.find((f) => f.kind === 'area');
    const ref = area ? ` · ${FILE_LABEL.area}: ${area.url ? `[${area.name}](<${area.url}>)` : `\`${area.name}\``}` : '';
    parts.push(`${spotLine(info.spot)}${ref}`);
  }
  if (missing.length) parts.push(`_Не загрузились на доску: ${missing.map((f) => FILE_LABEL[f.kind].toLowerCase()).join(', ')}._`);
  const env = [
    info.date,
    `seed ${info.seed}`,
    info.scenario,
    `версия ${info.version}, сохранение v${info.saveVersion}`,
    screenLabel(info.screen),
    localStamp(info.at),
    info.page,
    info.userAgent,
  ]
    .filter(Boolean)
    .join(' · ');
  parts.push(env);
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

// ---------- Публичная отправка на доску ----------
//
// Доска (её /api/docs, раздел «Публичная отправка баг-репортов»): POST /api/boards/<slug>/tasks без токена и кук,
// поля title, description (Markdown со ссылками на уже загруженные файлы), author, sourceKey. Ответ 201 —
// квитанция {id, number, url}. Повтор с тем же sourceKey возвращает ту же квитанцию, новой задачи не создаёт.

/** Пределы публичной отправки: название, описание (UTF-8), имя, ключ и весь JSON-запрос. */
export const PUBLIC_LIMITS = { title: 160, description: 12 * 1024, author: 32, sourceKey: 160, request: 16 * 1024 };

/** Что уходит на доску. Название — только у отчёта без описания (иначе его по описанию придумает агент доски). */
export interface BoardReport {
  title?: string;
  description: string;
  author?: string;
  sourceKey: string;
}

/** Квитанция доски: id карточки, её номер и ссылка (открывается по обычным правилам входа на доску). */
export interface Receipt {
  id: string;
  number?: number;
  url?: string;
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** Строка не длиннее max байт UTF-8 — без разрыва символа посередине. */
export function cutBytes(s: string, max: number): string {
  if (utf8(s) <= max) return s;
  let out = '';
  let size = 0;
  for (const ch of s) {
    const n = utf8(ch);
    if (size + n > max) break;
    out += ch;
    size += n;
  }
  return out;
}

/** Ключ одного отчёта: повтор после сбоя сети с ним не создаст вторую карточку. */
export function newReportKey(random: () => string = defaultRandom): string {
  return `razvyazka-bug:${random()}`;
}

function defaultRandom(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Название отчёта, в котором игрок ничего не написал (только снимок): чтобы карточка не была безымянной. */
export const UNTITLED_REPORT = 'Баг-репорт без описания';

/**
 * Отчёт для публичной отправки. Название не передаётся — его по описанию заполнит агент доски; только у отчёта
 * без описания — короткое UNTITLED_REPORT. Имя — отдельным полем, как ввёл игрок: подпись «Гость: имя» у
 * карточки ставит сама доска (её правило для всех публичных отчётов), игра к имени ничего не добавляет.
 * Описание — Markdown с ссылками на загруженные файлы и строкой о незагруженных; длинное обрезается, чтобы
 * уложиться в пределы доски (описание ≤ 12 КиБ, весь запрос ≤ 16 КиБ).
 */
export function boardReport(info: ReportInfo, files: ReportFile[], sourceKey: string): BoardReport {
  const name = info.author?.replace(/\s+/g, ' ').trim().slice(0, PUBLIC_LIMITS.author).trim();
  const head = {
    ...(info.description.trim() ? {} : { title: UNTITLED_REPORT }),
    ...(name ? { author: name } : {}),
    sourceKey: sourceKey.slice(0, PUBLIC_LIMITS.sourceKey),
  };
  let text = info.description;
  let description = '';
  for (let i = 0; i < 5; i++) {
    description = reportMarkdown({ ...info, author: undefined, description: text }, files, { unsent: true });
    const over = Math.max(utf8(description) - PUBLIC_LIMITS.description, utf8(JSON.stringify({ ...head, description })) - (PUBLIC_LIMITS.request - 256));
    if (over <= 0) return { ...head, description };
    text = `${cutBytes(text, Math.max(0, utf8(text) - over - 96))}…\n\n_(описание обрезано)_`;
  }
  return { ...head, description: cutBytes(description, PUBLIC_LIMITS.description / 2) };
}

/** Адрес публичной отправки: POST /api/boards/<slug>/tasks. */
export function submitUrl(base = BUG_REPORT.boardBase, slug = BUG_REPORT.boardSlug): string {
  return `${base.replace(/\/+$/, '')}/api/boards/${encodeURIComponent(slug)}/tasks`;
}

/** Квитанция из ответа: id обязателен, номер и ссылка — если есть. */
export function parseReceipt(json: Json): Receipt {
  const id = json.id;
  if (typeof id !== 'string' && typeof id !== 'number') throw new UploadError('Доска не вернула номер задачи');
  return {
    id: String(id),
    ...(typeof json.number === 'number' ? { number: json.number } : {}),
    ...(typeof json.url === 'string' ? { url: json.url } : {}),
  };
}

/**
 * Создаёт карточку отчёта на доске — без токена и кук. Частые отправки доска ограничивает (429 с Retry-After),
 * выключенная публичная отправка — отказ с её объяснением; сеть недоступна — fetch бросает TypeError; доска
 * молчит дольше stallMs (по умолчанию BUG_REPORT.stallMs) — запрос обрывается ошибкой stalled.
 */
export async function submitReport(report: BoardReport, opts: { fetch: typeof fetch; url?: string; stallMs?: number }): Promise<Receipt> {
  return withDeadline(opts.stallMs ?? BUG_REPORT.stallMs, async (signal) => {
    const r = await opts.fetch(opts.url ?? submitUrl(), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal,
    });
    if (r.status === 429) {
      const wait = Number(r.headers.get('Retry-After'));
      throw new UploadError(wait > 0 ? `слишком много отчётов подряд — попробуйте через ${Math.ceil(wait)} с` : 'слишком много отчётов подряд — попробуйте позже', 429);
    }
    if (r.status === 413) throw new UploadError('отчёт слишком большой', 413);
    return parseReceipt(await readJson(r));
  });
}
