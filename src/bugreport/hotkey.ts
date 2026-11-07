/**
 * Горячая клавиша баг-репорта: снимок, когда мышь занята — курсор над объектом, тянется дорога, открыт предпросмотр.
 * Две клавиши: «`» («Ё» в русской раскладке — слева от 1, под левой рукой, пока правая на мыши; F8 на MacBook
 * без Fn — медиаклавиша) и Ctrl/Cmd+Shift+B. Игра их не занимает (буквы и цифры инструментов, сочетания
 * с Cmd/Ctrl — браузеру), а B с Cmd/Ctrl и Shift в браузере — только панель закладок, её нажатие отменяет.
 * В поле ввода «`» печатается как символ (см. BugReport.onKey).
 */

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Нажата клавиша баг-репорта: «`» без Cmd/Ctrl/Alt или Ctrl/Cmd+Shift+B. */
export function isBugHotkey(e: KeyLike): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Backquote') return !mod && !e.altKey;
  return e.code === 'KeyB' && mod && e.shiftKey && !e.altKey;
}

/** Клавиши для подсказки — значками: на Mac сочетание значками ⌘⇧, у остальных — Ctrl+Shift. */
export function bugHotkeyLabels(mac: boolean): string[] {
  return ['`', mac ? '⌘⇧B' : 'Ctrl+Shift+B'];
}

/** Компьютер Apple: сочетание пишется через ⌘. */
export function isMacPlatform(nav: { platform?: string; userAgent?: string }): boolean {
  return /Mac|iPhone|iPad/i.test(nav.platform || nav.userAgent || '');
}
