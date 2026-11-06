/**
 * Имя в баг-репорте: поле «Ваше имя» запоминается в браузере, чтобы не вводить его каждый раз.
 * Хранилище передаётся снаружи (localStorage или подделка в тестах); недоступное хранилище — просто без памяти.
 */

export const AUTHOR_KEY = 'roads.bugReportName';
export const AUTHOR_MAX = 60;

type Read = Pick<Storage, 'getItem'>;
type Write = Pick<Storage, 'setItem' | 'removeItem'>;

/** Имя без лишних пробелов и не длиннее AUTHOR_MAX. */
export function cleanAuthor(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX).trim();
}

export function loadAuthor(storage: Read | null): string {
  try {
    return cleanAuthor(storage?.getItem(AUTHOR_KEY) ?? '');
  } catch {
    return '';
  }
}

/** Запоминает имя; пустое — забывает. */
export function saveAuthor(storage: Write | null, name: string): void {
  const v = cleanAuthor(name);
  try {
    if (v) storage?.setItem(AUTHOR_KEY, v);
    else storage?.removeItem(AUTHOR_KEY);
  } catch {
    // Хранилище закрыто (приватный режим, запрет) — имя просто не запомнится.
  }
}
