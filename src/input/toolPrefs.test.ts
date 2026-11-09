import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { Camera } from '../render/camera';
import { Controller } from './controller';
import {
  defaultToolPrefs,
  isFirstGame,
  loadToolPrefs,
  parseToolPrefs,
  rememberTools,
  serializeToolPrefs,
  TOOL_PREFS_KEY,
  type ToolPrefs,
  toolPrefsWriter,
} from './toolPrefs';

/** Как у нового Controller. */
const DEFAULTS: ToolPrefs = {
  tool: 'select',
  roadMode: 'build',
  presetId: 'road',
  spec: { cls: 'highway', lanesF: 1, lanesB: 1 },
  drawMode: 'arc',
  project: { road: false, rail: false },
  railMode: 'track',
  railTracks: 1,
  signalOneWay: false,
  junctionMode: 'ring',
  templateKind: 'diamond',
  ring: { lanes: 1, size: 'small' },
  stationMode: 'cargo',
  stationTracks: 2,
  stationLength: 150,
  bulldozeMode: 'point',
  terrainMode: 'raise',
  brushSize: 'medium',
};

/** Всё не по умолчанию. */
const CHOSEN: ToolPrefs = {
  tool: 'road',
  roadMode: 'move',
  presetId: 'avenue',
  spec: { cls: 'avenue', lanesF: 2, lanesB: 2, limit: 60 },
  drawMode: 'curve',
  project: { road: true, rail: false },
  railMode: 'signal',
  railTracks: 2,
  signalOneWay: true,
  junctionMode: 'template',
  templateKind: 'clover',
  ring: { lanes: 2, size: 'large' },
  stationMode: 'stop',
  stationTracks: 3,
  stationLength: 250,
  bulldozeMode: 'area',
  terrainMode: 'flatten',
  brushSize: 'large',
};

/** Хранилище браузера — в памяти; broken — любое обращение бросает (приватный режим, переполнение). */
function memoryStorage(broken = false) {
  const data = new Map<string, string>();
  let writes = 0;
  return {
    data,
    writes: () => writes,
    getItem: (k: string) => {
      if (broken) throw new Error('нет доступа');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('переполнено');
      writes++;
      data.set(k, v);
    },
  };
}

describe('Запомненный инструмент: разбор из хранилища', () => {
  it('записанное читается обратно как было', () => {
    expect(parseToolPrefs(serializeToolPrefs(CHOSEN), DEFAULTS)).toEqual(CHOSEN);
  });

  it('ничего не записано, не JSON или не объект — всё по умолчанию', () => {
    for (const raw of [null, '', '{', 'null', '42', '"road"', '[1,2]']) expect(parseToolPrefs(raw, DEFAULTS)).toEqual(DEFAULTS);
  });

  it('неизвестный инструмент — «Выбор», остальное запомненное остаётся', () => {
    const p = parseToolPrefs(JSON.stringify({ ...CHOSEN, tool: 'teleport' }), DEFAULTS);
    expect(p.tool).toBe('select');
    expect(p.roadMode).toBe('move');
    expect(p.brushSize).toBe('large');
  });

  it('каждое испорченное поле — по умолчанию, не трогая соседей', () => {
    const raw = JSON.stringify({
      ...CHOSEN,
      roadMode: 'fly',
      drawMode: 7,
      project: { road: 'yes', rail: true },
      railTracks: 3,
      signalOneWay: 1,
      ring: { lanes: 9, size: 'large' },
      stationTracks: 2.5,
      stationLength: 175,
      bulldozeMode: null,
    });
    const p = parseToolPrefs(raw, DEFAULTS);
    expect(p).toEqual({
      ...CHOSEN,
      roadMode: 'build',
      drawMode: 'arc',
      project: { road: false, rail: true },
      railTracks: 1,
      signalOneWay: false,
      ring: { lanes: 1, size: 'large' },
      stationTracks: 2,
      stationLength: 150,
      bulldozeMode: 'point',
    });
  });

  it('станция: число путей и длина платформ — только в допустимых границах', () => {
    expect(parseToolPrefs(JSON.stringify({ stationTracks: 9, stationLength: 1000 }), DEFAULTS)).toMatchObject({ stationTracks: 2, stationLength: 150 });
    expect(parseToolPrefs(JSON.stringify({ stationTracks: 4, stationLength: 400 }), DEFAULTS)).toMatchObject({ stationTracks: 4, stationLength: 400 });
  });

  describe('тип дороги', () => {
    it('свои полосы (тип пустой) запоминаются вместе с дорогой', () => {
      const spec = { cls: 'street', lanesF: 3, lanesB: 1 };
      expect(parseToolPrefs(JSON.stringify({ presetId: '', spec }), DEFAULTS)).toMatchObject({ presetId: '', spec });
    });

    it('испорченная дорога у известного типа — дорога этого типа', () => {
      for (const spec of [null, { cls: 'rail', lanesF: 1, lanesB: 0 }, { cls: 'street', lanesF: 0, lanesB: 2 }, { cls: 'street', lanesF: 1, lanesB: 5 }]) {
        expect(parseToolPrefs(JSON.stringify({ presetId: 'avenue', spec }), DEFAULTS)).toMatchObject({ presetId: 'avenue', spec: { cls: 'avenue', lanesF: 2, lanesB: 2 } });
      }
    });

    it('неизвестный тип или свои полосы без дороги — шоссе по умолчанию', () => {
      for (const data of [{ presetId: 'hyperloop', spec: { cls: 'street', lanesF: 1, lanesB: 1 } }, { presetId: '' }]) {
        expect(parseToolPrefs(JSON.stringify(data), DEFAULTS)).toMatchObject({ presetId: 'road', spec: DEFAULTS.spec });
      }
    });

    it('знак скорости — только из набора знаков', () => {
      const spec = (limit: unknown) => parseToolPrefs(JSON.stringify({ presetId: 'street', spec: { cls: 'street', lanesF: 1, lanesB: 1, limit } }), DEFAULTS).spec;
      expect(spec(40)).toEqual({ cls: 'street', lanesF: 1, lanesB: 1, limit: 40 });
      expect(spec(55)).toEqual({ cls: 'street', lanesF: 1, lanesB: 1 });
    });
  });
});

describe('Запомненный инструмент: хранилище', () => {
  it('пишет под ключом roads.tool и читает обратно', () => {
    const s = memoryStorage();
    toolPrefsWriter(s)(CHOSEN);
    expect([...s.data.keys()]).toEqual([TOOL_PREFS_KEY]);
    expect(TOOL_PREFS_KEY).toBe('roads.tool');
    expect(loadToolPrefs(DEFAULTS, s)).toEqual(CHOSEN);
  });

  it('пишет только когда настройки изменились', () => {
    const s = memoryStorage();
    const write = toolPrefsWriter(s);
    write(CHOSEN);
    write({ ...CHOSEN });
    expect(s.writes()).toBe(1);
    write({ ...CHOSEN, tool: 'terrain' });
    expect(s.writes()).toBe(2);
  });

  it('без хранилища или с недоступным — по умолчанию и без ошибок', () => {
    expect(loadToolPrefs(DEFAULTS, null)).toEqual(DEFAULTS);
    expect(loadToolPrefs(DEFAULTS, memoryStorage(true))).toEqual(DEFAULTS);
    expect(() => toolPrefsWriter(null)(CHOSEN)).not.toThrow();
    expect(() => toolPrefsWriter(memoryStorage(true))(CHOSEN)).not.toThrow();
  });
});

describe('Первая партия: «Дорога» с «Проектом»', () => {
  it('первая — пока настроек инструментов нет и сохранённой партии тоже', () => {
    expect(isFirstGame(memoryStorage(), false)).toBe(true);
    const s = memoryStorage();
    toolPrefsWriter(s)(DEFAULTS);
    expect(isFirstGame(s, false)).toBe(false);
    // Игрок с прошлых версий: настройки тогда не запоминались, но партия сохранена.
    expect(isFirstGame(memoryStorage(), true)).toBe(false);
  });

  it('без хранилища — не первая: выключенный «Проект» не запомнить, навязывать его каждый раз нельзя', () => {
    expect(isFirstGame(null, false)).toBe(false);
    expect(isFirstGame(memoryStorage(true), false)).toBe(false);
  });

  it('в первой партии по умолчанию включён «Проект» дороги, остальное — как у нового инструмента', () => {
    expect(defaultToolPrefs(DEFAULTS, true)).toEqual({ ...DEFAULTS, project: { road: true, rail: false } });
    expect(defaultToolPrefs(DEFAULTS, false)).toEqual(DEFAULTS);
  });

  it('запомненное важнее: выключенный «Проект» остаётся выключенным', () => {
    const raw = serializeToolPrefs({ ...DEFAULTS, project: { road: false, rail: false } });
    expect(parseToolPrefs(raw, defaultToolPrefs(DEFAULTS, true)).project.road).toBe(false);
  });

  describe('в игре (Controller)', () => {
    type Handler = (e: unknown) => void;
    /** Подписки на события — вместо окна и холста (тесты идут без браузера). */
    class Events {
      addEventListener(_type: string, _h: Handler): void {}
    }
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, input: g.HTMLInputElement };
    beforeAll(() => {
      g.window = new Events();
      g.HTMLInputElement = class {};
    });
    afterAll(() => {
      g.window = saved.window;
      g.HTMLInputElement = saved.input;
    });

    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    /** Загрузка страницы: новый Controller и запомненные инструменты из того же хранилища. */
    const load = (storage: ReturnType<typeof memoryStorage> | null, played = false): Controller => {
      const c = new Controller(new Events() as unknown as HTMLCanvasElement, new Camera(), () => game);
      rememberTools(c, { storage, played });
      return c;
    };

    it('новичок: «Дорога → Строить» — сразу проект; выключил сам — после перезагрузки выключен', () => {
      const s = memoryStorage();
      const first = load(s);
      first.setTool('road');
      expect(first.projectMode).toBe(true);
      first.toggleProject();
      expect(first.projectMode).toBe(false);

      const again = load(s);
      again.setTool('road');
      expect(again.projectMode).toBe(false);
    });

    it('новичок, ничего не трогавший, после перезагрузки — с «Проектом»: выбор по умолчанию уже записан', () => {
      const s = memoryStorage();
      load(s);
      expect(s.data.has(TOOL_PREFS_KEY)).toBe(true);
      const again = load(s);
      again.setTool('road');
      expect(again.projectMode).toBe(true);
    });

    it('не первая партия (сохранение без настроек) и без хранилища — «Проект» выключен, как раньше', () => {
      for (const c of [load(memoryStorage(), true), load(null)]) {
        c.setTool('road');
        expect(c.projectMode).toBe(false);
      }
    });
  });
});
