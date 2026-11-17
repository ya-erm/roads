/**
 * Имя в баг-репорте: поле «Ваше имя» запоминается в браузере (core/store), чтобы не вводить его каждый раз;
 * недоступное хранилище — просто без памяти.
 */
import { readText, writeText } from '../core/store';

export const AUTHOR_KEY = 'roads.bugReportName';
/** Столько символов имени принимает публичная отправка доски. */
export const AUTHOR_MAX = 32;

/** Имя без лишних пробелов и не длиннее AUTHOR_MAX. */
export function cleanAuthor(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX).trim();
}

export function loadAuthor(): string {
  return cleanAuthor(readText(AUTHOR_KEY) ?? '');
}

/** Запоминает имя; пустое — забывает. */
export function saveAuthor(name: string): void {
  writeText(AUTHOR_KEY, cleanAuthor(name) || null);
}
