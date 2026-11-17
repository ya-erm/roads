import { afterEach, describe, expect, it, vi } from 'vitest';
import { flag, hasStore, readJson, readText, writeJson, writeText } from './store';

/** Хранилище в памяти; broken — любое обращение бросает (запрет, переполнение). */
function memoryStorage(init: Record<string, string> = {}, broken = false): Storage {
  const data = new Map(Object.entries(init));
  const check = () => {
    if (broken) throw new Error('нет доступа');
  };
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (check(), data.get(k) ?? null),
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => (check(), void data.delete(k)),
    setItem: (k, v) => (check(), void data.set(k, String(v))),
  };
}

describe('Хранилище браузера', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('строки, JSON и флажки — пишутся и читаются; null убирает ключ', () => {
    const s = memoryStorage();
    vi.stubGlobal('localStorage', s);
    expect(hasStore()).toBe(true);
    expect(writeText('a', 'x')).toBe(true);
    expect(readText('a')).toBe('x');
    writeText('a', null);
    expect(s.getItem('a')).toBeNull();
    writeJson('j', { k: [1, 2] });
    expect(readJson('j')).toEqual({ k: [1, 2] });
    const f = flag('f', true);
    expect(f.on).toBe(true);
    f.on = false;
    expect(s.getItem('f')).toBe('0');
    expect(flag('f', true).on).toBe(false);
  });

  it('нет хранилища, оно бросает или там не JSON — «ничего», без ошибок; флажок живёт до перезагрузки', () => {
    for (const store of [undefined, memoryStorage({}, true)]) {
      vi.stubGlobal('localStorage', store);
      expect(hasStore()).toBe(false);
      expect(readText('a')).toBeNull();
      expect(writeText('a', 'x')).toBe(false);
      expect(readJson('a')).toBeUndefined();
      const f = flag('f');
      f.on = true;
      expect(f.on).toBe(true);
    }
    vi.stubGlobal('localStorage', memoryStorage({ j: '{' }));
    expect(readJson('j')).toBeUndefined();
  });
});
