/**
 * Хранилище браузера (localStorage) для настроек и памяти интерфейса — одно поведение для всех: нет хранилища (тесты в
 * node, запрет, приватный режим) или оно бросает (запрет, переполнение) — чтение даёт «ничего», запись молча не
 * выходит; что игрок выбрал, действует до перезагрузки. Хранилище берётся при каждом обращении (тесты подменяют его).
 * Сохранения партий — не здесь (game/persist.ts).
 */

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Хранилище есть и читается. */
export function hasStore(): boolean {
  try {
    storage()?.getItem('');
    return !!storage();
  } catch {
    return false;
  }
}

/** Строка по ключу; нет её или хранилища — null. */
export function readText(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Записать строку (null — убрать ключ); false — не вышло. */
export function writeText(key: string, value: string | null): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** JSON по ключу; нет его, хранилища или не JSON — undefined. */
export function readJson(key: string): unknown {
  const raw = readText(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Записать JSON; false — не вышло. */
export function writeJson(key: string, value: unknown): boolean {
  return writeText(key, JSON.stringify(value));
}

/** Объект (не массив) из значения JSON; иначе — пустой. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Флажок интерфейса (свёрнуто, открыто…): читается при создании, запись — при каждой смене. */
export interface Flag {
  on: boolean;
}

/** Флажок под ключом key: '1' / '0'; не записан — fallback. */
export function flag(key: string, fallback = false): Flag {
  const raw = readText(key);
  let on = raw === null ? fallback : raw === '1';
  return {
    get on() {
      return on;
    },
    set on(v: boolean) {
      on = v;
      writeText(key, v ? '1' : '0');
    },
  };
}
