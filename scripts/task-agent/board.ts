/**
 * Клиент API доски задач: карточки, комментарии, их совместный текст и публичный загрузчик файлов.
 * Подробное описание API — на самом сервисе досок: <TASKS_BASE_URL>/api/docs.
 */

export type TaskStatus = 'draft' | 'todo' | 'in_progress' | 'review' | 'revision' | 'verified';

export const STATUS_NAMES: Record<TaskStatus, string> = {
  draft: 'Черновик',
  todo: 'Новая',
  in_progress: 'В работе',
  review: 'Нужно проверить',
  revision: 'Доработать',
  verified: 'Проверено',
};

export interface TaskComment {
  id?: string;
  /** Документ с текстом комментария — в него пишется текст. */
  documentId: string;
  author?: string;
  /** Текущий текст комментария (в полной карточке). */
  body?: string;
  sourceKey?: string;
  createdAt?: string;
}

export interface Task {
  id: string;
  title?: string | null;
  status: TaskStatus;
  revision: number;
  author?: string;
  descriptionDocumentId?: string;
  /** Текст описания, если сервер отдаёт его вместе с карточкой. */
  description?: string;
  comments?: TaskComment[];
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardDocument {
  text: string;
  hash: string;
  saved?: boolean;
}

export interface UploadedFile {
  url: string;
  markdown?: string;
  path?: string;
  isImage?: boolean;
}

export class BoardError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Лимит загрузчика на один файл. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Снимки — в WebP: так же сжимает и веб-загрузчик по умолчанию. */
const COMPRESSION = { enabled: true, format: 'webp', quality: 90, maxWidth: 0, retinaScale: 1 };

const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;

export class Board {
  readonly base: string;
  private readonly api: string;
  private readonly token: string;

  constructor(base: string, slug: string, token: string) {
    this.base = base.replace(/\/+$/, '');
    this.api = `${this.base}/api/boards/${encodeURIComponent(slug)}`;
    this.token = token;
  }

  /** Активные карточки (без корзины). */
  async tasks(): Promise<Task[]> {
    const data = await this.request<{ tasks: Task[] }>('GET', '/tasks');
    return data.tasks ?? [];
  }

  /** Полная карточка: описание, все комментарии и история. */
  async task(id: string): Promise<Task> {
    return unwrapTask(await this.request('GET', `/tasks/${encodeURIComponent(id)}`));
  }

  async patchTask(id: string, body: { revision: number; actor: string; status?: TaskStatus; title?: string }): Promise<Task> {
    return unwrapTask(await this.request('PATCH', `/tasks/${encodeURIComponent(id)}`, body));
  }

  /** Создаёт пустой комментарий; текст пишется отдельно в его документ. Ответ — обновлённая карточка. */
  async addComment(id: string, body: { revision: number; author: string; sourceKey: string }): Promise<Task> {
    return unwrapTask(await this.request('POST', `/tasks/${encodeURIComponent(id)}/comments`, body));
  }

  async document(documentId: string): Promise<BoardDocument> {
    return this.request('GET', `/documents/${encodeURIComponent(documentId)}`);
  }

  /** Записывает текст документа; 409 — текст успел измениться после чтения с этим hash. */
  async writeDocument(documentId: string, text: string, expectedHash: string): Promise<BoardDocument> {
    return this.request('PUT', `/documents/${encodeURIComponent(documentId)}`, { text, expectedHash });
  }

  /** Файл с сервиса досок (картинки и файлы из описаний). Чужие адреса не скачиваем. */
  async download(url: string): Promise<Uint8Array> {
    if (!this.isOwnFile(url)) throw new Error(`Не файл доски: ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new BoardError(res.status, `GET ${url}: ${res.status}`);
    const size = Number(res.headers.get('content-length') ?? 0);
    if (size > MAX_FILE_BYTES) throw new Error(`Слишком большой файл: ${url}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_FILE_BYTES) throw new Error(`Слишком большой файл: ${url}`);
    return data;
  }

  /** Публичный файл, загруженный на этот сервис (/images/…). */
  isOwnFile(url: string): boolean {
    try {
      const u = new URL(url);
      return u.origin === new URL(this.base).origin && u.pathname.startsWith('/images/');
    } catch {
      return false;
    }
  }

  /**
   * Загружает файлы одним пакетом через публичный загрузчик (токен доски ему не нужен и не передаётся).
   * Картинки сервер сжимает в WebP, остальные файлы сохраняет как есть. Результаты — в порядке files.
   */
  async upload(files: { name: string; data: Uint8Array }[]): Promise<UploadedFile[]> {
    if (!files.length) return [];
    const endpoint = `${this.base}/api/image-upload`;
    const manifest = { files: files.map((f) => ({ name: f.name, size: f.data.byteLength })), compression: COMPRESSION };
    const created = await fetchJson<{ batch: string }>(`${endpoint}?action=create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    const out: UploadedFile[] = [];
    for (const [index, file] of files.entries()) out.push(await this.uploadOne(endpoint, created.batch, index, file.data));
    return out;
  }

  private async uploadOne(endpoint: string, batch: string, index: number, data: Uint8Array): Promise<UploadedFile> {
    const url = `${endpoint}?batch=${encodeURIComponent(batch)}&file=${index}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Blob([data as Uint8Array<ArrayBuffer>]),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        const json = (await res.json().catch(() => null)) as (UploadedFile & { error?: string }) | null;
        if (res.status === 201 && json?.url) return json;
        lastError = new BoardError(res.status, `Загрузка файла: ${res.status} ${json?.error ?? ''}`.trim());
        const retryable = res.status >= 500 || res.status === 408 || res.status === 409;
        if (!retryable) break;
      } catch (e) {
        lastError = e;
      }
      // Ответ мог потеряться, а файл — сохраниться: спрашиваем состояние пакета.
      const state = await fetchJson<{ files?: (UploadedFile & { status?: string })[] }>(`${endpoint}?batch=${encodeURIComponent(batch)}`).catch(() => null);
      const saved = state?.files?.[index];
      if (saved?.status === 'complete' && saved.url) return saved;
    }
    throw lastError;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new BoardError(res.status, `${method} ${path}: ${res.status} ${errorText(text)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Карточка в ответе — сама по себе или в обёртке {task}. */
function unwrapTask(data: unknown): Task {
  const d = data as Task & { task?: Task };
  return d.task ?? d;
}

function errorText(text: string): string {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text.slice(0, 300);
  }
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new BoardError(res.status, `${init.method ?? 'GET'} ${url}: ${res.status} ${errorText(text)}`);
  return JSON.parse(text) as T;
}
