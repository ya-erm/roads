import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Game } from '../game/game';
import { Camera } from '../render/camera';
import { Controller } from './controller';
import { defaultToolPrefs, isFirstGame, loadToolPrefs, parseToolPrefs, rememberTools, TOOL_PREFS_KEY, type ToolPrefs, toolPrefsWriter } from './toolPrefs';

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
  terrainMode: 'smooth',
  brushSize: 'large',
};

/** Хранилище браузера — в памяти, вместо localStorage; broken — любое обращение бросает (приватный режим, переполнение). */
function useStorage(broken = false) {
  const data = new Map<string, string>();
  let writes = 0;
  const check = () => {
    if (broken) throw new Error('нет доступа');
  };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (check(), data.get(k) ?? null),
    setItem: (k: string, v: string) => (check(), writes++, void data.set(k, v)),
    removeItem: (k: string) => (check(), void data.delete(k)),
  });
  return { data, writes: () => writes };
}

afterEach(() => vi.unstubAllGlobals());

/** Как запишется в хранилище и прочтётся обратно. */
const roundTrip = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe('Запомненный инструмент: разбор из хранилища', () => {
  it('записанное читается обратно как было', () => {
    expect(parseToolPrefs(roundTrip(CHOSEN), DEFAULTS)).toEqual(CHOSEN);
  });

  it('ничего не записано, не JSON или не объект — всё по умолчанию', () => {
    for (const data of [undefined, null, 42, 'road', [1, 2]]) expect(parseToolPrefs(data, DEFAULTS)).toEqual(DEFAULTS);
  });

  it('неизвестный инструмент — «Выбор», остальное запомненное остаётся', () => {
    const p = parseToolPrefs({ ...CHOSEN, tool: 'teleport' }, DEFAULTS);
    expect(p.tool).toBe('select');
    expect(p.roadMode).toBe('move');
    expect(p.brushSize).toBe('large');
  });

  it('каждое испорченное поле — по умолчанию, не трогая соседей', () => {
    const p = parseToolPrefs(
      {
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
      },
      DEFAULTS,
    );
    expect(p).toEqual({
      ...CHOSEN,
      roadMode: 'build',
      drawMode: 'arc',
      project: { road: false, rail: true },
      railTracks: 1,
      signalOneWay: false,
      ring: DEFAULTS.ring,
      stationTracks: 2,
      stationLength: 150,
      bulldozeMode: 'point',
    });
  });

  it('станция: число путей и длина платформ — только в допустимых границах', () => {
    expect(parseToolPrefs({ stationTracks: 9, stationLength: 1000 }, DEFAULTS)).toMatchObject({ stationTracks: 2, stationLength: 150 });
    expect(parseToolPrefs({ stationTracks: 4, stationLength: 400 }, DEFAULTS)).toMatchObject({ stationTracks: 4, stationLength: 400 });
  });

  it('разобранное — своё: правка не меняет ни запись, ни fallback', () => {
    const p = parseToolPrefs({}, DEFAULTS);
    p.ring.lanes = 3;
    p.spec.lanesF = 4;
    expect(DEFAULTS.ring.lanes).toBe(1);
    expect(DEFAULTS.spec.lanesF).toBe(1);
  });

  describe('тип дороги', () => {
    it('свои полосы (тип пустой) запоминаются вместе с дорогой', () => {
      const spec = { cls: 'street', lanesF: 3, lanesB: 1 };
      expect(parseToolPrefs({ presetId: '', spec }, DEFAULTS)).toMatchObject({ presetId: '', spec });
    });

    it('испорченная дорога у известного типа — дорога этого типа', () => {
      for (const spec of [null, { cls: 'rail', lanesF: 1, lanesB: 0 }, { cls: 'street', lanesF: 0, lanesB: 2 }, { cls: 'street', lanesF: 1, lanesB: 5 }]) {
        expect(parseToolPrefs({ presetId: 'avenue', spec }, DEFAULTS)).toMatchObject({ presetId: 'avenue', spec: { cls: 'avenue', lanesF: 2, lanesB: 2 } });
      }
    });

    it('неизвестный тип или свои полосы без дороги — шоссе по умолчанию', () => {
      for (const data of [{ presetId: 'hyperloop', spec: { cls: 'street', lanesF: 1, lanesB: 1 } }, { presetId: '' }]) {
        expect(parseToolPrefs(data, DEFAULTS)).toMatchObject({ presetId: 'road', spec: DEFAULTS.spec });
      }
    });

    it('знак скорости — только из набора знаков и не быстрее потолка дороги', () => {
      const spec = (limit: unknown) => parseToolPrefs({ presetId: 'street', spec: { cls: 'street', lanesF: 1, lanesB: 1, limit } }, DEFAULTS).spec;
      expect(spec(40)).toEqual({ cls: 'street', lanesF: 1, lanesB: 1, limit: 40 });
      expect(spec(55)).toEqual({ cls: 'street', lanesF: 1, lanesB: 1 });
      expect(spec(120)).toEqual({ cls: 'street', lanesF: 1, lanesB: 1 });
    });
  });
});

describe('Запомненный инструмент: хранилище', () => {
  it('пишет под ключом roads.tool и читает обратно', () => {
    const s = useStorage();
    toolPrefsWriter()(CHOSEN);
    expect([...s.data.keys()]).toEqual([TOOL_PREFS_KEY]);
    expect(TOOL_PREFS_KEY).toBe('roads.tool');
    expect(loadToolPrefs(DEFAULTS)).toEqual(CHOSEN);
  });

  it('пишет только когда настройки изменились', () => {
    const s = useStorage();
    const write = toolPrefsWriter();
    write(CHOSEN);
    write({ ...CHOSEN });
    expect(s.writes()).toBe(1);
    write({ ...CHOSEN, tool: 'terrain' });
    expect(s.writes()).toBe(2);
  });

  it('без хранилища или с недоступным — по умолчанию и без ошибок', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadToolPrefs(DEFAULTS)).toEqual(DEFAULTS);
    expect(() => toolPrefsWriter()(CHOSEN)).not.toThrow();
    useStorage(true);
    expect(loadToolPrefs(DEFAULTS)).toEqual(DEFAULTS);
    expect(() => toolPrefsWriter()(CHOSEN)).not.toThrow();
  });
});

describe('Первая партия: «Дорога» с «Проектом»', () => {
  it('первая — пока настроек инструментов нет', () => {
    useStorage();
    expect(isFirstGame()).toBe(true);
    toolPrefsWriter()(DEFAULTS);
    expect(isFirstGame()).toBe(false);
  });

  it('без хранилища — не первая: выключенный «Проект» не запомнить, навязывать его каждый раз нельзя', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(isFirstGame()).toBe(false);
    useStorage(true);
    expect(isFirstGame()).toBe(false);
  });

  it('в первой партии по умолчанию включён «Проект» дороги, остальное — как у нового инструмента', () => {
    expect(defaultToolPrefs(DEFAULTS, true)).toEqual({ ...DEFAULTS, project: { road: true, rail: false } });
    expect(defaultToolPrefs(DEFAULTS, false)).toEqual(DEFAULTS);
  });

  it('запомненное важнее: выключенный «Проект» остаётся выключенным', () => {
    const data = roundTrip({ ...DEFAULTS, project: { road: false, rail: false } });
    expect(parseToolPrefs(data, defaultToolPrefs(DEFAULTS, true)).project.road).toBe(false);
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
    /** Загрузка страницы: новый Controller и запомненные инструменты из хранилища. */
    const load = (): Controller => {
      const c = new Controller(new Events() as unknown as HTMLCanvasElement, new Camera(), () => game);
      rememberTools(c);
      return c;
    };

    it('новичок: «Дорога → Строить» — сразу проект; выключил сам — после перезагрузки выключен', () => {
      useStorage();
      const first = load();
      first.setTool('road');
      expect(first.projectMode).toBe(true);
      first.toggleProject();
      expect(first.projectMode).toBe(false);

      const again = load();
      again.setTool('road');
      expect(again.projectMode).toBe(false);
    });

    it('новичок, ничего не трогавший, после перезагрузки — с «Проектом»: выбор по умолчанию уже записан', () => {
      const s = useStorage();
      load();
      expect(s.data.has(TOOL_PREFS_KEY)).toBe(true);
      const again = load();
      again.setTool('road');
      expect(again.projectMode).toBe(true);
    });

    it('без хранилища — «Проект» выключен', () => {
      vi.stubGlobal('localStorage', undefined);
      const c = load();
      c.setTool('road');
      expect(c.projectMode).toBe(false);
    });

    it('смена инструмента запоминается подпиской на Controller', () => {
      const s = useStorage();
      const c = load();
      c.setTool('terrain');
      c.setBrushSize('large');
      expect(JSON.parse(s.data.get(TOOL_PREFS_KEY)!)).toMatchObject({ tool: 'terrain', brushSize: 'large' });
    });
  });
});
