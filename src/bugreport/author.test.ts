import { describe, expect, it } from 'vitest';
import { AUTHOR_KEY, AUTHOR_MAX, cleanAuthor, loadAuthor, saveAuthor } from './author';

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('Имя в баг-репорте', () => {
  it('запоминается и читается обратно, без лишних пробелов', () => {
    const s = memory();
    expect(loadAuthor(s)).toBe('');
    saveAuthor(s, '  Ярослав   Ермилов ');
    expect(s.data.get(AUTHOR_KEY)).toBe('Ярослав Ермилов');
    expect(loadAuthor(s)).toBe('Ярослав Ермилов');
  });

  it('пустое имя забывается; длинное обрезается', () => {
    const s = memory();
    saveAuthor(s, 'Аня');
    saveAuthor(s, '   ');
    expect(s.data.has(AUTHOR_KEY)).toBe(false);
    expect(cleanAuthor('я'.repeat(200))).toHaveLength(AUTHOR_MAX);
  });

  it('хранилища нет или оно бросает — без ошибок', () => {
    expect(loadAuthor(null)).toBe('');
    expect(() => saveAuthor(null, 'Аня')).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('закрыто');
      },
      setItem: () => {
        throw new Error('закрыто');
      },
      removeItem: () => {
        throw new Error('закрыто');
      },
    };
    expect(loadAuthor(broken)).toBe('');
    expect(() => saveAuthor(broken, 'Аня')).not.toThrow();
  });
});
