import { describe, expect, it, vi } from 'vitest';
import { add, dist, Vec } from '../core/vec';
import type { Fragment } from '../lanes/fragment';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import {
  addTemplates,
  DEFAULT_TEMPLATE_NAME,
  fragmentToFile,
  hasRail,
  isFragment,
  parseTemplateFile,
  TEMPLATE_FILE_VERSION,
  templateFileName,
  templatesToFile,
  uniqueName,
} from './templates';
import { AVENUE, road, roadPlan } from './testkit';

// Хранилище браузера — в памяти.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const newGame = () => new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });

/** Первое место сетки, где получилось. */
function somewhere(game: Game, tryAt: (p: Vec) => boolean): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 200) {
    for (let x = 400; x < game.terrain.width - 400; x += 200) if (tryAt({ x, y })) return { x, y };
  }
  throw new Error('Нет места');
}

/** Проспект и поперёк него путь с переездом; кусок рамкой ±100 м — и дорога, и путь. */
function crossingFragment(game: Game): { frag: Fragment; at: Vec } {
  const at = somewhere(game, (p) => {
    const rail = { start: { kind: 'free' as const, pos: add(p, { x: 0, y: -160 }), level: 0 }, end: { kind: 'free' as const, pos: add(p, { x: 0, y: 160 }), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
    const ends = [{ free: add(p, { x: -160, y: 0 }) }, { free: add(p, { x: 160, y: 0 }) }] as const;
    if (!game.builder.plan(rail).ok || !roadPlan(game, ...ends, AVENUE).ok) return false;
    game.builder.build(rail);
    return road(game, ...ends, AVENUE);
  });
  expect(game.levelCrossings).toHaveLength(1);
  return { frag: game.copyArea(add(at, { x: -100, y: -100 }), add(at, { x: 100, y: 100 }))!, at };
}

describe('Шаблоны в файл и из файла', { timeout: 60_000 }, () => {
  it('шаблон выгружается в файл и открывается тем же куском — с дорогами и путями; кусок из файла вставляется', () => {
    const game = newGame();
    const { frag, at } = crossingFragment(game);
    expect(frag.corridors).toHaveLength(1);
    expect(hasRail(frag)).toBe(true);
    const text = templatesToFile([{ name: 'Переезд', createdAt: 1, fragment: frag }]);
    expect(JSON.parse(text).version).toBe(TEMPLATE_FILE_VERSION);
    const parsed = parseTemplateFile(text);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.skipped).toBe(0);
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.templates[0].name).toBe('Переезд');
    expect(parsed.templates[0].fragment).toEqual(frag);
    // Кусок из файла встаёт как скопированный: дорога, путь и переезд между ними.
    const q = somewhere(game, (p) => dist(p, at) > 700 && game.pastePlan(parsed.templates[0].fragment, p, 0.3).ok);
    expect(game.paste(parsed.templates[0].fragment, q, 0.3)).toBeNull();
    expect(game.levelCrossings).toHaveLength(2);
  });

  it('старый шаблон без путей открывается как раньше', () => {
    const game = newGame();
    const { frag } = crossingFragment(game);
    const old: Fragment = { nodes: frag.nodes, corridors: frag.corridors, half: frag.half };
    const parsed = parseTemplateFile(templatesToFile([{ name: 'Старый', createdAt: 5, fragment: old }]));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.templates[0].fragment).toEqual(old);
    expect(hasRail(parsed.templates[0].fragment)).toBe(false);
  });

  it('все свои шаблоны — одним файлом; при совпадении имени — суффикс, а не замена', () => {
    const game = newGame();
    const { frag } = crossingFragment(game);
    const first = addTemplates([{ name: 'Ромб', createdAt: 1, fragment: frag }])!;
    const second = addTemplates([{ name: 'Ромб', createdAt: 2, fragment: frag }])!;
    expect(first[0].name).toBe('Ромб');
    expect(second[0].name).toBe('Ромб (2)');
    expect(first[0].id).not.toBe(second[0].id);
    // Выгрузили оба и открыли обратно — оба добавились рядом с прежними.
    const parsed = parseTemplateFile(templatesToFile([...first, ...second]));
    if ('error' in parsed) throw new Error(parsed.error);
    const again = addTemplates(parsed.templates)!;
    expect(again.map((t) => t.name)).toEqual(['Ромб (3)', 'Ромб (2) (2)']);
    expect(uniqueName('Т', ['Т', 'Т (2)'])).toBe('Т (3)');
  });

  it('битый или чужой файл — понятная причина, без исключений', () => {
    const game = newGame();
    const { frag } = crossingFragment(game);
    const file = (templates: unknown, version = TEMPLATE_FILE_VERSION) => JSON.stringify({ kind: 'razvyazka-templates', version, templates });
    const error = (text: string) => {
      const r = parseTemplateFile(text);
      return 'error' in r ? r.error : null;
    };
    expect(error('{ не json')).toBe('Это не файл шаблонов развязок');
    expect(error('null')).toBe('Это не файл шаблонов развязок');
    expect(error('[1, 2]')).toBe('Это не файл шаблонов развязок');
    expect(error(JSON.stringify({ version: 3, settings: {}, roads: {} }))).toMatch(/файл партии/);
    expect(error(file([{ name: 'X', fragment: frag }], TEMPLATE_FILE_VERSION + 1))).toMatch(/новой версии/);
    expect(error(file([]))).toBe('В файле нет шаблонов, которые можно открыть');
    // Ссылка на узел, которого нет; путь не ж/д; кривая без точки.
    const broken: unknown[] = [
      { ...frag, corridors: [{ ...frag.corridors[0], a: 999_999 }] },
      { ...frag, rail: { ...frag.rail!, segs: [{ ...frag.rail!.segs[0], spec: { cls: 'street', lanesF: 1, lanesB: 1 } }] } },
      { ...frag, corridors: [{ ...frag.corridors[0], curve: { p0: { x: 0, y: 0 } } }] },
      { ...frag, half: { x: 0, y: 10 } },
      'кусок',
    ];
    for (const b of broken) expect(isFragment(b)).toBe(false);
    expect(error(file(broken.map((fragment) => ({ name: 'X', fragment }))))).toBe('В файле нет шаблонов, которые можно открыть');
    // Целые шаблоны открываются, битые пропускаются.
    const mixed = parseTemplateFile(file([{ name: 'Целый', fragment: frag }, { name: 'Битый', fragment: broken[0] }, 42]));
    if ('error' in mixed) throw new Error(mixed.error);
    expect(mixed.templates.map((t) => t.name)).toEqual(['Целый']);
    expect(mixed.skipped).toBe(2);
  });

  it('скопированное — сразу файлом: открывается «Открыть из файла» тем же куском и под тем же именем, и вставляется', () => {
    const game = newGame();
    const { frag, at } = crossingFragment(game);
    const file = fragmentToFile('  Переезд: «мой»  ', frag, 7);
    expect(file.fileName).toBe('Переезд «мой».json');
    const parsed = parseTemplateFile(file.text);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed).toEqual({ templates: [{ name: 'Переезд: «мой»', createdAt: 7, fragment: frag }], skipped: 0 });
    // Тот же формат, что у шаблона, скачанного из своих.
    expect(file.text).toBe(templatesToFile([{ name: 'Переезд: «мой»', createdAt: 7, fragment: frag }]));
    // Из файла — в свои и на карту, как скопированный.
    const [added] = addTemplates(parsed.templates)!;
    expect(added.fragment).toEqual(frag);
    const q = somewhere(game, (p) => dist(p, at) > 700 && game.pastePlan(added.fragment, p, 0).ok);
    expect(game.paste(added.fragment, q, 0)).toBeNull();
    expect(game.levelCrossings).toHaveLength(2);
    // Без имени — «Моя развязка».
    const unnamed = fragmentToFile('   ', frag);
    expect(unnamed.fileName).toBe(`${DEFAULT_TEMPLATE_NAME}.json`);
    const back = parseTemplateFile(unnamed.text);
    if ('error' in back) throw new Error(back.error);
    expect(back.templates[0].name).toBe('Моя развязка');
  });

  it('имя файла — по названию шаблона, без знаков, которых не бывает в именах файлов', () => {
    expect(templateFileName('Ромб: «быстрый»/2')).toBe('Ромб «быстрый» 2.json');
    expect(templateFileName('  ')).toBe('Шаблон.json');
  });
});
