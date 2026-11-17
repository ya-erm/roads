import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHOR_KEY, AUTHOR_MAX, cleanAuthor, loadAuthor, saveAuthor } from './author';

/** Хранилище в памяти вместо localStorage. */
function useMemory(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

describe('Имя в баг-репорте', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('запоминается и читается обратно, без лишних пробелов', () => {
    const data = useMemory();
    expect(loadAuthor()).toBe('');
    saveAuthor('  Ярослав   Ермилов ');
    expect(data.get(AUTHOR_KEY)).toBe('Ярослав Ермилов');
    expect(loadAuthor()).toBe('Ярослав Ермилов');
  });

  it('пустое имя забывается; длинное обрезается', () => {
    const data = useMemory();
    saveAuthor('Аня');
    saveAuthor('   ');
    expect(data.has(AUTHOR_KEY)).toBe(false);
    expect(cleanAuthor('я'.repeat(200))).toHaveLength(AUTHOR_MAX);
  });

  it('хранилища нет — без ошибок', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadAuthor()).toBe('');
    expect(() => saveAuthor('Аня')).not.toThrow();
  });
});
