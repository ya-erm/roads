import { describe, expect, it } from 'vitest';
import type { ScenarioSettings } from '../scenario/types';
import { BIOME_LIST, BIOMES, biomeForSeed } from '../world/biomes';
import { DEFAULT_SETTINGS, type WorldSettings } from '../world/settings';
import { Rng } from '../core/rng';
import { prepareSettings } from '../scenario/generator';
import { Terrain } from '../world/terrain';
import { biomeRowHtml, DEFAULT_RELIEF, newGameDraft, nextScenarioSettings, rulesHtml, withSeed } from './newGame';
import { scenarioOptionsHtml } from './scenarioUi';

const remembered: ScenarioSettings = { difficulty: 'hard', challenge: true };
const sandbox: WorldSettings = { ...DEFAULT_SETTINGS, seed: 5, towns: 14, money: 1_000_000, biome: 'taiga', biomeBySeed: true };

/** Элементы с data-tip, внутри которых есть ещё элемент с data-tip: их подсказки всплывают разом и накрывают друг друга. */
function nestedTips(html: string): number {
  const stack: boolean[] = [];
  let nested = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, , attrs] = m;
    if (close) {
      stack.pop();
      continue;
    }
    const tip = /\sdata-tip="/.test(attrs);
    if (tip && stack.includes(true)) nested++;
    if (!attrs.trimEnd().endsWith('/')) stack.push(tip);
  }
  return nested;
}

describe('Новая игра: рельеф', () => {
  // Партия первого запуска (main.ts): DEFAULT_SETTINGS без поля relief — по ней мир плоский, как у старых сохранений.
  const firstRun: WorldSettings = { ...DEFAULT_SETTINGS, seed: 884790648 };

  it('сценарий со стартового экрана первого запуска — с холмами, которые подсвечивает окно (баг: был плоский)', () => {
    const d = newGameDraft(firstRun, 'start', { difficulty: 'normal', challenge: false }, 884790648).settings;
    expect(d.relief).toBe('hills');
    // Дальше настройки идут в Game как есть: prepareSettings решает только регион и рельеф не трогает.
    const world = prepareSettings(d);
    expect(world.relief).toBe('hills');
    const terrain = new Terrain(new Rng(world.seed), { ...world, size: 'small' });
    expect(terrain.hasRelief).toBe(true);
    expect(terrain.amplitude).toBeGreaterThan(0);
  });

  it('в черновике рельеф всегда явный: в песочнице и в сценарии, из меню и со старта', () => {
    for (const s of [firstRun, { ...firstRun, scenario: { difficulty: 'easy' as const, challenge: false } }]) {
      for (const from of ['menu', 'start'] as const) expect(newGameDraft(s, from, remembered, 3).settings.relief).toBe(DEFAULT_RELIEF);
    }
  });

  it('выбранный рельеф прошлой партии сохраняется', () => {
    for (const relief of ['plains', 'hills', 'mountains'] as const) {
      for (const s of [{ ...sandbox, relief }, { ...sandbox, relief, scenario: remembered }]) {
        for (const from of ['menu', 'start'] as const) expect(newGameDraft(s, from, remembered, 3).settings.relief).toBe(relief);
      }
    }
  });

  it('«Другой регион» после итогов — с рельефом прошлой партии, без рельефа — с холмами', () => {
    const played: WorldSettings = { ...firstRun, size: 'large', relief: 'mountains', scenario: { difficulty: 'hard', challenge: true, archetype: 'industrial' } };
    const next = nextScenarioSettings(played, 42);
    expect(next.relief).toBe('mountains');
    expect(next.size).toBe('large');
    expect(next.scenario).toEqual({ difficulty: 'hard', challenge: true });
    expect(next.seed).toBe(42);
    expect(next.biome).toBe(biomeForSeed(42));
    expect(nextScenarioSettings({ ...played, relief: undefined }, 42).relief).toBe(DEFAULT_RELIEF);
  });
});

describe('Новая игра: режим по умолчанию', () => {
  it('со стартового экрана — сразу сценарий с прошлым выбором игрока, песочница остаётся прежней', () => {
    const d = newGameDraft(sandbox, 'start', remembered, 77);
    expect(d.settings.scenario).toEqual(remembered);
    expect(d.settings.seed).toBe(77);
    // Переключат на «Песочницу» — города и капитал прежние.
    expect(d.settings.towns).toBe(14);
    expect(d.settings.money).toBe(1_000_000);
    expect(d.scenario).toEqual(remembered);
  });

  it('из меню — режим текущей партии: песочница остаётся песочницей', () => {
    const d = newGameDraft(sandbox, 'menu', remembered, 77);
    expect(d.settings.scenario).toBeUndefined();
    expect(d.settings.seed).toBe(77);
  });

  it('из сценария — снова сценарий: только выбор игрока, регион по seed решится заново', () => {
    const played: WorldSettings = {
      ...DEFAULT_SETTINGS,
      seed: 9,
      towns: 6,
      scenario: { difficulty: 'easy', challenge: false, archetype: 'industrial' },
    };
    for (const from of ['menu', 'start'] as const) {
      const d = newGameDraft(played, from, remembered, 11);
      expect(d.settings.scenario).toEqual({ difficulty: 'easy', challenge: false });
      expect(d.scenario).toEqual({ difficulty: 'easy', challenge: false });
      expect(d.settings.towns).toBe(DEFAULT_SETTINGS.towns);
    }
    const picked = newGameDraft({ ...played, scenario: { difficulty: 'normal', challenge: true, pick: 'logistics' } }, 'menu', remembered, 1);
    expect(picked.settings.scenario).toEqual({ difficulty: 'normal', challenge: true, pick: 'logistics' });
  });

  it('биом — тот, что даёт новый seed, и в песочнице, и в сценарии', () => {
    for (const s of [sandbox, { ...sandbox, biome: 'desert' as const, biomeBySeed: undefined }, { ...sandbox, biome: undefined }]) {
      for (const from of ['menu', 'start'] as const) {
        const d = newGameDraft(s, from, remembered, 404409972).settings;
        expect(d.biome).toBe(biomeForSeed(404409972));
        expect(d.biomeBySeed).toBeUndefined();
      }
    }
  });
});

describe('Новая игра: кубик и биом', () => {
  /** Seed, у которого биом другой, чем у seed. */
  const otherSeed = (seed: number) => {
    let s = seed + 1;
    while (biomeForSeed(s) === biomeForSeed(seed)) s++;
    return s;
  };

  it('новый seed — подсвечен биом нового seed', () => {
    const draft = newGameDraft(sandbox, 'menu', remembered, 5).settings;
    const seed = otherSeed(5);
    const next = withSeed(draft, seed);
    expect(next.seed).toBe(seed);
    expect(next.biome).toBe(biomeForSeed(seed));
    expect(next.biome).not.toBe(draft.biome);
    // Остальное в черновике не меняется.
    expect({ ...next, seed: draft.seed, biome: draft.biome }).toEqual(draft);
  });

  it('биом, выбранный сами, кубик тоже меняет — на биом нового seed', () => {
    const seed = 5;
    const manual = BIOME_LIST.find((b) => b.id !== biomeForSeed(seed) && b.id !== biomeForSeed(otherSeed(seed)))!.id;
    const draft = { ...newGameDraft(sandbox, 'menu', remembered, seed).settings, biome: manual };
    const next = withSeed(draft, otherSeed(seed));
    expect(next.biome).toBe(biomeForSeed(otherSeed(seed)));
    expect(next.biome).not.toBe(manual);
  });

  it('в строке биома подсвечен биом черновика', () => {
    for (const b of BIOME_LIST) {
      const html = biomeRowHtml(b.id);
      expect(html.match(/class="card region active"/g)).toHaveLength(1);
      expect(html).toContain(`class="card region active" data-action="ng-biome" data-id="${b.id}"`);
    }
  });
});

describe('Стартовый экран', () => {
  it('одна кнопка «Начать»: на первом запуске открывает «Новую игру», в созданном мире — запускает время', () => {
    for (const intro of [true, false]) {
      const html = rulesHtml(intro);
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).toContain('>Начать</button>');
      expect(html).toContain(`data-action="${intro ? 'ng-intro' : 'begin'}"`);
      expect(html).not.toContain('сценарий');
    }
  });
});

describe('Новая игра: регион и биом', () => {
  it('«Случайно» вместо «По seed»; какой регион выпал, не пишем', () => {
    const html = scenarioOptionsHtml({ difficulty: 'normal', challenge: false });
    expect(html).toContain('<span class="name">Случайно</span>');
    expect(html).not.toContain('По seed');
    expect(html).not.toContain('Один из пяти регионов');
  });

  it('биом: только пять пейзажей, без «Случайно»; «Луга» вместо «Средней полосы»; под карточками — «Ресурсы»', () => {
    expect(BIOMES.temperate.name).toBe('Луга');
    for (const b of BIOME_LIST) {
      const html = biomeRowHtml(b.id);
      expect(html.match(/data-action="ng-biome"/g)).toHaveLength(BIOME_LIST.length);
      expect(html).toContain('<span class="name">Луга</span>');
      // «Ресурсы» — заголовком в левом столбце, как у остальных строк, а не в строке значков.
      expect(html).toContain('<span class="ng-label">Ресурсы</span>');
      expect(html).not.toMatch(/ng-biome-strip">[^]*Ресурсы/);
      expect(html).not.toContain('Случайно');
      expect(html).not.toContain('По seed');
      expect(html).not.toContain('Средняя полоса');
      expect(html).not.toContain('Этот seed даёт');
      expect(html).not.toContain('🎲');
    }
  });

  it('подсказки значков ресурсов не вложены друг в друга — не накрывают соседние', () => {
    for (const b of BIOME_LIST) {
      const html = biomeRowHtml(b.id);
      expect(html).toContain('data-tip="Сырьё: что здесь добывают"');
      expect(nestedTips(html)).toBe(0);
    }
    // Проверка ловит и вложенные подсказки — как было раньше.
    expect(nestedTips('<span data-tip="Сырьё"><span data-tip="Уголь"><svg><path d="M0"/></svg></span></span>')).toBe(1);
  });
});
