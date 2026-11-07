import { describe, expect, it } from 'vitest';
import { bugHotkeyLabels, isBugHotkey, isMacPlatform, type KeyLike } from './hotkey';

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe('горячая клавиша баг-репорта', () => {
  it('F8 — и с Shift (зажат для прямой у курсора), но не с Cmd/Ctrl/Alt', () => {
    expect(isBugHotkey(key('F8'))).toBe(true);
    expect(isBugHotkey(key('F8', { shiftKey: true }))).toBe(true);
    expect(isBugHotkey(key('F8', { ctrlKey: true }))).toBe(false);
    expect(isBugHotkey(key('F8', { metaKey: true }))).toBe(false);
    expect(isBugHotkey(key('F8', { altKey: true }))).toBe(false);
  });

  it('Ctrl+Shift+B и Cmd+Shift+B', () => {
    expect(isBugHotkey(key('KeyB', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isBugHotkey(key('KeyB', { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('не перехватывает клавиши игры: B — снос, Ctrl+B, Shift+B, Alt', () => {
    expect(isBugHotkey(key('KeyB'))).toBe(false);
    expect(isBugHotkey(key('KeyB', { shiftKey: true }))).toBe(false);
    expect(isBugHotkey(key('KeyB', { ctrlKey: true }))).toBe(false);
    expect(isBugHotkey(key('KeyB', { metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isBugHotkey(key('F7'))).toBe(false);
    expect(isBugHotkey(key('Digit8'))).toBe(false);
  });

  it('подпись клавиш — по системе', () => {
    expect(bugHotkeyLabels(true)).toEqual(['F8', '⌘⇧B']);
    expect(bugHotkeyLabels(false)).toEqual(['F8', 'Ctrl+Shift+B']);
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);
  });
});
