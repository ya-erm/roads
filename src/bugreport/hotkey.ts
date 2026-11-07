/**
 * Горячая клавиша баг-репорта: снимок, когда мышь занята — курсор над объектом, тянется дорога, открыт предпросмотр.
 * Две клавиши: F8 (на клавиатурах Mac без Fn это «Пауза» медиаплеера) и Ctrl/Cmd+Shift+B — она есть везде.
 * Игра этих клавиш не занимает (одиночные буквы и цифры у неё, сочетания с Cmd/Ctrl — браузеру), а B с Cmd/Ctrl
 * и Shift в браузере — только панель закладок, её нажатие отменяет.
 */

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Нажата клавиша баг-репорта: F8 без Cmd/Ctrl/Alt или Ctrl/Cmd+Shift+B. */
export function isBugHotkey(e: KeyLike): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'F8') return !mod && !e.altKey;
  return e.code === 'KeyB' && mod && e.shiftKey && !e.altKey;
}

/** Клавиши для подсказки — значками: на Mac сочетание значками ⌘⇧, у остальных — Ctrl+Shift. */
export function bugHotkeyLabels(mac: boolean): string[] {
  return ['F8', mac ? '⌘⇧B' : 'Ctrl+Shift+B'];
}

/** Компьютер Apple: сочетание пишется через ⌘. */
export function isMacPlatform(nav: { platform?: string; userAgent?: string }): boolean {
  return /Mac|iPhone|iPad/i.test(nav.platform || nav.userAgent || '');
}
