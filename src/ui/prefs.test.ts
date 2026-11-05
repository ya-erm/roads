import { afterEach, describe, expect, it, vi } from 'vitest';

/** Хранилище как в браузере — в памяти. */
function memoryStorage(init: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(init));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** Модуль настроек заново — как при загрузке страницы с хранилищем store. */
async function load(store: Storage | null = memoryStorage()) {
  vi.resetModules();
  vi.stubGlobal('localStorage', store ?? undefined);
  return { prefs: await import('./prefs'), store };
}

describe('Настройки интерфейса', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('у каждой настройки — название, пояснение и значок; разметка перекрёстков по умолчанию включена', async () => {
    const { prefs } = await load();
    for (const p of prefs.PREFS) {
      expect(p.name.length, p.id).toBeGreaterThan(0);
      expect(p.hint.length, p.id).toBeGreaterThan(0);
      expect(p.icon, p.id).toContain('<svg');
      expect(prefs.prefOn(p.id), p.id).toBe(p.default);
    }
    expect(prefs.prefOn('junctionMarks')).toBe(true);
  });

  it('setPref сохраняет в localStorage roads.prefs и сообщает подписчикам; после перезагрузки — как выбрали', async () => {
    // В прежнем хранилище флагов разметка была выключена (пустой список) — оно не читается.
    const { prefs, store } = await load(memoryStorage({ 'roads.flags': '[]' }));
    expect(prefs.prefOn('junctionMarks')).toBe(true);
    const seen: boolean[] = [];
    const off = prefs.onPrefs(() => seen.push(prefs.prefOn('junctionMarks')));
    prefs.setPref('junctionMarks', false);
    expect(prefs.prefOn('junctionMarks')).toBe(false);
    expect(JSON.parse(store!.getItem('roads.prefs')!)).toEqual({ junctionMarks: false });
    expect(store!.getItem('roads.flags')).toBeNull();
    off();
    prefs.setPref('junctionMarks', true);
    expect(seen).toEqual([false]);
    expect(JSON.parse(store!.getItem('roads.prefs')!)).toEqual({ junctionMarks: true });
    prefs.setPref('junctionMarks', false);
    expect((await load(store)).prefs.prefOn('junctionMarks')).toBe(false);
  });

  it('битое или чужое значение, нет хранилища, хранилище бросает — как по умолчанию', async () => {
    for (const raw of ['{', '[]', '["junctionMarks"]', '{"junctionMarks":"yes"}', 'null', '7']) {
      expect((await load(memoryStorage({ 'roads.prefs': raw }))).prefs.prefOn('junctionMarks'), raw).toBe(true);
    }
    // Незнакомые имена не мешают знакомым.
    expect((await load(memoryStorage({ 'roads.prefs': '{"nope":true,"junctionMarks":false}' }))).prefs.prefOn('junctionMarks')).toBe(false);
    expect((await load(null)).prefs.prefOn('junctionMarks')).toBe(true);
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error('SecurityError');
    };
    broken.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const { prefs } = await load(broken);
    expect(prefs.prefOn('junctionMarks')).toBe(true);
    // Сохранить не вышло — переключить всё равно можно (до перезагрузки).
    prefs.setPref('junctionMarks', false);
    expect(prefs.prefOn('junctionMarks')).toBe(false);
  });

  it('overridePref (тестовая страница) — только эта страница: ничего не сохраняет, игра его не видит; выбор в меню главнее', async () => {
    const { prefs, store } = await load();
    const seen: boolean[] = [];
    prefs.onPrefs(() => seen.push(prefs.prefOn('junctionMarks')));
    prefs.overridePref('junctionMarks', false);
    expect(prefs.prefOn('junctionMarks')).toBe(false);
    prefs.overridePref('junctionMarks', true);
    prefs.overridePref('junctionMarks', false);
    expect(seen).toEqual([false, true, false]);
    expect(store!.getItem('roads.prefs')).toBeNull();
    // Обычная игра в том же браузере — по умолчанию.
    expect((await load(store)).prefs.prefOn('junctionMarks')).toBe(true);
    // Сохранённое игроком переключатель страницы не трогает.
    const saved = memoryStorage({ 'roads.prefs': '{"junctionMarks":true}' });
    const page = (await load(saved)).prefs;
    page.overridePref('junctionMarks', false);
    expect(page.prefOn('junctionMarks')).toBe(false);
    expect(saved.getItem('roads.prefs')).toBe('{"junctionMarks":true}');
    // Переключили в меню на той же странице — сохраняется и снимает временное значение.
    page.setPref('junctionMarks', false);
    page.setPref('junctionMarks', true);
    expect(page.prefOn('junctionMarks')).toBe(true);
  });

  it('выбор в другой вкладке (событие storage) — сразу и здесь', async () => {
    const listeners: ((e: { key: string | null }) => void)[] = [];
    vi.stubGlobal('window', { addEventListener: (_: string, fn: (e: { key: string | null }) => void) => listeners.push(fn) });
    const { prefs, store } = await load();
    prefs.setPref('junctionMarks', false);
    store!.setItem('roads.prefs', '{"junctionMarks":true}');
    const seen: boolean[] = [];
    prefs.onPrefs(() => seen.push(prefs.prefOn('junctionMarks')));
    for (const fn of listeners) fn({ key: 'roads.prefs' });
    expect(seen).toEqual([true]);
  });
});
